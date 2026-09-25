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
  cancelJob,
  isConnectionLost,
  jobHandle,
  openTaskStream,
  readSseEvents,
  StreamInterruptedError,
  takeJobEvent,
  withResume,
  type JobHandle,
} from "@/lib/sse";

export type InterpretPipeline =
  | { status: "idle" }
  | {
      status: "running";
      stage: string;
      /** The latest status from the server (a retry, a model switch) or a reconnect note. */
      detail?: string;
      /** When this step started and when the server gives up on it, on this page's clock. */
      startedAt: number;
      deadlineAt?: number;
    }
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
  /** The step running now, so Cancel can stop its model call on the server. */
  const jobRef = useRef<JobHandle | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (jobRef.current) cancelJob(jobRef.current);
    jobRef.current = null;
    setPipeline({ status: "idle" });
  }, []);

  const start = useCallback(
    async (config: InterpretConfig, images: string[], notes: string) => {
      abortRef.current?.abort();
      if (jobRef.current) cancelJob(jobRef.current);
      const abort = new AbortController();
      abortRef.current = abort;

      const labelA = PROVIDER_LABELS[config.interpreterA];
      const labelB = PROVIDER_LABELS[config.interpreterB];
      const labelV = PROVIDER_LABELS[config.verifier];

      // Each step runs in a server-side job of its own. If its connection
      // drops (a phone backgrounding the browser, usually) it re-attaches to
      // that job when the page is visible again, so neither the step in
      // progress nor a reading that already arrived is thrown away. The pass
      // is not recovered after a full page reload - it pauses for review,
      // which only makes sense in the page that ran it.
      const step = (
        stage: string,
        provider: ProviderKey,
        body: InterpretRequestBody,
      ) => {
        let current: InterpretPipeline & { status: "running" } = {
          status: "running",
          stage,
          startedAt: Date.now(),
        };
        const report = (change: Partial<typeof current>) => {
          current = { ...current, ...change };
          setPipeline(current);
        };
        report({});
        const handle = jobHandle();
        jobRef.current = handle;
        return withResume(
          () => runInterpretRequest(provider, body, abort.signal, handle, report),
          handle,
          abort.signal,
          (message) => report({ detail: message }),
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
            ? "Could not reach the server for 2 minutes during the interpretation pass. Check the connection and run it again."
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
  handle: JobHandle,
  report: (change: { detail?: string; startedAt?: number; deadlineAt?: number }) => void,
): Promise<InterpretationResult> {
  const stream = await openTaskStream(handle, `/api/interpret/${provider}`, body, signal);
  let charsReceived = 0;

  for await (const event of readSseEvents(stream)) {
    if (takeJobEvent(handle, event)) {
      const timing = handle.timing;
      if (timing) {
        report({
          ...(timing.startedAt !== undefined ? { startedAt: timing.startedAt + timing.clockOffset } : {}),
          ...(timing.deadlineAt !== undefined ? { deadlineAt: timing.deadlineAt + timing.clockOffset } : {}),
        });
      }
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // The stage line already names the model; its "Asking ..." adds nothing.
    if (event.name === "status" && typeof payload.message === "string") {
      charsReceived = 0;
      report({ detail: payload.message.startsWith("Asking ") ? undefined : payload.message });
    }
    if (event.name === "delta" && typeof payload.text === "string") {
      charsReceived += payload.text.length;
      report({ detail: `writing... ${charsReceived.toLocaleString()} characters` });
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
