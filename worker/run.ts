// Provider-agnostic SSE run shell: immediate status, heartbeats, safety
// timeout, bounded retries, and finalization of the raw model text into a
// `done` event. Used by both /api/solve and /api/interpret.

import { PROVIDER_LABELS, type ProviderKey } from "../shared/solution";
import {
  callUpstream,
  providerConfigError,
  wantsUpstreamStream,
  type WorkerEnv,
} from "./upstream";

const SAFETY_TIMEOUT_MS = 280_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 3_000;

export type RunTaskParams = {
  provider: ProviderKey;
  env: WorkerEnv;
  prompt: string;
  instructions: string;
  images: string[];
  referenceImages?: string[];
  schemaName: string;
  schema: Record<string, unknown>;
  // Parses/repairs the raw model text into the payload of the `done` event,
  // e.g. { solution } or { interpretation }. Throws on unusable output.
  finalize: (rawText: string) => Record<string, unknown>;
};

type SseEventShape = { type: string } & Record<string, unknown>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const encoder = new TextEncoder();

function encodeEvent(event: SseEventShape) {
  const { type, ...payload } = event;
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function encodeHeartbeat() {
  return encoder.encode(`: heartbeat\n\n`);
}

/**
 * Runs one provider task, writing app-level SSE events to `writer`.
 * Closes the writer when finished (success or error).
 */
export async function runTask(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  params: RunTaskParams,
) {
  const { provider, env } = params;

  const write = async (event: SseEventShape) => {
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
    const configError = providerConfigError(provider, env);
    if (configError) {
      await write({ type: "error", message: configError });
      return;
    }

    await write({ type: "status", message: `Asking ${PROVIDER_LABELS[provider]}...` });

    const wantStream = wantsUpstreamStream(provider, env);
    let lastError: Error | null = null;
    let rawText = "";

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let deltaEmitted = false;
      try {
        rawText = await callUpstream(provider, {
          prompt: params.prompt,
          instructions: params.instructions,
          images: params.images,
          referenceImages: params.referenceImages,
          schemaName: params.schemaName,
          schema: params.schema,
          wantStream,
          onDelta: async (delta) => {
            deltaEmitted = true;
            await write({ type: "delta", text: delta });
          },
          signal: abort.signal,
          env,
        });
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

    await write({ type: "done", ...params.finalize(rawText) });
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
