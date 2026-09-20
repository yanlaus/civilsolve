// Task orchestration: one provider, one SSE response.
//
// Dialect-specific concerns (endpoints, request shape, stream parsing) live in
// worker/channels.ts. This module only owns the parts that are the same for
// every channel and every task: immediate SSE headers, heartbeats, the safety
// timeout, the retry/downgrade policy, and translation into the app-level SSE
// protocol. Both /api/solve and /api/interpret run through it.

import { EFFORT_KEYS, type EffortKey } from "../shared/prompt";
import type { ProviderKey } from "../shared/providers";
import {
  buildRequest,
  extractCompleted,
  extractDelta,
  extractFinalText,
  extractPayloadError,
  hitOutputCap,
  isReasoningOnlyFrame,
  isTerminalFrame,
  isThinkingExhausted,
  resolveRoute,
  streamTerminator,
  supportsEffort,
  wantsUpstreamStream,
  type Capabilities,
  type RouteOverride,
  type Dialect,
  type Route,
  type Task,
  type WorkerEnv,
} from "./channels";

export type { WorkerEnv };

const SAFETY_TIMEOUT_MS = 280_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_TRANSIENT_RETRIES = 1;
const RETRY_DELAY_MS = 3_000;
/**
 * Retries after the model thought itself out of tokens. One only: the wasted
 * attempt runs to its full thinking budget (~120 s measured), and a second
 * would risk the safety timeout below.
 */
const MAX_EFFORT_STEPDOWNS = 1;
/** Unrecognised 400s that we speculatively treat as a rejected parameter. */
const MAX_BLIND_DOWNGRADES = 1;

// Client deltas are coalesced. The browser only counts characters for a
// progress indicator, so one write per token buys nothing and each write
// costs a JSON.stringify, an encode, and a trip through the TransformStream.
// On a thinking model that is thousands of writes per solve - the single
// largest CPU cost in the Worker, and the free plan kills the isolate for it.
const DELTA_FLUSH_CHARS = 2048;
const DELTA_FLUSH_MS = 400;

const encoder = new TextEncoder();

