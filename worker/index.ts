import { Hono } from "hono";
import { isEffortKey, type EffortKey } from "../shared/prompt";
import {
  isProviderKey,
  PROVIDER_KEYS,
  type HealthResponse,
  type ProviderKey,
  type ProviderStatus,
} from "../shared/providers";
import {
  DATA_URL_PATTERN,
  MAX_BODY_BYTES,
  MAX_IMAGES,
  MAX_NOTES_LENGTH,
} from "../shared/stream-protocol";
import { routeStatus, type WorkerEnv } from "./channels";
import { runSolve } from "./solve";

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

app.get("/api/health", (c) => {
  const providers = {} as Record<ProviderKey, ProviderStatus>;
  for (const provider of PROVIDER_KEYS) {
    providers[provider] = routeStatus(provider, c.env);
  }
  return c.json<HealthResponse>({ providers });
});

app.post("/api/solve/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderKey(provider)) {
    return c.json({ error: "Unknown provider." }, 404);
  }

  // Cheap early reject when the client declares an oversized body...
  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "Request body is too large." }, 413);
  }

  // ...and a real one for when it does not. A chunked request carries no
  // content-length, so the header check alone lets an arbitrarily large body
  // through to the JSON parser.
  const raw = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
  if (raw === null) {
    return c.json({ error: "Request body is too large." }, 413);
  }

  let body: { images?: unknown; notes?: unknown; effort?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: "Request body must be JSON." }, 400);
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length < 1 || images.length > MAX_IMAGES) {
    return c.json({ error: `Provide between 1 and ${MAX_IMAGES} images.` }, 400);
  }
  for (const image of images) {
    if (typeof image !== "string" || !DATA_URL_PATTERN.test(image)) {
      return c.json({ error: "Images must be JPEG/PNG/WebP/GIF data URLs." }, 400);
    }
  }

  const notes = typeof body.notes === "string" ? body.notes.slice(0, MAX_NOTES_LENGTH) : "";
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "medium";

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Runs beyond this handler's return; the response stream stays open while
  // the provider call is in flight.
  c.executionCtx.waitUntil(
    runSolve(writer, provider, images as string[], notes, effort, c.env),
  );

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export default app;
