// Per-provider solve state machine over the app-level SSE protocol.
// Fires one streaming POST per selected provider, all at once; each tab
// progresses independently (spinner -> live progress -> rendered solution).
// With the optional answer cross-check, a judge then grades every finished
// solution against the images.
//
// Every request runs server side in a job that outlives this page
// (worker/jobs.ts). Its id arrives as the stream's first event, is kept in
// a JobHandle and in localStorage (lib/run-store.ts), and is what lets a
// dropped connection re-attach to the same run, a reloaded page recover the
// last run, and Stop cancel the model call on the server.

import { useCallback, useRef, useState } from "react";
import { MAX_JUDGED_SOLUTIONS, type JudgementResult } from "../../shared/judgement";
import { PROVIDER_KEYS, PROVIDER_LABELS, type ProviderKey } from "../../shared/providers";
import { artifactToText, type ProviderArtifact } from "../../shared/solution";
import {
  estimateBodyBytes,
  MAX_BODY_BYTES,
  MAX_SOLUTION_TEXT,
  type JudgeRequestBody,
  type SolveRequestBody,
} from "../../shared/stream-protocol";
import { clearRun, loadRun, saveRun, type SavedRun } from "@/lib/run-store";
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

// Shown once withResume has tried for RECONNECT_WINDOW_MS. The job itself
// kept running on the server, and its id is saved, so a reload re-attaches.
const UNREACHABLE =
  "Could not reach the server for 2 minutes. The model keeps working there - reload this page to pick up";

export type ProviderRun =
  | { status: "idle" }
  | { status: "waiting"; message: string }
  | { status: "streaming"; charsReceived: number }
  | { status: "done"; solution: ProviderArtifact }
  | { status: "error"; message: string };

export type ProviderRuns = Record<ProviderKey, ProviderRun>;

/**
 * The cross-check judge's progress. `solvers` records which provider was
 * Solution A, B, C..., since the judge only ever sees letters; `skipped`
 * names selected solvers that returned nothing and so were not graded.
 */
export type JudgeRun =
  | { status: "idle" }
  | { status: "waiting"; judge: ProviderKey; message: string }
  | { status: "streaming"; judge: ProviderKey; charsReceived: number }
  | {
      status: "done";
      judge: ProviderKey;
      solvers: ProviderKey[];
      skipped: ProviderKey[];
      judgement: JudgementResult;
    }
  | { status: "error"; judge: ProviderKey; message: string };

const IDLE_RUNS = Object.fromEntries(
  PROVIDER_KEYS.map((key) => [key, { status: "idle" } as ProviderRun]),
) as ProviderRuns;

/**
 * How many solvers stream at once: every selected one, up to the number the
 * cross-check can grade. This was 1 on the free Workers plan, where
 * concurrent per-token streams drained the CPU budget and got a stream
 * killed (see the CPU section of AGENTS.md); the account moved to Workers
 * Paid on 22 September 2026.
 */
const SOLVE_CONCURRENCY = MAX_JUDGED_SOLUTIONS;

export function isRunActive(run: ProviderRun) {
  return run.status === "waiting" || run.status === "streaming";
}

export function isJudgeActive(run: JudgeRun) {
  return run.status === "waiting" || run.status === "streaming";
}

function waitingRuns(providers: ProviderKey[], message: string): ProviderRuns {
  const next: ProviderRuns = { ...IDLE_RUNS };
  for (const provider of providers) next[provider] = { status: "waiting", message };
  return next;
}

