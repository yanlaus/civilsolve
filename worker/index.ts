import { Hono } from "hono";
import {
  interpretationSchema,
  parseInterpretation,
} from "../shared/interpretation";
import { judgementSchema, MAX_JUDGED_SOLUTIONS, parseJudgement } from "../shared/judgement";
import {
  buildInterpretPrompt,
  buildJudgePrompt,
  buildTutorPrompt,
  buildVerifyPrompt,
  INTERPRET_INSTRUCTIONS,
  isEffortKey,
  JUDGE_INSTRUCTIONS,
  SOLVE_INSTRUCTIONS,
  type EffortKey,
} from "../shared/prompt";
import {
  isProviderKey,
  PROVIDER_KEYS,
  type HealthResponse,
  type ProviderKey,
  type ProviderStatus,
} from "../shared/providers";
import { finalizeProviderArtifact, solutionSchema } from "../shared/solution";
import {
  DATA_URL_PATTERN,
  MAX_BODY_BYTES,
  MAX_IMAGES,
  MAX_INTERPRETATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_TEXT,
  MAX_SOLUTION_TEXT,
} from "../shared/stream-protocol";
import { interpretOverride, routeStatus, type WorkerEnv } from "./channels";
import { runTask, type RunTaskParams } from "./run";

const app = new Hono<{ Bindings: WorkerEnv }>();

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

type BodyResult = { body: Record<string, unknown> } | { response: Response };

/** Shared preamble for both POST endpoints: provider, size cap, JSON parse. */
async function readRequest(
  c: {
    req: { param: (name: string) => string; header: (name: string) => string | undefined; raw: Request };
    json: (payload: unknown, status?: 400 | 404 | 413) => Response;
  },
): Promise<{ provider: ProviderKey } & BodyResult> {
  const provider = c.req.param("provider");
  if (!isProviderKey(provider)) {
    return { provider: "chatgpt", response: c.json({ error: "Unknown provider." }, 404) };
  }

  // Cheap early reject when the client declares an oversized body...
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return { provider, response: c.json({ error: "Request body is too large." }, 413) };
  }

  // ...and a real one for when it does not. A chunked request carries no
  // content-length, so the header check alone lets an arbitrarily large body
  // through to the JSON parser.
  const raw = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
  if (raw === null) {
    return { provider, response: c.json({ error: "Request body is too large." }, 413) };
  }

  try {
    return { provider, body: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { provider, response: c.json({ error: "Request body must be JSON." }, 400) };
  }
}

type ImagesResult = { images: string[] } | { error: string };

function readImages(value: unknown, max: number, label: string): ImagesResult {
  const images = Array.isArray(value) ? value : [];
  if (images.length > max) {
    return { error: `Provide at most ${max} ${label}.` };
  }
  for (const image of images) {
    if (typeof image !== "string" || !DATA_URL_PATTERN.test(image)) {
      return { error: `${label} must be JPEG/PNG/WebP/GIF data URLs.` };
    }
  }
  return { images: images as string[] };
}

function readText(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit).trim() : "";
}

function startSse(
  c: { executionCtx: { waitUntil: (promise: Promise<unknown>) => void } },
  params: RunTaskParams,
) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Runs beyond this handler's return; the response stream stays open while
  // the provider call is in flight.
  c.executionCtx.waitUntil(runTask(writer, params));

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

app.get("/api/health", (c) => {
  const providers = {} as Record<ProviderKey, ProviderStatus>;
  for (const provider of PROVIDER_KEYS) {
    providers[provider] = routeStatus(provider, c.env);
  }
  return c.json<HealthResponse>({ providers });
});

app.post("/api/solve/:provider", async (c) => {
  const parsed = await readRequest(c);
  if ("response" in parsed) return parsed.response;
  const { provider, body } = parsed;

  const assignment = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in assignment) return c.json({ error: assignment.error }, 400);
  if (assignment.images.length < 1) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }

  const reference = readImages(
    body.referenceImages,
    MAX_REFERENCE_IMAGES,
    "Lecture-notes images",
  );
  if ("error" in reference) return c.json({ error: reference.error }, 400);

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "medium";
  const interpretation = readText(body.interpretation, MAX_INTERPRETATION_LENGTH);
  const referenceText = readText(body.referenceText, MAX_REFERENCE_TEXT);

  return startSse(c, {
    provider,
    env: c.env,
    effort,
    task: {
      session: crypto.randomUUID(),
      prompt: ({ enforceShape, effort: effective }) =>
        buildTutorPrompt(notes, effective, {
          enforceShape,
          interpretation: interpretation || undefined,
          referenceText: referenceText || undefined,
          hasReferenceImages: reference.images.length > 0,
        }),
      instructions: SOLVE_INSTRUCTIONS,
      schemaName: "civil_solution",
      schema: solutionSchema as unknown as Record<string, unknown>,
      images: assignment.images,
      referenceImages: reference.images,
    },
    finalize: (rawText, { lastAttempt }) => ({
      solution: finalizeProviderArtifact(provider, rawText, { allowIncomplete: lastAttempt }),
    }),
  });
});

