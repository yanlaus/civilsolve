import { Hono } from "hono";
import { isEffortKey, type EffortKey } from "../shared/prompt";
import { isProviderKey } from "../shared/solution";
import {
  DATA_URL_PATTERN,
  MAX_BODY_BYTES,
  MAX_IMAGES,
  MAX_NOTES_LENGTH,
} from "../shared/stream-protocol";
import { runSolve, type WorkerEnv } from "./poe";

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/api/health", (c) =>
  c.json({ poeConfigured: Boolean(c.env.POE_API_KEY?.trim()) }),
);

app.post("/api/solve/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isProviderKey(provider)) {
    return c.json({ error: "Unknown provider." }, 404);
  }

  const contentLength = Number(c.req.header("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "Request body is too large." }, 400);
  }

  let body: { images?: unknown; notes?: unknown; effort?: unknown };
  try {
    body = await c.req.json();
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
