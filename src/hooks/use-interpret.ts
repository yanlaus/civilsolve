// Diagram-interpretation pipeline state machine:
// two interpreters run in parallel, a verifier reconciles them, then the
// result pauses in "review" for the user to edit/confirm before solving.

import { useCallback, useRef, useState } from "react";
import type { EffortKey } from "../../shared/prompt";
import {
  interpretationToText,
  type InterpretationResult,
} from "../../shared/interpretation";
import { PROVIDER_LABELS, type ProviderKey } from "../../shared/providers";
import type { InterpretRequestBody } from "../../shared/stream-protocol";
import {
  fetchSseStream,
  isConnectionLost,
  readSseEvents,
  StreamInterruptedError,
  withResume,
} from "@/lib/sse";

export type InterpretPipeline =
  | { status: "idle" }
  | { status: "running"; stage: string }
  | { status: "review"; interpretation: InterpretationResult; text: string }
  | { status: "error"; message: string };

export type InterpretConfig = {
  interpreterA: ProviderKey;
  interpreterB: ProviderKey;
  verifier: ProviderKey;
  /** Reasoning level for the two readers. The judge always uses the server default (max). */
  readerEffort: EffortKey;
};

export function useInterpret() {
  const [pipeline, setPipeline] = useState<InterpretPipeline>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPipeline({ status: "idle" });
  }, []);

  const start = useCallback(
    async (config: InterpretConfig, images: string[], notes: string) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      const labelA = PROVIDER_LABELS[config.interpreterA];
      const labelB = PROVIDER_LABELS[config.interpreterB];
      const labelV = PROVIDER_LABELS[config.verifier];

      // Each step restarts on its own if its connection drops (a phone
      // backgrounding the browser, usually), so a reading that already
      // arrived is never thrown away with it.
      const step = (
        stage: string,
        provider: ProviderKey,
        body: InterpretRequestBody,
      ) => {
        setPipeline({ status: "running", stage });
        return withResume(
          () => runInterpretRequest(provider, body, abort.signal),
          abort.signal,
          (message) => setPipeline({ status: "running", stage: `${stage} ${message}` }),
        );
      };

      try {
        // The readers run one after another, not together: two concurrent
        // streams is exactly the load that trips the free plan's CPU limit.
        const resultA = await step(
          `Reading the question with ${labelA}...`,
          config.interpreterA,
          { mode: "interpret", images, notes, effort: config.readerEffort },
        );

        const resultB = await step(
          `Reading the question with ${labelB}...`,
          config.interpreterB,
          { mode: "interpret", images, notes, effort: config.readerEffort },
        );

        const verified = await step(
          `Cross-checking both readings with ${labelV}...`,
          config.verifier,
          {
            mode: "verify",
            images,
            notes,
            interpretations: [
              interpretationToText(resultA),
              interpretationToText(resultB),
            ],
          },
        );

        setPipeline({
          status: "review",
          interpretation: verified,
          text: interpretationToText(verified),
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setPipeline({
          status: "error",
          message: isConnectionLost(error)
            ? "The connection kept dropping during the interpretation pass. Keep this page open and try again."
            : error instanceof Error
              ? error.message
              : "The interpretation pipeline failed.",
        });
      }
    },
    [],
  );

  return { pipeline, start, reset };
}

async function runInterpretRequest(
  provider: ProviderKey,
  body: InterpretRequestBody,
  signal: AbortSignal,
): Promise<InterpretationResult> {
  const stream = await fetchSseStream(`/api/interpret/${provider}`, body, signal);

  for await (const event of readSseEvents(stream)) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.name === "done" && payload.interpretation && typeof payload.interpretation === "object") {
      return payload.interpretation as InterpretationResult;
    }
    if (event.name === "error" && typeof payload.message === "string") {
      throw new Error(`${PROVIDER_LABELS[provider]}: ${payload.message}`);
    }
  }

  throw new StreamInterruptedError(
    `${PROVIDER_LABELS[provider]}: the interpretation stream ended before the reading arrived.`,
  );
}
