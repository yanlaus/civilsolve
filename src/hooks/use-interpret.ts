// Diagram-interpretation pipeline state machine: the two readers read the
// question at the same time, a third model reconciles their readings, then
// the result pauses in "review" for the user to edit/confirm before solving.

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
      /** What each model of this step is doing: its latest status, or how much it has written. */
      detail?: string;
      /** When this step started, on this page's clock. */
      startedAt: number;
    }
  | {
      status: "review";
      interpretation: InterpretationResult;
      text: string;
      /** Set when one reader failed and the other's reading is shown without a cross-check. */
      note?: string;
    }
  | { status: "error"; message: string };

export type InterpretConfig = {
  interpreterA: ProviderKey;
  interpreterB: ProviderKey;
  verifier: ProviderKey;
  /** Reasoning level for the two readers. The judge always uses the server default (max). */
  readerEffort: EffortKey;
};

const UNREACHABLE =
  "Could not reach the server for 2 minutes during the interpretation pass. Check the connection and run it again.";

function failureOf(error: unknown) {
  return isConnectionLost(error)
    ? UNREACHABLE
    : error instanceof Error
      ? error.message
      : "The interpretation pipeline failed.";
}

export function useInterpret() {
  const [pipeline, setPipeline] = useState<InterpretPipeline>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  /** The jobs running now, so Cancel can stop their model calls on the server. */
  const jobsRef = useRef<JobHandle[]>([]);

  const stopJobs = () => {
    for (const handle of jobsRef.current) cancelJob(handle);
    jobsRef.current = [];
  };

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stopJobs();
    setPipeline({ status: "idle" });
  }, []);

  const start = useCallback(
    async (config: InterpretConfig, images: string[], notes: string) => {
      abortRef.current?.abort();
      stopJobs();
      const abort = new AbortController();
      abortRef.current = abort;

      const labelA = PROVIDER_LABELS[config.interpreterA];
      const labelB = PROVIDER_LABELS[config.interpreterB];
      const labelV = PROVIDER_LABELS[config.verifier];

      // One step shown in the status line: a stage, and a detail per model
      // running in it ("DeepSeek: writing... 1,200 characters").
      let current: InterpretPipeline & { status: "running" } = {
        status: "running",
        stage: "",
        startedAt: Date.now(),
      };
      const details = new Map<string, string>();
      const beginStep = (stage: string) => {
        details.clear();
        current = { status: "running", stage, startedAt: Date.now() };
        setPipeline(current);
      };
      const report = (label: string, raw: string | undefined) => {
        // "Kimi (via OpenCode Go) hit a temporary issue..." under "Kimi:"
        // reads better without the name twice.
        const detail = raw?.replace(new RegExp(`^${label}(?: \\(via [^)]*\\))?(?::\\s*|\\s+)`), "");
        if (detail) details.set(label, detail);
        else details.delete(label);
        const detailText = [...details].map(([who, what]) => `${who}: ${what}`).join(" · ");
        current = { ...current, detail: detailText || undefined };
        setPipeline(current);
      };

      // Each model call runs in a server-side job of its own. If its
      // connection drops (a phone backgrounding the browser, usually) it
      // re-attaches to that job when the page is visible again, so neither a
      // call in progress nor a reading that already arrived is thrown away.
      // The pass is not recovered after a full page reload - it pauses for
      // review, which only makes sense in the page that ran it.
      const call = (provider: ProviderKey, body: InterpretRequestBody) => {
        const label = PROVIDER_LABELS[provider];
        const handle = jobHandle();
        jobsRef.current.push(handle);
        return withResume(
          () =>
            runInterpretRequest(provider, body, abort.signal, handle, (detail) => report(label, detail)),
          handle,
          abort.signal,
          (message) => report(label, message),
        ).then((result) => {
          report(label, "done");
          return result;
        });
      };

      // The readers read at the same time: neither needs the other's
      // reading, and the account is on Workers Paid (22 September 2026), so
      // two concurrent streams no longer trip a CPU limit. They ran one after
      // the other until 25 September, which made the pass take the sum of
      // both readers instead of the slower one.
      beginStep(
        config.interpreterA === config.interpreterB
          ? `Reading the question with ${labelA}...`
          : `Reading the question with ${labelA} and ${labelB}...`,
      );
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
        setPipeline({
          status: "error",
          message: `Neither reader could read the question. ${labelA}: ${failureOf(settledA.reason)} ${labelB}: ${failureOf(settledB.reason)}`,
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
        setPipeline({
          status: "review",
          interpretation: kept.reading,
          text: interpretationToText(kept.reading),
          note: `${lost.label} could not read the question (${failureOf(lost.reason)}), so this is ${kept.label}'s reading alone - not cross-checked by ${labelV}. Check it with extra care.`,
        });
        return;
      }

      try {
        beginStep(`Cross-checking both readings with ${labelV}...`);
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
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        setPipeline({ status: "error", message: failureOf(error) });
      } finally {
        jobsRef.current = [];
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
