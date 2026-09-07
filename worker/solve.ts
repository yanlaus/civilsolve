// Solve orchestration: one provider, one SSE response.
//
// Dialect-specific concerns (endpoints, request shape, stream parsing) live in
// worker/channels.ts. This module only owns the parts that are the same for
// every channel: immediate SSE headers, heartbeats, the safety timeout, the
// retry/downgrade policy, and translation into the app-level SSE protocol.

import type { EffortKey } from "../shared/prompt";
import type { ProviderKey } from "../shared/providers";
import { finalizeProviderArtifact } from "../shared/solution";
import type { SolveEvent } from "../shared/stream-protocol";
import {
  buildRequest,
  extractCompleted,
  extractDelta,
  extractFinalText,
  extractPayloadError,
  extractStructuredDelta,
  resolveRoute,
  streamTerminator,
  supportsEffort,
  wantsUpstreamStream,
  type Capabilities,
  type Dialect,
  type Route,
  type WorkerEnv,
} from "./channels";

export type { WorkerEnv };

const SAFETY_TIMEOUT_MS = 280_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 1;
const RETRY_DELAY_MS = 3_000;
/** Unrecognised 400s that we speculatively treat as a rejected parameter. */
const MAX_BLIND_DOWNGRADES = 1;

const encoder = new TextEncoder();