app.post("/api/interpret/:provider", async (c) => {
  const parsed = await readRequest(c);
  if ("response" in parsed) return parsed.response;
  const { provider, body } = parsed;

  const assignment = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in assignment) return c.json({ error: assignment.error }, 400);
  if (assignment.images.length < 1) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const mode = body.mode === "verify" ? "verify" : "interpret";
  const requestedEffort: EffortKey | null =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : null;

  let buildPrompt: (options: { enforceShape: boolean }) => string;
  if (mode === "verify") {
    const interpretations = Array.isArray(body.interpretations) ? body.interpretations : [];
    const [a, b] = interpretations;
    if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) {
      return c.json({ error: "Verify mode needs two interpretations." }, 400);
    }
    buildPrompt = (options) =>
      buildVerifyPrompt(
        notes,
        a.slice(0, MAX_INTERPRETATION_LENGTH),
        b.slice(0, MAX_INTERPRETATION_LENGTH),
        options,
      );
  } else {
    buildPrompt = (options) => buildInterpretPrompt(notes, options);
  }

  return startSse(c, {
    provider,
    env: c.env,
    // The interpretation pass pins some providers to routes chosen for it (see interpretOverride).
    routeOverride: interpretOverride(provider, c.env),
    // Readers default to "medium" - they transcribe rather than derive, but
    // a whole exam paper is a lot of diagram to read carefully - and the user
    // can change it. The judge defaults to the strongest level the route
    // supports: it adjudicates two readings against the image, and a misread
    // there poisons every solve that follows. The form sends the readers'
    // level explicitly; this default is for callers that do not.
    effort: requestedEffort ?? (mode === "verify" ? "max" : "medium"),
    task: {
      session: crypto.randomUUID(),
      prompt: buildPrompt,
      instructions: INTERPRET_INSTRUCTIONS,
      schemaName: "civil_interpretation",
      schema: interpretationSchema as unknown as Record<string, unknown>,
      images: assignment.images,
    },
    finalize: (rawText, { lastAttempt }) => ({
      interpretation: parseInterpretation(rawText, provider, { allowIncomplete: lastAttempt }),
    }),
  });
});

// The answer cross-check: grades the selected solvers' solutions against the
// images. Runs on the provider's normal solve route - no override - so the
// judge is whatever the user picked, at the effort the most reliable solves
// used.
app.post("/api/judge/:provider", async (c) => {
  const parsed = await readRequest(c);
  if ("response" in parsed) return parsed.response;
  const { provider, body } = parsed;

  const assignment = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in assignment) return c.json({ error: assignment.error }, 400);
  if (assignment.images.length < 1) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }

  const candidates = Array.isArray(body.solutions) ? body.solutions : [];
  if (
    candidates.length < 2 ||
    candidates.length > MAX_JUDGED_SOLUTIONS ||
    candidates.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return c.json(
      { error: `The cross-check needs between 2 and ${MAX_JUDGED_SOLUTIONS} solutions.` },
      400,
    );
  }
  const solutions = (candidates as string[]).map((entry) => entry.slice(0, MAX_SOLUTION_TEXT));

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const interpretation = readText(body.interpretation, MAX_INTERPRETATION_LENGTH);
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "high";

  return startSse(c, {
    provider,
    env: c.env,
    effort,
    task: {
      session: crypto.randomUUID(),
      prompt: ({ enforceShape }) =>
        buildJudgePrompt(notes, solutions, {
          enforceShape,
          interpretation: interpretation || undefined,
        }),
      instructions: JUDGE_INSTRUCTIONS,
      schemaName: "civil_judgement",
      schema: judgementSchema as unknown as Record<string, unknown>,
      images: assignment.images,
    },
    finalize: (rawText, { lastAttempt }) => ({
      judgement: parseJudgement(rawText, provider, solutions.length, {
        allowIncomplete: lastAttempt,
      }),
    }),
  });
});

export default app;