export function useSolve() {
  const [runs, setRuns] = useState<ProviderRuns>(IDLE_RUNS);
  const [judgeRun, setJudgeRun] = useState<JudgeRun>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  /** Every job of the current run, so Stop can cancel them on the server. */
  const handlesRef = useRef<JobHandle[]>([]);

  /** Ends this page's part of the current run and stops its jobs server side. */
  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    for (const handle of handlesRef.current) cancelJob(handle);
    handlesRef.current = [];
  }, []);

  const cancel = useCallback(() => {
    stopCurrent();
    clearRun();
    setRuns((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as ProviderKey[]) {
        if (isRunActive(next[key])) {
          next[key] = { status: "error", message: "Cancelled." };
        }
      }
      return next;
    });
    setJudgeRun((current) =>
      isJudgeActive(current)
        ? { status: "error", judge: current.judge, message: "Cancelled." }
        : current,
    );
  }, [stopCurrent]);

  /** Clears the page and forgets the saved run (after a recovery, say). */
  const dismiss = useCallback(() => {
    stopCurrent();
    clearRun();
    setRuns(IDLE_RUNS);
    setJudgeRun({ status: "idle" });
  }, [stopCurrent]);

  /**
   * Runs (or re-attaches to) every solver of `run`, then its judge. `body`
   * is null for a run restored after a reload: the images are gone, so jobs
   * can only be re-attached to, never started.
   */
  const execute = useCallback(
    (run: SavedRun, body: SolveRequestBody | null) => {
      stopCurrent();
      const abort = new AbortController();
      abortRef.current = abort;
      saveRun(run);
      const persist = () => saveRun(run);

      // Finished solutions, kept here as well as in state so the judge step
      // can read them without waiting on a render.
      const solutions = new Map<ProviderKey, ProviderArtifact>();
      const update = (provider: ProviderKey, next: ProviderRun) => {
        if (next.status === "done") solutions.set(provider, next.solution);
        setRuns((current) => ({ ...current, [provider]: next }));
      };

      void (async () => {
        await runPool(run.providers, SOLVE_CONCURRENCY, async (provider) => {
          const known = run.solveJobs[provider];
          if (body === null && !known) {
            update(provider, {
              status: "error",
              message: "This solve had not reached the server when the page closed. Start it again.",
            });
            return;
          }
          const handle = jobHandle(known ?? null);
          handlesRef.current.push(handle);
          const onJob = (id: string) => {
            run.solveJobs[provider] = id;
            persist();
          };
          try {
            // A dropped connection - on a phone, usually the browser being
            // put in the background - re-attaches to this provider's job once
            // the page is visible again (see withResume).
            await withResume(
              () => streamProvider(provider, body, abort.signal, update, handle, onJob),
              handle,
              abort.signal,
              (message) => update(provider, { status: "waiting", message }),
            );
          } catch (error) {
            if (abort.signal.aborted) return;
            update(provider, {
              status: "error",
              message: isConnectionLost(error)
                ? `${UNREACHABLE} the solution (kept for 24 hours).`
                : error instanceof Error
                  ? error.message
                  : "The solve request failed.",
            });
          }
        });

        if (!run.judge || abort.signal.aborted) return;
        await runJudge(run, body, solutions, abort.signal, setJudgeRun, handlesRef.current, persist);
      })();
    },
    [stopCurrent],
  );

  const start = useCallback(
    (providers: ProviderKey[], body: SolveRequestBody, judge: ProviderKey | null = null) => {
      setRuns(waitingRuns(providers, "Submitting..."));
      setJudgeRun(
        judge
          ? { status: "waiting", judge, message: "Waiting for the solutions..." }
          : { status: "idle" },
      );
      execute(
        { savedAt: Date.now(), providers, solveJobs: {}, judge: judge ? { provider: judge } : null },
        body,
      );
    },
    [execute],
  );

  /**
   * Picks the last run back up after the page was reloaded - its jobs kept
   * running on the server. Returns whether there was one to restore.
   */
  const restore = useCallback((): boolean => {
    const run = loadRun();
    if (!run || !run.providers.length) return false;
    setRuns(waitingRuns(run.providers, "Reconnecting to your last run..."));
    setJudgeRun(
      run.judge
        ? { status: "waiting", judge: run.judge.provider, message: "Reconnecting..." }
        : { status: "idle" },
    );
    execute(run, null);
    return true;
  }, [execute]);

  return { runs, judgeRun, start, cancel, restore, dismiss };
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once.
 * Resolves when every item has been processed.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: lanes }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * One attempt at one provider: re-attaches to its job if the handle has one,
 * otherwise starts it. Resolves once the server sent a terminal event -
 * `done` or `error`, both already reflected through `update`. Throws when
 * the connection is lost (a network error, or a stream that closed without
 * a terminal event), which is the caller's cue to resume.
 */
async function streamProvider(
  provider: ProviderKey,
  body: SolveRequestBody | null,
  signal: AbortSignal,
  update: (provider: ProviderKey, run: ProviderRun) => void,
  handle: JobHandle,
  onJob: (id: string) => void,
): Promise<"done" | "error"> {
  let charsReceived = 0;
  const stream = await openTaskStream(handle, `/api/solve/${provider}`, body, signal);
  let outcome: "done" | "error" | null = null;

  for await (const event of readSseEvents(stream)) {
    if (takeJobEvent(handle, event, onJob)) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.name === "status" && typeof payload.message === "string") {
      // Every status precedes a fresh attempt (or a re-attach). After partial
      // output that means the Worker discarded a useless fragment and is
      // retrying, so the count starts over rather than continuing from the
      // discarded text.
      charsReceived = 0;
      update(provider, { status: "waiting", message: payload.message });
    } else if (event.name === "delta" && typeof payload.text === "string") {
      charsReceived += payload.text.length;
      update(provider, { status: "streaming", charsReceived });
    } else if (
      event.name === "done" &&
      payload.solution &&
      typeof payload.solution === "object"
    ) {
      outcome = "done";
      update(provider, {
        status: "done",
        solution: payload.solution as ProviderArtifact,
      });
    } else if (event.name === "error" && typeof payload.message === "string") {
      outcome = "error";
      update(provider, { status: "error", message: payload.message });
    }
  }

  // No terminal event: the stream closed mid-flight. The caller owns the
  // final state, so a restart is not preceded by a flash of error.
  if (!outcome) {
    throw new StreamInterruptedError(
      `${PROVIDER_LABELS[provider]}: the stream ended before the solution arrived.`,
    );
  }
  return outcome;
}

