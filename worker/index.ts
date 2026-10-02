import { Hono, type Context } from "hono";
import { PROVIDER_KEYS, type HealthResponse, type ProviderKey, type ProviderStatus } from "../shared/providers";
import { MAX_BODY_BYTES } from "../shared/stream-protocol";
import { routeStatus, type WorkerEnv } from "./channels";
import { runTask, SSE_HEADERS, streamSink, type RunTaskParams } from "./run";
import { buildTask, type TaskKind } from "./tasks";
import { pdfContentOf, pdfDocument, pdfFileName, pdfKey, pdfTitle, printPdf } from "./pdf";

export { TaskJob } from "./jobs";
export { PdfBudget } from "./pdf";

const app = new Hono<{ Bindings: WorkerEnv }>();

type AppContext = Context<{ Bindings: WorkerEnv }>;

/**
 * Caps how many model-calling requests one client IP can start per minute
 * (wrangler.jsonc "ratelimits"; a whole run with every option on is about a
 * dozen). Re-attaching to a job and cancelling one are not counted: they
 * call no model. Keyed by IP because the API has no sign-in yet - the
 * Cloudflare Access version, keyed by user, is parked on the
 * `access-sign-in` branch.
 */
async function rateLimited(
  c: AppContext,
  limiter: RateLimit | undefined = c.env.TASK_LIMITER,
): Promise<Response | null> {
  if (!limiter) return null;
  const { success } = await limiter.limit({ key: c.req.header("cf-connecting-ip") ?? "local" });
  if (success) return null;
  return c.json(
    { error: "Too many requests in the last minute. Wait a minute, then try again." },
    429,
    { "retry-after": "60" },
  );
}

/**
 * Reads a request body as text, stopping as soon as it exceeds `limit`.
 * Returns null when the limit is passed, so an oversized upload is abandoned
 * mid-flight instead of being buffered and parsed in full.
 */
async function readBoundedBody(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

type BodyResult = { body: Record<string, unknown>; raw: string } | { response: Response };

/** Shared preamble for every POST task endpoint: size cap and JSON parse. */
async function readRequest(c: AppContext): Promise<BodyResult> {
  // Cheap early reject when the client declares an oversized body...
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return { response: c.json({ error: "Request body is too large." }, 413) };
  }

  // ...and a real one for when it does not. A chunked request carries no
  // content-length, so the header check alone lets an arbitrarily large body
  // through to the JSON parser.
  const raw = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
  if (raw === null) {
    return { response: c.json({ error: "Request body is too large." }, 413) };
  }

  try {
    return { body: JSON.parse(raw) as Record<string, unknown>, raw };
  } catch {
    return { response: c.json({ error: "Request body must be JSON." }, 400) };
  }
}

/** Runs a task inside this Worker invocation; it dies with the client. */
function startInlineSse(c: AppContext, params: RunTaskParams) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  // Runs beyond this handler's return; the response stream stays open while
  // the provider call is in flight.
  c.executionCtx.waitUntil(runTask(streamSink(writable.getWriter()), params));
  return new Response(readable, { status: 200, headers: SSE_HEADERS });
}

/**
 * The one handler behind /api/solve, /api/interpret, /api/judge, /api/study
 * and /api/ask. The task
 * is built here first so a bad request gets its 400 at once. Then it runs in
 * a TaskJob Durable Object of its own, which carries on when the page goes
 * away and keeps the answer for GET /api/jobs/:id; the job's first event
 * tells the page its id. Without the JOBS binding it runs inline, as it did
 * before jobs existed.
 */
async function handleTask(c: AppContext, kind: TaskKind) {
  const provider = c.req.param("provider") ?? "";
  const limited = await rateLimited(c);
  if (limited) return limited;
  const parsed = await readRequest(c);
  if ("response" in parsed) return parsed.response;

  const built = buildTask(kind, provider, parsed.body, c.env);
  if ("error" in built) return c.json({ error: built.error }, built.status);

  const jobs = c.env.JOBS;
  if (!jobs) return startInlineSse(c, built.params);

  const jobId = crypto.randomUUID();
  const job = jobs.get(jobs.idFromName(jobId));
  const query = new URLSearchParams({ jobId, kind, provider });
  return job.fetch(`https://job/run?${query}`, { method: "POST", body: parsed.raw });
}

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.get("/api/health", (c) => {
  const providers = {} as Record<ProviderKey, ProviderStatus>;
  for (const provider of PROVIDER_KEYS) {
    providers[provider] = routeStatus(provider, c.env);
  }
  return c.json<HealthResponse>({ providers });
});