function encodeEvent(event: SolveEvent) {
  const { type, ...payload } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function encodeHeartbeat() {
  return encoder.encode(`: heartbeat\n\n`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type UpstreamError = Error & {
  status?: number;
  body?: string;
  retryable?: boolean;
};

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function upstreamError(label: string, status: number, body: string): UpstreamError {
  const error = new Error(
    `${label} failed with HTTP ${status}: ${body.slice(0, 500)}`,
  ) as UpstreamError;
  error.status = status;
  error.body = body;
  error.retryable = isRetryableStatus(status);
  return error;
}

function toError(value: unknown): UpstreamError {
  return (value instanceof Error ? value : new Error(String(value))) as UpstreamError;
}

/**
 * A missing `retryable` flag means the failure never reached a response
 * (socket reset, DNS, abort) - those are worth one more try.
 */
function isRetryable(error: UpstreamError) {
  return error.retryable !== false;
}

type DropTarget = "reasoning" | "schema" | "unknown";

const REASONING_WORDS =
  /reasoning|reasoning_effort|\beffort\b|thinking|thinking_budget|thinkingbudget|thinkingconfig/i;
const SCHEMA_WORDS =
  /response_format|json_schema|jsonschema|responseschema|response schema|structured output|additionalproperties|responsemimetype/i;
const PARAM_WORDS = /param|参数|參數|field|unsupported|unrecognized|unknown|invalid/i;

/**
 * Decides whether an upstream rejection is about an optional request feature
 * we can drop. Vendors do not publish which bots accept reasoning parameters
 * or strict schemas, so the request degrades itself instead of guessing.
 */
function paramRejection(error: UpstreamError): DropTarget | null {
  if (error.status !== 400 && error.status !== 422) return null;
  const body = error.body || error.message;
  // Checked before the reasoning words: a gateway that refuses forced tools
  // while thinking is on names both, and dropping the tool is the fix.
  if (/tool_choice|tool choice/i.test(body)) return "schema";
  if (REASONING_WORDS.test(body)) return "reasoning";
  if (SCHEMA_WORDS.test(body)) return "schema";
  if (PARAM_WORDS.test(body)) return "unknown";
  return null;
}

// ---------------------------------------------------------------------------
// Capability downgrades
// ---------------------------------------------------------------------------

// Reasoning and schema degrade independently: a bot that refuses strict JSON
// schemas may still accept a thinking-effort parameter, so dropping one must
// never quietly drop the other.
//   reasoning: on -> off
//   schema:    strict -> loose (plain JSON mode) -> none
const MAX_DOWNGRADES = 3;

function startingCapabilities(route: Route, effort: EffortKey): Capabilities {
  return { reasoning: supportsEffort(route, effort), schema: "strict" };
}

function canDrop(caps: Capabilities, drop: DropTarget) {
  if (drop === "reasoning") return caps.reasoning;
  if (drop === "schema") return caps.schema !== "none";
  return caps.reasoning || caps.schema !== "none";
}

function applyDrop(caps: Capabilities, drop: DropTarget): Capabilities {
  const relaxSchema = (): Capabilities["schema"] =>
    caps.schema === "strict" ? "loose" : "none";

  if (drop === "reasoning") return { ...caps, reasoning: false };
  if (drop === "schema") return { ...caps, schema: relaxSchema() };
  // Unrecognised parameter error: shed the more exotic parameter first.
  if (caps.reasoning) return { ...caps, reasoning: false };
  return { ...caps, schema: relaxSchema() };
}

function describeDrop(caps: Capabilities, drop: DropTarget) {
  if (drop === "reasoning" || (drop === "unknown" && caps.reasoning)) {
    return "the thinking-effort setting";
  }
  if (caps.schema === "strict") return "the strict JSON schema";
  return "JSON response formatting";
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

/**
 * Runs the full solve for one provider, writing app-level SSE events to
 * `writer`. Closes the writer when finished (success or error).
 */
export async function runSolve(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  provider: ProviderKey,
  images: string[],
  notes: string,
  effort: EffortKey,
  env: WorkerEnv,
) {
  const write = async (event: SolveEvent) => {
    await writer.write(encodeEvent(event));
  };

  const heartbeat = setInterval(() => {
    writer.write(encodeHeartbeat()).catch(() => {
      clearInterval(heartbeat);
    });
  }, HEARTBEAT_INTERVAL_MS);

  const route = resolveRoute(provider, env);

  const abort = new AbortController();
  const safetyTimer = setTimeout(() => {
    abort.abort(
      new Error(
        `${route.label} timed out after ${Math.round(SAFETY_TIMEOUT_MS / 1000)} seconds.`,
      ),
    );
  }, SAFETY_TIMEOUT_MS);

  try {
    if (route.problem) {
      await write({ type: "error", message: route.problem });
      return;
    }

    await write({ type: "status", message: `Asking ${route.label}...` });

    const streamUpstream = wantsUpstreamStream(route, env);
    const maxSteps = 1 + MAX_DOWNGRADES + MAX_TRANSIENT_RETRIES;

    let caps = startingCapabilities(route, effort);
    let transientRetries = 0;
    let blindDowngrades = 0;
    let lastError: UpstreamError | null = null;
    let rawText = "";

    for (let step = 0; step < maxSteps; step += 1) {
      const request = buildRequest(route, caps, images, notes, effort, streamUpstream);
      let deltaEmitted = false;

      try {
        rawText = streamUpstream
          ? await fetchStreamed(route.dialect, route.label, request, abort.signal, async (delta) => {
              deltaEmitted = true;
              await write({ type: "delta", text: delta });
            })
          : await fetchNonStreamed(route.dialect, route.label, request, abort.signal);
        lastError = null;
        break;
      } catch (error) {
        lastError = toError(error);

        // Never retry once partial output reached the client, and never
        // retry the safety abort.
        if (deltaEmitted || abort.signal.aborted) break;

        const drop = paramRejection(lastError);
        if (
          drop &&
          canDrop(caps, drop) &&
          !(drop === "unknown" && blindDowngrades >= MAX_BLIND_DOWNGRADES)
        ) {
          if (drop === "unknown") blindDowngrades += 1;
          const dropped = describeDrop(caps, drop);
          caps = applyDrop(caps, drop);
          await write({
            type: "status",
            message: `${route.label} rejected ${dropped}. Retrying without it...`,
          });
          continue;
        }

        if (!isRetryable(lastError) || transientRetries >= MAX_TRANSIENT_RETRIES) break;
        transientRetries += 1;
        await write({
          type: "status",
          message: `${route.label} hit a temporary issue. Retrying...`,
        });
        await sleep(RETRY_DELAY_MS);
      }
    }

    if (lastError) throw lastError;
    if (!rawText.trim()) {
      throw new Error(`${route.label} returned an empty response.`);
    }

    const solution = finalizeProviderArtifact(provider, rawText);
    await write({ type: "done", solution });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected provider error.";
    try {
      await write({ type: "error", message });
    } catch {
      // client already disconnected
    }
  } finally {
    clearTimeout(safetyTimer);
    clearInterval(heartbeat);
    try {
      await writer.close();
    } catch {
      // already closed/errored
    }
  }
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

async function fetchNonStreamed(
  dialect: Dialect,
  label: string,
  request: { url: string; headers: Record<string, string>; body: string },
  signal: AbortSignal,
) {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
  });

  if (!response.ok) {
    throw upstreamError(label, response.status, await response.text());
  }

  const payload = (await response.json()) as Record<string, unknown>;

  // Some upstreams (MiniMax) report failures inside an HTTP 200 body.
  const payloadError = extractPayloadError(dialect, payload);
  if (payloadError) {
    const error = new Error(`${label}: ${payloadError}`) as UpstreamError;
    error.retryable = false;
    throw error;
  }

  return extractFinalText(dialect, payload);
}

async function fetchStreamed(
  dialect: Dialect,
  label: string,
  request: { url: string; headers: Record<string, string>; body: string },
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void>,
) {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal,
  });

  if (!response.ok) {
    throw upstreamError(label, response.status, await response.text());
  }
  if (!response.body) {
    const error = new Error(`${label} returned no response body.`) as UpstreamError;
    error.retryable = true;
    throw error;
  }

  // A stream request does not guarantee a stream back. MiniMax answers an
  // invalid request with HTTP 200 and a plain JSON body carrying base_resp,
  // and some gateways simply ignore `stream: true`. Without this branch the
  // SSE reader finds no `data:` lines and the real reason is replaced by a
  // useless "returned an empty response".
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("event-stream")) {
    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Not JSON either - fall through and report the raw body.
    }

    if (payload) {
      const problem = extractPayloadError(dialect, payload);
      if (problem) {
        const error = new Error(`${label}: ${problem}`) as UpstreamError;
        // An error reported inside a 200 body is still a rejected request, so
        // label it 400: that is what lets the downgrade ladder see it and shed
        // whichever optional parameter the upstream refused.
        error.status = 400;
        error.body = text;
        error.retryable = false;
        throw error;
      }
      return extractFinalText(dialect, payload);
    }

    const error = new Error(
      `${label} returned a non-stream response: ${text.slice(0, 300)}`,
    ) as UpstreamError;
    error.retryable = false;
    throw error;
  }

  const terminator = streamTerminator(dialect);
  let accumulated = "";
  let structuredText = "";
  let completedText = "";
  let upstreamMessage = "";

  for await (const data of readSseData(response.body)) {
    if (terminator && data === terminator) break;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const delta = extractDelta(dialect, event);
    if (delta) {
      accumulated += delta;
      await onDelta(delta);
      continue;
    }

    // Forced structured output arrives on its own channel and outranks any
    // prose in the same response.
    const structured = extractStructuredDelta(dialect, event);
    if (structured) {
      structuredText += structured;
      await onDelta(structured);
      continue;
    }

    const completed = extractCompleted(dialect, event);
    if (completed) {
      completedText = extractFinalText(dialect, completed);
      continue;
    }

    const problem = extractPayloadError(dialect, event);
    if (problem) upstreamMessage = problem;
  }

  if (!accumulated && !structuredText && !completedText && upstreamMessage) {
    const error = new Error(`${label}: ${upstreamMessage}`) as UpstreamError;
    error.retryable = false;
    throw error;
  }

  return structuredText || completedText || accumulated;
}

/**
 * Async iterator over the `data:` payloads of an upstream SSE byte stream.
 * Frames are assembled per event, so an upstream that splits one JSON payload
 * across several `data:` lines (allowed by the SSE spec) is handled instead of
 * being silently dropped.
 */
async function* readSseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    return payload;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          const payload = flush();
          if (payload !== null) yield payload;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // Other fields (event:, id:, retry:) and `:` comments are ignored.
      }
    }

    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      dataLines.push(tail.slice(5).replace(/^ /, ""));
    }
    const payload = flush();
    if (payload !== null) yield payload;
  } finally {
    reader.releaseLock();
  }
}
