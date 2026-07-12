// Poe Responses API call + translation into the app-level SSE protocol.
// All three providers (codex/claude/gemini) route through Poe.

import { buildTutorPrompt, SOLVE_INSTRUCTIONS, type EffortKey } from "../shared/prompt";
import {
  finalizeProviderArtifact,
  PROVIDER_LABELS,
  solutionSchema,
  type ProviderKey,
} from "../shared/solution";
import type { SolveEvent } from "../shared/stream-protocol";

const POE_RESPONSES_URL = "https://api.poe.com/v1/responses";
const SAFETY_TIMEOUT_MS = 280_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3_000;

export type WorkerEnv = {
  POE_API_KEY?: string;
  POE_CODEX_MODEL?: string;
  POE_CLAUDE_MODEL?: string;
  POE_GEMINI_MODEL?: string;
  // Comma-separated provider keys that should use a non-streamed upstream
  // fetch (still delivered over the same SSE response), e.g. "codex,gemini".
  POE_NO_STREAM?: string;
};

const DEFAULT_MODELS: Record<ProviderKey, string> = {
  codex: "GPT-5.2",
  claude: "Claude-Sonnet-4.6",
  gemini: "Gemini-3.1-Pro",
};

function modelFor(provider: ProviderKey, env: WorkerEnv) {
  const override =
    provider === "codex"
      ? env.POE_CODEX_MODEL
      : provider === "claude"
        ? env.POE_CLAUDE_MODEL
        : env.POE_GEMINI_MODEL;
  return override?.trim() || DEFAULT_MODELS[provider];
}

function wantsUpstreamStream(provider: ProviderKey, env: WorkerEnv) {
  const flags = (env.POE_NO_STREAM || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return !flags.includes(provider);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const encoder = new TextEncoder();

function encodeEvent(event: SolveEvent) {
  const { type, ...payload } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function encodeHeartbeat() {
  return encoder.encode(`: heartbeat\n\n`);
}

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

  const abort = new AbortController();
  const safetyTimer = setTimeout(() => {
    abort.abort(
      new Error(
        `${PROVIDER_LABELS[provider]} timed out after ${Math.round(SAFETY_TIMEOUT_MS / 1000)} seconds.`,
      ),
    );
  }, SAFETY_TIMEOUT_MS);

  try {
    const apiKey = env.POE_API_KEY?.trim();
    if (!apiKey) {
      await write({ type: "error", message: "POE_API_KEY is not configured on the server." });
      return;
    }

    await write({ type: "status", message: `Asking ${PROVIDER_LABELS[provider]}...` });

    const requestBody: Record<string, unknown> = {
      model: modelFor(provider, env),
      instructions: SOLVE_INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: buildTutorPrompt(notes, effort) },
            ...images.map((url) => ({ type: "input_image", image_url: url })),
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "civil_solution",
          strict: true,
          schema: solutionSchema,
        },
      },
    };

    const streamUpstream = wantsUpstreamStream(provider, env);
    let lastError: Error | null = null;
    let rawText = "";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let deltaEmitted = false;
      try {
        rawText = streamUpstream
          ? await fetchStreamed(apiKey, requestBody, abort.signal, async (delta) => {
              deltaEmitted = true;
              await write({ type: "delta", text: delta });
            })
          : await fetchNonStreamed(apiKey, requestBody, abort.signal);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Never retry once partial output reached the client, and don't
        // retry the safety abort.
        if (deltaEmitted || abort.signal.aborted || attempt === MAX_ATTEMPTS - 1) {
          break;
        }
        await write({
          type: "status",
          message: `${PROVIDER_LABELS[provider]} hit a temporary issue. Retrying...`,
        });
        await sleep(RETRY_DELAY_MS);
      }
    }

    if (lastError) {
      throw lastError;
    }
    if (!rawText.trim()) {
      throw new Error(`${PROVIDER_LABELS[provider]} returned an empty response.`);
    }

    const solution = finalizeProviderArtifact(provider, rawText);
    await write({ type: "done", solution });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected provider error.";
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

async function fetchNonStreamed(
  apiKey: string,
  requestBody: Record<string, unknown>,
  signal: AbortSignal,
) {
  const response = await fetch(POE_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    (error as Error & { retryable?: boolean }).retryable = isRetryableStatus(response.status);
    throw error;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return extractTextOutput(payload);
}

async function fetchStreamed(
  apiKey: string,
  requestBody: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void>,
) {
  const response = await fetch(POE_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }
  if (!response.body) {
    throw new Error("Upstream returned no response body.");
  }

  let accumulated = "";
  let completedText = "";
  let upstreamError = "";

  for await (const data of readSseDataLines(response.body)) {
    if (data === "[DONE]") break;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";

    if (type.endsWith(".delta") && typeof event.delta === "string") {
      accumulated += event.delta;
      await onDelta(event.delta);
    } else if (type === "response.completed" && event.response && typeof event.response === "object") {
      completedText = extractTextOutput(event.response as Record<string, unknown>);
    } else if (type === "response.failed" || type === "error") {
      upstreamError =
        readErrorMessage(event) || "The provider reported a stream failure.";
    }
  }

  if (!accumulated && !completedText && upstreamError) {
    throw new Error(upstreamError);
  }

  return completedText || accumulated;
}

/** Async iterator over the `data:` payloads of an upstream SSE byte stream. */
async function* readSseDataLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      yield tail.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

function extractTextOutput(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as Record<string, unknown>;
      if (typeof piece.text === "string" && piece.text.trim()) {
        texts.push(piece.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function readErrorMessage(event: Record<string, unknown>) {
  const error = event.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof event.message === "string") return event.message;
  const response = event.response;
  if (response && typeof response === "object") {
    const nested = (response as Record<string, unknown>).error;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return "";
}
