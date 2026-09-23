import { Hono, type Context } from "hono";
import { PROVIDER_KEYS, type HealthResponse, type ProviderKey, type ProviderStatus } from "../shared/providers";
import { MAX_BODY_BYTES } from "../shared/stream-protocol";
import { routeStatus, type WorkerEnv } from "./channels";
import { runTask, SSE_HEADERS, streamSink, type RunTaskParams } from "./run";
import { buildTask, type TaskKind } from "./tasks";

export { TaskJob } from "./jobs";

const app = new Hono<{ Bindings: WorkerEnv }>();

type AppContext = Context<{ Bindings: WorkerEnv }>;

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
 * The one handler behind /api/solve, /api/interpret and /api/judge. The task
 * is built here first so a bad request gets its 400 at once. Then it runs in
 * a TaskJob Durable Object of its own, which carries on when the page goes
 * away and keeps the answer for GET /api/jobs/:id; the job's first event
 * tells the page its id. Without the JOBS binding it runs inline, as it did
 * before jobs existed.
 */
async function handleTask(c: AppContext, kind: TaskKind) {
  const provider = c.req.param("provider") ?? "";
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

// Stop pressed: end the job's model call instead of leaving it running.
app.delete("/api/jobs/:id", (c) => {
  const id = c.req.param("id");
  const jobs = c.env.JOBS;
  if (!jobs || !JOB_ID_PATTERN.test(id)) return c.body(null, 204);
  return jobs.get(jobs.idFromName(id)).fetch("https://job/cancel", { method: "DELETE" });
});

export default app;