app.post("/api/solve/:provider", (c) => handleTask(c, "solve"));
app.post("/api/interpret/:provider", (c) => handleTask(c, "interpret"));
app.post("/api/judge/:provider", (c) => handleTask(c, "judge"));
app.post("/api/study/:provider", (c) => handleTask(c, "study"));
app.post("/api/ask/:provider", (c) => handleTask(c, "ask"));

// Re-attach to a job after the connection dropped: the stored result, or
// the rest of a run still in progress. Only well-formed ids reach the
// namespace, so a probe with a made-up id costs nothing.
app.get("/api/jobs/:id", (c) => {
  const id = c.req.param("id");
  const jobs = c.env.JOBS;
  if (!jobs || !JOB_ID_PATTERN.test(id)) {
    return c.json({ error: "This result is no longer available." }, 404);
  }
  return jobs.get(jobs.idFromName(id)).fetch("https://job/attach");
});

// A finished solution, or the verdict's verified answer, as a PDF made by
// the server (worker/pdf.ts): what "Generate PDF" opens. The first request
// renders it - within the per-IP limit and the month's browser-time
// allowance - and keeps it in R2 for good, so the link works after the job's
// answer is gone; later ones are served from the edge cache or from R2.
// `x-pdf-kept` tells the page which: "forever", or "24h" when the bucket is
// missing or full and only the cache has it.
app.get("/api/pdf/:id", async (c) => {
  const id = c.req.param("id");
  const jobs = c.env.JOBS;
  if (!jobs || !JOB_ID_PATTERN.test(id)) {
    return c.json({ error: "This result is no longer available." }, 404);
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/api/pdf/${id}`, c.req.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // Made before: kept in R2.
  const bucket = c.env.PDFS;
  const kept = bucket ? await bucket.get(pdfKey(id)) : null;
  if (kept) {
    const response = new Response(kept.body, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${kept.customMetadata?.fileName || "solution.pdf"}"`,
        "cache-control": "public, max-age=604800",
        "x-pdf-kept": "forever",
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const browser = c.env.BROWSER;
  const budgets = c.env.PDF_BUDGET;
  if (!browser || !budgets) return c.json({ error: "PDFs are not set up on this server." }, 503);
  const limited = await rateLimited(c, c.env.PDF_LIMITER);
  if (limited) return limited;

  const stored = await jobs.get(jobs.idFromName(id)).fetch("https://job/result");
  if (!stored.ok) {
    return c.json({ error: "This result is no longer available - results are kept for 24 hours." }, 404);
  }
  const { terminal, expiresAt } = (await stored.json()) as { terminal: unknown; expiresAt: number };
  const content = pdfContentOf(terminal);
  if (!content) return c.json({ error: "There is no PDF for this result." }, 404);

  const budget = budgets.get(budgets.idFromName("account"));
  if (!(await budget.allowed())) {
    return c.json(
      { error: "This month's PDF allowance is used up; it starts again on the 1st. Print from the browser instead." },
      429,
    );
  }
  const html = await pdfDocument(content);
  const started = Date.now();
  let pdf: Uint8Array;
  try {
    pdf = await printPdf(browser, html);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return c.json({ error: `The PDF could not be made: ${detail}` }, 503);
  } finally {
    c.executionCtx.waitUntil(budget.add(Date.now() - started));
  }

  // Kept for good in R2, while the bucket has room. Awaited: the link has to
  // work once the page says so, even if it is closed at once.
  const fileName = pdfFileName(content);
  let forever = false;
  if (bucket && (await budget.canStore(pdf.byteLength))) {
    try {
      await bucket.put(pdfKey(id), pdf, {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { fileName, title: pdfTitle(content), kind: content.kind, madeAt: new Date().toISOString() },
      });
      forever = true;
      c.executionCtx.waitUntil(budget.addStored(pdf.byteLength));
    } catch {
      // Not stored: still served, and cached for as long as the answer lives.
    }
  }

  // The edge cache keeps it too, so opening the link again costs nothing:
  // a week for one in R2, else as long as the job keeps its answer.
  const maxAge = forever
    ? 604_800
    : Math.max(60, Math.min(86_400, Math.floor((expiresAt - Date.now()) / 1000)));
  const response = new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${fileName}"`,
      "cache-control": `public, max-age=${maxAge}`,
      "x-pdf-kept": forever ? "forever" : "24h",
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// Stop pressed: end the job's model call instead of leaving it running.
app.delete("/api/jobs/:id", (c) => {
  const id = c.req.param("id");
  const jobs = c.env.JOBS;
  if (!jobs || !JOB_ID_PATTERN.test(id)) return c.body(null, 204);
  return jobs.get(jobs.idFromName(id)).fetch("https://job/cancel", { method: "DELETE" });
});

export default app;