function encodeEvent(event: TaskEvent) {
  const { type, ...payload } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function encodeHeartbeat() {
  return encoder.encode(`: heartbeat\n\n`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function raiseToFloor(requested: EffortKey, floor: EffortKey | undefined): EffortKey {
  if (!floor) return requested;
  return EFFORT_KEYS.indexOf(requested) < EFFORT_KEYS.indexOf(floor) ? floor : requested;
}

/**
 * Next lower level the route has a real value for, or null at the bottom.
 * Deliberately ignores `minEffort`: the floor picks where a solve *starts*,
 * and this is the recovery path for when that level cannot finish.
 */
function stepDownEffort(route: Route, current: EffortKey): EffortKey | null {
  for (let index = EFFORT_KEYS.indexOf(current) - 1; index >= 0; index -= 1) {
    if (supportsEffort(route, EFFORT_KEYS[index])) return EFFORT_KEYS[index];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

type UpstreamError = Error & {
  status?: number;
  body?: string;
  retryable?: boolean;
  /**
   * The model spent its whole token budget thinking and wrote no answer. Not
   * retryable as-is - the same request would do the same thing - but worth one
   * attempt at a lower thinking level.
   */
  lowerEffort?: boolean;
  /**
   * The stream ended early - dropped, or the output cap hit - after SOME
   * answer text arrived. Whether that text is a usable truncated answer or a
   * useless fragment is the task's call, so it travels with the error and
   * runTask asks `finalize` before deciding between delivering and retrying.
   */
  partialText?: string;
};

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * The human-readable part of an error body, when there is one. Gateways
 * answer `{"error":{"message":"Insufficient balance. Manage your billing
 * here: …"}}`; the user needs that sentence, not the JSON around it. The raw
 * body stays on the error for paramRejection, which pattern-matches it.
 */
function errorBodyMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Not JSON - the raw body is the message.
  }
  return body.slice(0, 500);
}

function upstreamError(label: string, status: number, body: string): UpstreamError {
  const error = new Error(
    `${label} failed with HTTP ${status}: ${errorBodyMessage(body)}`,
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

export type RunTaskParams = {
  provider: ProviderKey;
  env: WorkerEnv;
  effort: EffortKey;
  /** Optional per-request route override (interpretation pins Poe top-tier). */
  routeOverride?: RouteOverride;
  task: Task;
  /**
   * Turns the raw model text into the payload of the `done` event, e.g.
   * `{ solution }` or `{ interpretation }`. Throws on unusable output.
   *
   * `lastAttempt` is true when no retry remains, so a task may accept a
   * cut-off response then (delivering the working with a note) that it
   * would rather see retried while it still can be.
   */
  finalize: (rawText: string, context: { lastAttempt: boolean }) => Record<string, unknown>;
};

type TaskEvent = { type: string } & Record<string, unknown>;

/**
 * Runs one provider task, writing app-level SSE events to `writer`.
 * Closes the writer when finished (success or error).
 */
export async function runTask(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  { provider, env, effort: requestedEffort, routeOverride, task, finalize }: RunTaskParams,
) {
  const write = async (event: TaskEvent) => {
    await writer.write(encodeEvent(event));
  };

  const heartbeat = setInterval(() => {
    writer.write(encodeHeartbeat()).catch(() => {
      clearInterval(heartbeat);
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Not const: a model chain ("a,b") swaps `model` in on a retryable failure.
  let route = resolveRoute(provider, env, routeOverride);
  // A route may pin its reasoning level (a deliberately "always max" model)
  // or set a floor under the user's choice. Not const: a model that spends its
  // whole budget thinking gets retried one level down (see MAX_EFFORT_STEPDOWNS).
  let effort = route.forceEffort ?? raiseToFloor(requestedEffort, route.minEffort);

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
    const maxSteps =
      1 +
      MAX_DOWNGRADES +
      MAX_TRANSIENT_RETRIES +
      MAX_EFFORT_STEPDOWNS +
      // Each fallback model gets its own attempt plus its own transient retry.
      route.fallbackModels.length * (1 + MAX_TRANSIENT_RETRIES);

    let caps = startingCapabilities(route, effort);
    let transientRetries = 0;
    let effortStepDowns = 0;
    let blindDowngrades = 0;
    let modelFallbacks = 0;
    let lastError: UpstreamError | null = null;
    let rawText = "";

    /**
     * Switches to the next model in the chain, if any, and says so. Used
     * wherever the same request would otherwise be retried as-is: a model
     * that did not answer is more likely fixed by a different model than by
     * asking it again. The fallback starts with a fresh transient budget.
     */
    const switchModel = async (): Promise<boolean> => {
      const next = route.fallbackModels[modelFallbacks];
      if (!next) return false;
      modelFallbacks += 1;
      const previous = route.model;
      route = { ...route, model: next };
      transientRetries = 0;
      await write({
        type: "status",
        message: `${route.label}: ${previous} did not answer. Trying ${next}...`,
      });
      // Same pause as a transient retry. Measured on Google: after 3.8-flash
      // closed the socket on a 190 KB request, an immediate 3.5-flash call to
      // the same host failed too while the same call from a cold client
      // succeeded - the host needs a moment, whichever model comes next.
      await sleep(RETRY_DELAY_MS);
      return true;
    };
    // Set when a cut-off response was accepted by `finalize` inside the loop,
    // so it is not parsed a second time under stricter terms at the end.
    let donePayload: Record<string, unknown> | null = null;

    for (let step = 0; step < maxSteps; step += 1) {
      const request = buildRequest(route, caps, task, effort, streamUpstream);
      // Set only when a flush actually reached the client: until then a
      // failed attempt can still be retried without the user seeing a restart.
      let deltaEmitted = false;
      let pending = "";
      let lastFlush = Date.now();

      const flushDeltas = async () => {
        if (!pending) return;
        const text = pending;
        pending = "";
        lastFlush = Date.now();
        deltaEmitted = true;
        await write({ type: "delta", text });
      };

      try {
        rawText = streamUpstream
          ? await fetchStreamed(route.dialect, route.label, request, abort.signal, async (delta) => {
              pending += delta;
              if (pending.length >= DELTA_FLUSH_CHARS || Date.now() - lastFlush >= DELTA_FLUSH_MS) {
                await flushDeltas();
              }
            })
          : await fetchNonStreamed(route.dialect, route.label, request, abort.signal);
        await flushDeltas();
        lastError = null;
        break;
      } catch (error) {
        pending = "";
        lastError = toError(error);

        if (abort.signal.aborted) break;

        // A stream that ended early with some answer text. If the task can
        // make a solution of the prefix, that is the answer - a truncated one,
        // marked as such by the parser. If it cannot, the fragment was worth
        // nothing, and the user has already paid the wait: this is the one
        // deliberate exception to "never retry after a delta reached the
        // client". A drop retries as-is; hitting the output cap retries a
        // level down, since less thinking is what leaves room for the answer.
        if (lastError.partialText !== undefined) {
          const lowered = lastError.lowerEffort ? stepDownEffort(route, effort) : null;
          const canStepDown = Boolean(lowered) && effortStepDowns < MAX_EFFORT_STEPDOWNS;
          const canRetry =
            modelFallbacks < route.fallbackModels.length ||
            transientRetries < MAX_TRANSIENT_RETRIES;
          try {
            donePayload = finalize(lastError.partialText, {
              lastAttempt: !canStepDown && !canRetry,
            });
            lastError = null;
            break;
          } catch {
            // A fragment, or a cut-off answer while a retry is still worth it.
          }
          if (canStepDown && lowered) {
            effortStepDowns += 1;
            effort = lowered;
            caps = { ...caps, reasoning: supportsEffort(route, lowered) };
            await write({
              type: "status",
              message: `${route.label} ran out of room before finishing the answer. Retrying at ${lowered} thinking...`,
            });
            continue;
          }
          if (await switchModel()) continue;
          if (canRetry) {
            transientRetries += 1;
            await write({
              type: "status",
              message: `${route.label} was cut off partway through the answer. Retrying...`,
            });
            await sleep(RETRY_DELAY_MS);
            continue;
          }
          break;
        }

        // Never retry once partial output reached the client (the case above
        // excepted).
        if (deltaEmitted) break;

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

        // The model spent everything it had on thinking. Repeating the request
        // unchanged would repeat that, so shed a thinking level instead. This
        // deliberately goes below the route's floor: the floor chooses where a
        // solve starts, not what it must fail at.
        if (lastError.lowerEffort && effortStepDowns < MAX_EFFORT_STEPDOWNS) {
          const lowered = stepDownEffort(route, effort);
          if (lowered) {
            effortStepDowns += 1;
            effort = lowered;
            // Only the reasoning flag is recomputed; a schema downgrade already
            // negotiated in an earlier step stays negotiated.
            caps = { ...caps, reasoning: supportsEffort(route, lowered) };
            await write({
              type: "status",
              message: `${route.label} used its whole budget thinking without answering. Retrying at ${lowered} thinking...`,
            });
            continue;
          }
        }

        if (!isRetryable(lastError)) break;
        if (await switchModel()) continue;
        if (transientRetries >= MAX_TRANSIENT_RETRIES) break;
        transientRetries += 1;
        await write({
          type: "status",
          message: `${route.label} hit a temporary issue. Retrying...`,
        });
        await sleep(RETRY_DELAY_MS);
      }
    }

    if (lastError) throw lastError;
    if (!donePayload && !rawText.trim()) {
      throw new Error(`${route.label} returned an empty response.`);
    }

    await write({ type: "done", ...(donePayload ?? finalize(rawText, { lastAttempt: true })) });
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

  // Some upstreams report failures inside an HTTP 200 body.
  const payloadError = extractPayloadError(dialect, payload);
  if (payloadError) {
    const error = new Error(`${label}: ${payloadError}`) as UpstreamError;
    error.retryable = false;
    error.lowerEffort = isThinkingExhausted(dialect, payload);
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

  // A stream request does not guarantee a stream back: a gateway may answer
  // an invalid request with HTTP 200 and a plain JSON error body, or simply
  // ignore `stream: true`. Without this branch the SSE reader finds no
  // `data:` lines and the real reason is replaced by a useless "returned an
  // empty response".
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
  let completedText = "";
  let upstreamMessage = "";
  let exhaustedThinking = false;
  let sawTerminal = false;
  let sawCap = false;

  for await (const data of readSseData(response.body)) {
    if (terminator && data === terminator) {
      sawTerminal = true;
      break;
    }
    if (isReasoningOnlyFrame(dialect, data)) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Noted before the frame is otherwise handled: a terminal may also carry
    // the completed payload or an error, and those paths `continue`.
    if (isTerminalFrame(dialect, event)) sawTerminal = true;
    if (hitOutputCap(dialect, event)) sawCap = true;

    const delta = extractDelta(dialect, event);
    if (delta) {
      accumulated += delta;
      await onDelta(delta);
      continue;
    }

    const completed = extractCompleted(dialect, event);
    if (completed) {
      completedText = extractFinalText(dialect, completed);
      continue;
    }

    const problem = extractPayloadError(dialect, event);
    if (problem) {
      upstreamMessage = problem;
      if (isThinkingExhausted(dialect, event)) exhaustedThinking = true;
    }
  }

  if (!accumulated && !completedText) {
    if (upstreamMessage) {
      const error = new Error(`${label}: ${upstreamMessage}`) as UpstreamError;
      error.retryable = false;
      error.lowerEffort = exhaustedThinking;
      throw error;
    }
    // Nothing arrived and the upstream never said it was finished: the
    // connection dropped mid-stream (measured on OpenCode Go: cut off
    // mid-word after two minutes of reasoning). That is transient, so it
    // takes the ordinary retry at the same effort - not the effort step-down,
    // since nothing says the effort was the problem.
    if (!sawTerminal) {
      const error = new Error(
        `${label}: the connection dropped while the model was still thinking.`,
      ) as UpstreamError;
      error.retryable = true;
      throw error;
    }
  }

  // Answer text arrived, but the upstream either never said it finished or
  // said it ran out of output tokens. Either way what we hold is a prefix of
  // the answer, and only the task's parser can tell a usable truncated
  // solution from a fragment cut off in the first field (measured on Grok:
  // 676 characters, then nothing). Hand it up rather than deliver it blind.
  if (!completedText && accumulated && (!sawTerminal || sawCap)) {
    const error = new Error(
      sawCap
        ? `${label}: the model ran out of output tokens partway through the answer.`
        : `${label}: the connection dropped partway through the answer.`,
    ) as UpstreamError;
    error.retryable = !sawCap;
    error.lowerEffort = sawCap;
    error.partialText = accumulated;
    throw error;
  }

  return completedText || accumulated;
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

      // One split per network chunk, keeping the unterminated tail. Cheaper
      // than an indexOf/slice pair per line, which re-flattens the buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const payload = flush();
          if (payload !== null) yield payload;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5));
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
