import { Hono } from "hono";
import {
  buildInterpretPrompt,
  buildTutorPrompt,
  buildVerifyPrompt,
  INTERPRET_INSTRUCTIONS,
  isEffortKey,
  SOLVE_INSTRUCTIONS,
  type EffortKey,
} from "../shared/prompt";
import {
  interpretationSchema,
  parseInterpretation,
} from "../shared/interpretation";
import {
  finalizeProviderArtifact,
  isProviderKey,
  solutionSchema,
} from "../shared/solution";
import {
  DATA_URL_PATTERN,
  MAX_BODY_BYTES,
  MAX_IMAGES,
  MAX_INTERPRETATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_TEXT,
} from "../shared/stream-protocol";
import { runTask, type RunTaskParams } from "./run";
import type { WorkerEnv } from "./upstream";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/api/health", (c) =>
  c.json({
    poeConfigured: Boolean(c.env.POE_API_KEY?.trim()),
    kimiConfigured: Boolean(c.env.KIMI_API_KEY?.trim()),
    minimaxConfigured: Boolean(c.env.MINIMAX_API_KEY?.trim()),
  }),
);

type ParsedImages = { images: string[] } | { error: string };

function readImages(value: unknown, max: number, label: string): ParsedImages {
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

app.post("/api/solve/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderKey(provider)) {
    return c.json({ error: "Unknown provider." }, 404);
  }

  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "Request body is too large." }, 400);
  }

  let body: {
    images?: unknown;
    notes?: unknown;
    effort?: unknown;
    interpretation?: unknown;
    referenceText?: unknown;
    referenceImages?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON." }, 400);
  }

  const parsed = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }
  if (parsed.images.length < 1) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }

  const parsedReference = readImages(
    body.referenceImages,
    MAX_REFERENCE_IMAGES,
    "Lecture-notes images",
  );
  if ("error" in parsedReference) {
    return c.json({ error: parsedReference.error }, 400);
  }

  const notes = typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_LENGTH) : "";
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "medium";
  const interpretation =
    typeof body.interpretation === "string"
      ? body.interpretation.slice(0, MAX_INTERPRETATION_LENGTH).trim()
      : "";
  const referenceText =
    typeof body.referenceText === "string"
      ? body.referenceText.slice(0, MAX_REFERENCE_TEXT).trim()
      : "";

  return startSse(c, {
    provider,
    env: c.env,
    prompt: buildTutorPrompt(notes, effort, {
      interpretation: interpretation || undefined,
      referenceText: referenceText || undefined,
      hasReferenceImages: parsedReference.images.length > 0,
    }),
    instructions: SOLVE_INSTRUCTIONS,
    images: parsed.images,
    referenceImages: parsedReference.images,
    schemaName: "civil_solution",
    schema: solutionSchema as unknown as Record<string, unknown>,
    finalize: (rawText) => ({ solution: finalizeProviderArtifact(provider, rawText) }),
  });
});

app.post("/api/interpret/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderKey(provider)) {
    return c.json({ error: "Unknown provider." }, 404);
  }

  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "Request body is too large." }, 400);
  }

  let body: {
    mode?: unknown;
    images?: unknown;
    notes?: unknown;
    interpretations?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be JSON." }, 400);
  }

  const mode = body.mode === "verify" ? "verify" : "interpret";

  const parsed = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in parsed) {
    return c.json({ error: parsed.error }, 400);
  }
  if (parsed.images.length < 1) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }

  const notes = typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_LENGTH) : "";

  let prompt: string;
  if (mode === "verify") {
    const interpretations = Array.isArray(body.interpretations) ? body.interpretations : [];
    const [a, b] = interpretations;
    if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) {
      return c.json({ error: "Verify mode needs two interpretations." }, 400);
    }
    prompt = buildVerifyPrompt(
      notes,
      a.slice(0, MAX_INTERPRETATION_LENGTH),
      b.slice(0, MAX_INTERPRETATION_LENGTH),
    );
  } else {
    prompt = buildInterpretPrompt(notes);
  }

  return startSse(c, {
    provider,
    env: c.env,
    prompt,
    instructions: INTERPRET_INSTRUCTIONS,
    images: parsed.images,
    schemaName: "civil_interpretation",
    schema: interpretationSchema as unknown as Record<string, unknown>,
    finalize: (rawText) => ({ interpretation: parseInterpretation(rawText, provider) }),
  });
});

export default app;
