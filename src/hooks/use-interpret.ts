// Diagram-interpretation pipeline state machine: the two readers read the
// question at the same time, a third model reconciles their readings, then
// the result pauses in "review" for the user to edit/confirm before solving.
// Each reader can be stopped on its own (the other's reading then goes to
// review alone), and the whole pass with reset().

import { useCallback, useRef, useState } from "react";
import type { EffortKey } from "../../shared/prompt";
import {
  interpretationToText,
  type InterpretationResult,
} from "../../shared/interpretation";
import {
  PROVIDER_LABELS,
  providerDisplayName,
  type ModelChoice,
  type ProviderKey,
} from "../../shared/providers";
import type { InterpretRequestBody } from "../../shared/stream-protocol";
import {
  cancelJob,
  childController,
  isConnectionLost,
  jobHandle,
  openTaskStream,
  readSseEvents,
  stopTask,
  StoppedError,
  StreamInterruptedError,
  takeJobEvent,
  withResume,
  type JobHandle,
} from "@/lib/sse";

/** One model's line in the progress box: who, what it is doing, and whether it is through. */
export type ModelProgress = {
  label: string;
  status: string;
  state: "working" | "done" | "failed" | "stopped";
  /**
   * Whether this model has a Stop of its own: a reader does - its partner's
   * reading is then reviewed alone - the reconciler does not; stopping it is
   * stopping the pass.
   */
  stoppable?: boolean;
};

export type InterpretPipeline =
  | { status: "idle" }
  | {
      status: "running";
      /** What this step does: "Reading the question", "Reconciling the two readings". */
      stage: string;
      step: number;
      steps: number;
      /**
       * Each model of this step on a line of its own. They were one string
       * joined with " · " until 26 September 2026, which with two readers
       * working at once was hard to follow.
       */
      models: ModelProgress[];
      /** When this step started, on this page's clock. */
      startedAt: number;
    }
  | {
      status: "review";
      interpretation: InterpretationResult;
      text: string;
      /** Set when one reader failed and the other's reading is shown without a cross-check. */
      note?: string;
      /** Who read it: "DeepSeek (Flash) and Muse Spark, reconciled by ChatGPT". */
      credit: string;
    }
  | { status: "error"; message: string };

export type InterpretConfig = {
  interpreterA: ModelChoice;
  interpreterB: ModelChoice;
  verifier: ModelChoice;
  /** Reasoning level for the two readers. The judge always uses the server default (max). */
  readerEffort: EffortKey;
};

const UNREACHABLE =
  "Could not reach the server for 2 minutes during the interpretation pass. Check the connection and run it again.";

function failureOf(error: unknown) {
  return error instanceof StoppedError
    ? "you stopped it"
    : isConnectionLost(error)
      ? UNREACHABLE
      : error instanceof Error
        ? error.message
        : "The interpretation pipeline failed.";
}

/** A model call in flight, so its Stop button can end it. */
type RunningCall = { handle: JobHandle; abort: AbortController };

