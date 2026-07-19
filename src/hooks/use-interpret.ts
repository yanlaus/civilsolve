// Diagram-interpretation pipeline state machine:
// two interpreters run in parallel, a verifier reconciles them, then the
// result pauses in "review" for the user to edit/confirm before solving.

import { useCallback, useRef, useState } from "react";
import {
  interpretationToText,
  type InterpretationResult,
} from "../../shared/interpretation";
import { PROVIDER_LABELS, type ProviderKey } from "../../shared/solution";
import type { InterpretRequestBody } from "../../shared/stream-protocol";
import { fetchSseStream, readSseEvents } from "@/lib/sse";

export type InterpretPipeline =
  | { status: "idle" }
  | { status: "running"; stage: string }
  | { status: "review"; interpretation: InterpretationResult; text: string }
  | { status: "error"; message: string };

export type InterpretConfig = {
  interpreterA: ProviderKey;
  interpreterB: ProviderKey;
  verifier: ProviderKey;
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

      try {
        setPipeline({
          status: "running",
          stage: `Reading the question with ${labelA} and ${labelB}...`,
        });

        const [resultA, resultB] = await Promise.all([
          runInterpretRequest(
            config.interpreterA,
            { mode: "interpret", images, notes },
            abort.signal,
          ),
          runInterpretRequest(
            config.interpreterB,
            { mode: "interpret", images, notes },
            abort.signal,
          ),
        ]);

        setPipeline({
          status: "running",
          stage: `Cross-checking both readings with ${labelV}...`,
        });

        const verified = await runInterpretRequest(
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
          abort.signal,
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
          message:
            error instanceof Error ? error.message : "The interpretation pipeline failed.",
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

  throw new Error(`${PROVIDER_LABELS[provider]}: the interpretation stream ended unexpectedly.`);
}