/**
 * The cross-check's last step: every finished solution, flattened to text,
 * goes to the judge with the same images (and confirmed interpretation, if
 * any). The judge sees them as Solution A, B, C... in picker order. A solver
 * that returned nothing is left out and named in the result; fewer than two
 * solutions is nothing to compare.
 *
 * A judge that was already sent before the page reloaded is re-attached to,
 * with the solver order recorded when it was sent. One that was not cannot
 * be sent after a reload: it needs the images, and they are not kept.
 */
async function runJudge(
  run: SavedRun,
  body: SolveRequestBody | null,
  solutions: Map<ProviderKey, ProviderArtifact>,
  signal: AbortSignal,
  setJudgeRun: (run: JudgeRun) => void,
  handles: JobHandle[],
  persist: () => void,
) {
  const saved = run.judge;
  if (!saved) return;
  const judge = saved.provider;
  const handle = jobHandle(saved.jobId ?? null);

  let solvers: ProviderKey[];
  let skipped: ProviderKey[];
  let judgeBody: JudgeRequestBody | null = null;

  if (handle.id) {
    solvers = saved.solvers ?? [];
    skipped = saved.skipped ?? [];
  } else {
    if (body === null) {
      setJudgeRun({
        status: "error",
        judge,
        message:
          "The cross-check had not started when the page closed, and it needs the uploaded images, which are not kept. Upload again to cross-check.",
      });
      return;
    }
    solvers = run.providers.filter((provider) => solutions.has(provider)).slice(0, MAX_JUDGED_SOLUTIONS);
    skipped = run.providers.filter((provider) => !solutions.has(provider));
    if (solvers.length < 2) {
      setJudgeRun({
        status: "error",
        judge,
        message: `Cross-check skipped: ${skipped.map((p) => PROVIDER_LABELS[p]).join(" and ") || "a solver"} did not return a solution, leaving fewer than two to compare.`,
      });
      return;
    }

    judgeBody = {
      images: body.images,
      notes: body.notes,
      ...(body.interpretation ? { interpretation: body.interpretation } : {}),
      solutions: solvers.map((provider) =>
        artifactToText(solutions.get(provider) as ProviderArtifact, MAX_SOLUTION_TEXT),
      ),
    };
    if (estimateBodyBytes(judgeBody) > MAX_BODY_BYTES) {
      setJudgeRun({
        status: "error",
        judge,
        message: "Cross-check skipped: the images plus the solutions exceed the request size limit.",
      });
      return;
    }
    saved.solvers = solvers;
    saved.skipped = skipped;
    persist();
    setJudgeRun({ status: "waiting", judge, message: `Submitting ${solvers.length} solutions...` });
  }

  handles.push(handle);
  const onJob = (id: string) => {
    saved.jobId = id;
    persist();
  };

  const attempt = async () => {
    let charsReceived = 0;
    const stream = await openTaskStream(handle, `/api/judge/${judge}`, judgeBody, signal);
    let terminal = false;

    for await (const event of readSseEvents(stream)) {
      if (takeJobEvent(handle, event, onJob)) continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.name === "status" && typeof payload.message === "string") {
        charsReceived = 0;
        setJudgeRun({ status: "waiting", judge, message: payload.message });
      } else if (event.name === "delta" && typeof payload.text === "string") {
        charsReceived += payload.text.length;
        setJudgeRun({ status: "streaming", judge, charsReceived });
      } else if (
        event.name === "done" &&
        payload.judgement &&
        typeof payload.judgement === "object"
      ) {
        terminal = true;
        setJudgeRun({
          status: "done",
          judge,
          solvers,
          skipped,
          judgement: payload.judgement as JudgementResult,
        });
      } else if (event.name === "error" && typeof payload.message === "string") {
        terminal = true;
        setJudgeRun({ status: "error", judge, message: payload.message });
      }
    }

    if (!terminal) {
      throw new StreamInterruptedError("The cross-check stream ended before the verdict arrived.");
    }
  };

  try {
    await withResume(attempt, handle, signal, (message) =>
      setJudgeRun({ status: "waiting", judge, message }),
    );
  } catch (error) {
    if (signal.aborted) return;
    setJudgeRun({
      status: "error",
      judge,
      message: isConnectionLost(error)
        ? `${UNREACHABLE} the verdict (kept for 24 hours).`
        : error instanceof Error
          ? error.message
          : "The cross-check request failed.",
    });
  }
}