export function useInterpret() {
  const [pipeline, setPipeline] = useState<InterpretPipeline>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  /**
   * The model calls running now, by label (a list: both readers may be the
   * same model, and share a line), so Stop can end them on the server.
   */
  const callsRef = useRef(new Map<string, RunningCall[]>());
  /** The running pass's line updater, for a Stop pressed from outside it. */
  const reportRef = useRef<
    ((label: string, detail: string, state: ModelProgress["state"]) => void) | null
  >(null);

  const stopJobs = () => {
    for (const calls of callsRef.current.values()) {
      for (const { handle } of calls) cancelJob(handle);
    }
    callsRef.current = new Map();
  };

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopJobs();
    reportRef.current = null;
    setPipeline({ status: "idle" });
  }, []);

  /**
   * One reader's Stop: ends its model call and marks its line at once. The
   * pass carries on with the other reader, whose reading is then reviewed
   * alone; with both stopped there is nothing to review.
   */
  const stopModel = useCallback((label: string) => {
    for (const { handle, abort } of callsRef.current.get(label) ?? []) stopTask(handle, abort);
    reportRef.current?.(label, "stopped", "stopped");
  }, []);

  const start = useCallback(
    async (config: InterpretConfig, images: string[], notes: string) => {
      abortRef.current?.abort();
      stopJobs();
      const abort = new AbortController();
      abortRef.current = abort;

      const nameOf = (choice: ModelChoice) => providerDisplayName(choice.provider, choice.variant);
      const labelA = nameOf(config.interpreterA);
      const labelB = nameOf(config.interpreterB);
      const labelV = nameOf(config.verifier);

      // One step at a time in the progress box: what the step does, and a
      // line per model in it ("DeepSeek - writing... 1,200 characters").
      let current: InterpretPipeline & { status: "running" } = {
        status: "running",
        stage: "",
        step: 1,
        steps: 2,
        models: [],
        startedAt: Date.now(),
      };
      const beginStep = (stage: string, step: number, labels: string[], stoppable: boolean) => {
        current = {
          status: "running",
          stage,
          step,
          steps: 2,
          models: [...new Set(labels)].map((label) => ({
            label,
            status: "starting...",
            state: "working",
            stoppable,
          })),
          startedAt: Date.now(),
        };
        setPipeline(current);
      };
      const report = (
        label: string,
        detail: string | undefined,
        state: ModelProgress["state"] = "working",
      ) => {
        if (!detail) return;
        current = {
          ...current,
          models: current.models.map((model) =>
            // A model that is through keeps its last word.
            model.label === label && model.state === "working" ? { ...model, status: detail, state } : model,
          ),
        };
        setPipeline(current);
      };
      reportRef.current = (label, detail, state) => {
        if (!abort.signal.aborted) report(label, detail, state);
      };

      // Each model call runs in a server-side job of its own. If its
      // connection drops (a phone backgrounding the browser, usually) it
      // re-attaches to that job when the page is visible again, so neither a
      // call in progress nor a reading that already arrived is thrown away.
      // The pass is not recovered after a full page reload - it pauses for
      // review, which only makes sense in the page that ran it.
      const call = (choice: ModelChoice, body: InterpretRequestBody) => {
        const { provider, variant } = choice;
        const label = nameOf(choice);
        // "Kimi (via OpenCode Go) hit a temporary issue..." under "Kimi:"
        // reads better without the name twice.
        const plain = new RegExp(String.raw`^${PROVIDER_LABELS[provider]}(?: \(via [^)]*\))?(?::\s*|\s+)`);
        const say = (message: string | undefined) => report(label, message?.replace(plain, ""));
        const handle = jobHandle();
        // Its own controller, so its Stop leaves the other calls running.
        const own = childController(abort.signal);
        callsRef.current.set(label, [...(callsRef.current.get(label) ?? []), { handle, abort: own }]);
        const sent = variant ? { ...body, variant } : body;
        return withResume(
          () => runInterpretRequest(provider, sent, own.signal, handle, say),
          handle,
          own.signal,
          say,
        ).then(
          (result) => {
            // A reading that landed as Stop was pressed is not wanted either.
            if (handle.stopped) throw new StoppedError(`${label} was stopped.`);
            report(label, "done", "done");
            return result;
          },
          (error: unknown) => {
            // Whatever a stopped call ended with, it ended because of Stop.
            if (handle.stopped) throw new StoppedError(`${label} was stopped.`);
            report(label, failureOf(error).replace(plain, ""), "failed");
            throw error;
          },
        );
      };

      // The readers read at the same time: neither needs the other's
      // reading, and the account is on Workers Paid (22 September 2026), so
      // two concurrent streams no longer trip a CPU limit. They ran one after
      // the other until 25 September, which made the pass take the sum of
      // both readers instead of the slower one.
      beginStep("Reading the question", 1, [labelA, labelB], true);
      const readerBody: InterpretRequestBody = {
        mode: "interpret",
        images,
        notes,
        effort: config.readerEffort,
      };
      const [settledA, settledB] = await Promise.allSettled([
        call(config.interpreterA, readerBody),
        call(config.interpreterB, readerBody),
      ]);
      if (abort.signal.aborted) return;

      if (settledA.status === "rejected" && settledB.status === "rejected") {
        callsRef.current = new Map();
        reportRef.current = null;
        if (settledA.reason instanceof StoppedError && settledB.reason instanceof StoppedError) {
          // Both stopped: that is the pass stopped, not a failure to report.
          setPipeline({ status: "idle" });
          return;
        }
        setPipeline({
          status: "error",
          message: `Neither reader could read the question. ${labelA}: ${failureOf(settledA.reason)}. ${labelB}: ${failureOf(settledB.reason)}.`,
        });
        return;
      }

      // One reader failed: its partner's reading is still worth reviewing,
      // it just has had no second opinion - so say so rather than throw it
      // away along with the failure.
      if (settledA.status === "rejected" || settledB.status === "rejected") {
        const [kept, lost] =
          settledA.status === "fulfilled" && settledB.status === "rejected"
            ? [{ label: labelA, reading: settledA.value }, { label: labelB, reason: settledB.reason }]
            : settledB.status === "fulfilled" && settledA.status === "rejected"
              ? [{ label: labelB, reading: settledB.value }, { label: labelA, reason: settledA.reason }]
              : [null, null];
        if (!kept || !lost) return;
        callsRef.current = new Map();
        reportRef.current = null;
        setPipeline({
          status: "review",
          interpretation: kept.reading,
          text: interpretationToText(kept.reading),
          note:
            lost.reason instanceof StoppedError
              ? `You stopped ${lost.label}, so this is ${kept.label}'s reading alone - not cross-checked by ${labelV}. Check it with extra care.`
              : `${lost.label} could not read the question (${failureOf(lost.reason)}), so this is ${kept.label}'s reading alone - not cross-checked by ${labelV}. Check it with extra care.`,
          credit: `${kept.label} alone`,
        });
        return;
      }

      try {
        beginStep("Reconciling the two readings", 2, [labelV], false);
        const verified = await call(config.verifier, {
          mode: "verify",
          images,
          notes,
          interpretations: [
            interpretationToText(settledA.value),
            interpretationToText(settledB.value),
          ],
        });

        setPipeline({
          status: "review",
          interpretation: verified,
          text: interpretationToText(verified),
          credit:
            labelA === labelB
              ? `${labelA} twice, reconciled by ${labelV}`
              : `${labelA} and ${labelB}, reconciled by ${labelV}`,
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setPipeline({ status: "error", message: failureOf(error) });
      } finally {
        callsRef.current = new Map();
        reportRef.current = null;
      }
    },
    [],
  );

  return { pipeline, start, reset, stopModel };
}

async function runInterpretRequest(
  provider: ProviderKey,
  body: InterpretRequestBody,
  signal: AbortSignal,
  handle: JobHandle,
  report: (detail: string | undefined) => void,
): Promise<InterpretationResult> {
  const stream = await openTaskStream(handle, `/api/interpret/${provider}`, body, signal);
  let charsReceived = 0;

  for await (const event of readSseEvents(stream)) {
    if (takeJobEvent(handle, event)) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // The stage line already names the model; its "Asking ..." adds nothing.
    if (event.name === "status" && typeof payload.message === "string") {
      charsReceived = 0;
      report(payload.message.startsWith("Asking ") ? "thinking..." : payload.message);
    }
    if (event.name === "delta" && typeof payload.text === "string") {
      charsReceived += payload.text.length;
      report(`writing... ${charsReceived.toLocaleString()} characters`);
    }
    if (event.name === "done" && payload.interpretation && typeof payload.interpretation === "object") {
      return payload.interpretation as InterpretationResult;
    }
    if (event.name === "error" && typeof payload.message === "string") {
      throw new Error(payload.message);
    }
  }

  throw new StreamInterruptedError(
    `${PROVIDER_LABELS[provider]}: the interpretation stream ended before the reading arrived.`,
  );
}
