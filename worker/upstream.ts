// Upstream model access: routes each provider to its API.
// codex/claude/gemini -> Poe Responses API; kimi -> OpenAI-compatible
// chat completions (Kimi Code / Moonshot).

import type { ProviderKey } from "../shared/solution";
import { callPoe } from "./poe";
import { callKimi } from "./kimi";

export type WorkerEnv = {
  POE_API_KEY?: string;
  POE_CODEX_MODEL?: string;
  POE_CLAUDE_MODEL?: string;
  POE_GEMINI_MODEL?: string;
  // Comma-separated provider keys that should use a non-streamed upstream
  // fetch (still delivered over the same SSE response), e.g. "codex,kimi".
  POE_NO_STREAM?: string;
  KIMI_API_KEY?: string;
  // OpenAI-compatible base URL. Default is the Kimi Code endpoint; switch to
  // https://api.moonshot.ai/v1 for a Moonshot platform key.
  KIMI_API_URL?: string;
  KIMI_MODEL?: string;
};

export type UpstreamParams = {
  prompt: string;
  instructions: string;
  images: string[];
  // Lecture-notes pages, attached after the assignment images behind a
  // text marker so models don't solve them.
  referenceImages?: string[];
  schemaName: string;
  schema: Record<string, unknown>;
  wantStream: boolean;
  onDelta: (delta: string) => Promise<void>;
  signal: AbortSignal;
  env: WorkerEnv;
};

export const REFERENCE_IMAGES_MARKER =
  "The remaining images are lecture notes provided for method reference only. Do not solve anything in them.";

export function callUpstream(provider: ProviderKey, params: UpstreamParams) {
  return provider === "kimi" ? callKimi(params) : callPoe(provider, params);
}

export function providerConfigError(provider: ProviderKey, env: WorkerEnv) {
  if (provider === "kimi") {
    return env.KIMI_API_KEY?.trim()
      ? ""
      : "KIMI_API_KEY is not configured on the server.";
  }
  return env.POE_API_KEY?.trim() ? "" : "POE_API_KEY is not configured on the server.";
}

export function wantsUpstreamStream(provider: ProviderKey, env: WorkerEnv) {
  const flags = (env.POE_NO_STREAM || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return !flags.includes(provider);
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Async iterator over the `data:` payloads of an upstream SSE byte stream. */
export async function* readSseDataLines(body: ReadableStream<Uint8Array>) {
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
