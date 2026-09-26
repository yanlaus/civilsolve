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
//
// The request body the run was sent with - the page images above all - is
// kept too: in memory, and in this browser's IndexedDB (lib/upload-store.ts)
// so it survives a reload. With it a failed solver can be retried, another
// solver added, and the cross-check run (or run again) after the fact,
// without uploading again.

import { useCallback, useRef, useState } from "react";
import { MAX_JUDGED_SOLUTIONS, type JudgementResult } from "../../shared/judgement";
import {
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  type ModelChoice,
  type ModelVariant,
  type ProviderKey,
} from "../../shared/providers";
import type { EffortKey } from "../../shared/prompt";
import { artifactToText, type ProviderArtifact } from "../../shared/solution";
import {
  estimateBodyBytes,
  MAX_BODY_BYTES,
  MAX_SOLUTION_TEXT,
  type JudgeRequestBody,
  type SolveRequestBody,
} from "../../shared/stream-protocol";
import { trackProgress, type Progress, type ProgressTracker } from "@/lib/progress";
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
import { clearBody, loadBody, saveBody } from "@/lib/upload-store";

// Shown once withResume has tried for RECONNECT_WINDOW_MS. The job itself
// kept running on the server, and its id is saved, so a reload re-attaches.
const UNREACHABLE =
  "Could not reach the server for 2 minutes. The model keeps working there - reload this page to pick up";

export type ProviderRun =
  | { status: "idle" }
  | { status: "waiting"; message: string }
  | { status: "streaming"; charsReceived: number }
  /** `model`: the model that answered - after a switch down a chain, not the one picked. */
  | { status: "done"; solution: ProviderArtifact; model?: string }
  /** `timedOut`: the task ran out of time and returned nothing (an orange dot, not red). */
  | { status: "error"; message: string; timedOut?: boolean };

export type ProviderRuns = Record<ProviderKey, ProviderRun>;

/** Each running or finished solver's timeline (lib/progress.ts). */
export type ProgressMap = Partial<Record<ProviderKey, Progress>>;

/**
 * The model picked for each provider in the run that offers several (Gemini
 * Flash or Pro), for the solvers and for the judge - so tabs and the verdict
 * can say which one answered.
 */
export type RunVariants = {
  solvers: Partial<Record<ProviderKey, ModelVariant>>;
  judge?: ModelVariant;
  /** The thinking level the judge was asked for. */
  judgeEffort?: EffortKey;
};

function variantsOf(run: SavedRun): RunVariants {
  return {
    solvers: { ...(run.variants ?? {}) },
    judge: run.judge?.variant,
    judgeEffort: run.judge?.effort,
  };
}

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
  | { status: "error"; judge: ProviderKey; message: string; timedOut?: boolean };

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

/**
 * What one piece of work belongs to: the run it records its job ids in, the
 * signal Stop aborts, and the finished solutions the judge will read.
 */
type RunContext = {
  run: SavedRun;
  signal: AbortSignal;
  solutions: Map<ProviderKey, ProviderArtifact>;
};

export function useSolve() {
  const [runs, setRuns] = useState<ProviderRuns>(IDLE_RUNS);
  const [judgeRun, setJudgeRun] = useState<JudgeRun>({ status: "idle" });
  const [progress, setProgress] = useState<ProgressMap>({});
  const [judgeProgress, setJudgeProgress] = useState<Progress | null>(null);
  const [variants, setVariants] = useState<RunVariants>({ solvers: {} });
  /** Whether the run's request body is at hand, so it can be sent again. */
  const [canRerun, setCanRerun] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Every job of the current run, so Stop can cancel them on the server. */
  const handlesRef = useRef<JobHandle[]>([]);
  const runRef = useRef<SavedRun | null>(null);
  const bodyRef = useRef<SolveRequestBody | null>(null);
  /** The run (by savedAt) whose body is already in IndexedDB. */
  const bodySavedRef = useRef<number | null>(null);
  const solutionsRef = useRef(new Map<ProviderKey, ProviderArtifact>());
  /** Bumped by every new run, so a restore still loading its body stands down. */
  const generationRef = useRef(0);

  const setBody = useCallback((body: SolveRequestBody | null) => {
    bodyRef.current = body;
    setCanRerun(body !== null);
  }, []);

  /** The signal of the work in progress, or a fresh one after Stop. */
  const currentSignal = useCallback(() => {
    if (!abortRef.current || abortRef.current.signal.aborted) {
      abortRef.current = new AbortController();
    }
    return abortRef.current.signal;
  }, []);

  /** Saves the current run's job ids, and its body the first time. */
  const persist = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    saveRun(run);
    const body = bodyRef.current;
    if (body && bodySavedRef.current !== run.savedAt) {
      bodySavedRef.current = run.savedAt;
      void saveBody(run.savedAt, body);
    }
  }, []);

  /** Ends this page's part of the current run and stops its jobs server side. */
  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    for (const handle of handlesRef.current) cancelJob(handle);
    handlesRef.current = [];
  }, []);

  /**
   * Stop: cancels everything still running. The run is forgotten by this
   * browser's storage, as before, but stays on the page with its body in
   * memory, so a cancelled solver can still be retried from here.
   */
  const cancel = useCallback(() => {
    stopCurrent();
    clearRun();
    void clearBody();
    bodySavedRef.current = null;
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

  /** Clears the page and forgets the saved run and its images (after a recovery, say). */
  const dismiss = useCallback(() => {
    generationRef.current += 1;
    stopCurrent();
    clearRun();
    void clearBody();
    bodySavedRef.current = null;
    runRef.current = null;
    setBody(null);
    setRuns(IDLE_RUNS);
    setJudgeRun({ status: "idle" });
    setProgress({});
    setJudgeProgress(null);
    setVariants({ solvers: {} });
  }, [stopCurrent, setBody]);

  /**
   * Runs (or re-attaches to) one solver. `body` is null when nothing may be
   * sent - a run restored after a reload re-attaches to jobs, it does not
   * start new ones on its own - and then a solver that never reached the
   * server says so and waits for a Retry.
   */
  const solveOne = useCallback(
    async (context: RunContext, provider: ProviderKey, body: SolveRequestBody | null) => {
      const { run, signal, solutions } = context;
      const update = (_provider: ProviderKey, next: ProviderRun) => {
        if (signal.aborted) return;
        if (next.status === "done") solutions.set(provider, next.solution);
        setRuns((current) => ({ ...current, [provider]: next }));
      };

      const known = run.solveJobs[provider];
      if (body === null && !known) {
        update(provider, {
          status: "error",
          message: "This solve had not reached the server when the page closed.",
        });
        return;
      }
      const handle = jobHandle(known ?? null);
      handlesRef.current.push(handle);
      const onJob = (id: string) => {
        run.solveJobs[provider] = id;
        persist();
      };
      // The one field that differs per provider: which of its models to run.
      const variant = run.variants?.[provider];
      const sent = body && variant ? { ...body, variant } : body;
      const tracker = trackProgress((next) => {
        if (!signal.aborted) setProgress((current) => ({ ...current, [provider]: next }));
      });
      try {
        // A dropped connection - on a phone, usually the browser being put
        // in the background - re-attaches to this provider's job once the
        // page is visible again (see withResume).
        await withResume(
          () => streamProvider(provider, sent, signal, update, handle, onJob, tracker),
          handle,
          signal,
          (message) => {
            tracker.note(message);
            update(provider, { status: "waiting", message });
          },
        );
      } catch (error) {
        if (signal.aborted) return;
        tracker.end();
        update(provider, {
          status: "error",
          message: isConnectionLost(error)
            ? `${UNREACHABLE} the solution (kept for 24 hours).`
            : error instanceof Error
              ? error.message
              : "The solve request failed.",
        });
      }
    },
    [persist],
  );

  /** Sends (or re-attaches to) the run's cross-check; `chosen` picks the solutions. */
  const judgeOne = useCallback(
    (context: RunContext, body: SolveRequestBody | null, chosen?: ProviderKey[]) =>
      runJudge({
        ...context,
        body,
        chosen,
        canSendLater: bodyRef.current !== null,
        handles: handlesRef.current,
        persist,
        setJudgeRun: (next) => {
          if (!context.signal.aborted) setJudgeRun(next);
        },
        setJudgeProgress: (next) => {
          if (!context.signal.aborted) setJudgeProgress(next);
        },
      }),
    [persist],
  );

  /**
   * Runs (or re-attaches to) every solver of `run`, then its judge. `body`
   * is null for a run restored after a reload: jobs are re-attached to,
   * never started, until the user asks.
   */
  const execute = useCallback(
    (run: SavedRun, body: SolveRequestBody | null) => {
      generationRef.current += 1;
      stopCurrent();
      const signal = currentSignal();
      runRef.current = run;
      solutionsRef.current = new Map();
      const context: RunContext = { run, signal, solutions: solutionsRef.current };
      persist();
      setProgress({});
      setJudgeProgress(null);
      setVariants(variantsOf(run));

      void (async () => {
        // A copy: a solver added while these run is started on its own.
        await runPool([...run.providers], SOLVE_CONCURRENCY, (provider) =>
          solveOne(context, provider, body),
        );
        if (!run.judge || signal.aborted) return;
        await judgeOne(context, body);
      })();
    },
    [stopCurrent, currentSignal, persist, solveOne, judgeOne],
  );

  const start = useCallback(
    (
      providers: ProviderKey[],
      body: SolveRequestBody,
      judge: ModelChoice | null = null,
      picked: Partial<Record<ProviderKey, ModelVariant>> = {},
    ) => {
      setRuns(waitingRuns(providers, "Submitting..."));
      setJudgeRun(
        judge
          ? { status: "waiting", judge: judge.provider, message: "Waiting for the solutions..." }
          : { status: "idle" },
      );
      bodySavedRef.current = null;
      setBody(body);
      execute(
        {
          savedAt: Date.now(),
          providers,
          solveJobs: {},
          judge: judge ? { provider: judge.provider, variant: judge.variant } : null,
          variants: Object.fromEntries(
            providers.filter((provider) => picked[provider]).map((provider) => [provider, picked[provider]]),
          ),
        },
        body,
      );
    },
    [execute, setBody],
  );

  /**
   * Picks the last run back up after the page was reloaded - its jobs kept
   * running on the server - together with its images, if this browser still
   * has them. Returns whether there was a run to restore.
   */
  const restore = useCallback((): boolean => {
    const run = loadRun();
    if (!run || !run.providers.length) {
      // Images left behind by a run that is gone are of no use to anyone.
      void clearBody();
      return false;
    }
    setRuns(waitingRuns(run.providers, "Reconnecting to your last run..."));
    setJudgeRun(
      run.judge
        ? { status: "waiting", judge: run.judge.provider, message: "Reconnecting..." }
        : { status: "idle" },
    );
    const generation = ++generationRef.current;
    void loadBody(run.savedAt).then((body) => {
      if (generationRef.current !== generation) return;
      bodySavedRef.current = body ? run.savedAt : null;
      setBody(body);
      execute(run, null);
    });
    return true;
  }, [execute, setBody]);

  /**
   * Solves with one provider on the run's body: a retry of a solver that
   * failed, timed out or was cancelled, or a solver added after the run.
   * The others are left as they are.
   */
  const solveProvider = useCallback(
    (provider: ProviderKey, variant?: ModelVariant) => {
      const run = runRef.current;
      const body = bodyRef.current;
      if (!run || !body) return;
      const signal = currentSignal();
      if (!run.providers.includes(provider)) {
        run.providers = PROVIDER_KEYS.filter((key) => key === provider || run.providers.includes(key));
      }
      // A retry keeps the model it had; a solver added picks its own.
      if (variant) {
        run.variants = { ...run.variants, [provider]: variant };
        setVariants(variantsOf(run));
      }
      delete run.solveJobs[provider];
      solutionsRef.current.delete(provider);
      persist();
      setRuns((current) => ({ ...current, [provider]: { status: "waiting", message: "Submitting..." } }));
      void solveOne({ run, signal, solutions: solutionsRef.current }, provider, body);
    },
    [currentSignal, persist, solveOne],
  );

  /**
   * Runs the cross-check now, over the chosen finished solutions (two to
   * MAX_JUDGED_SOLUTIONS, in picker order): one that was not switched on,
   * that failed, or whose verdict predates a solver added since.
   */
  const crossCheck = useCallback(
    (judge: ModelChoice, providers: ProviderKey[], effort: EffortKey = "high") => {
      const run = runRef.current;
      const body = bodyRef.current;
      if (!run || !body) return;
      const signal = currentSignal();
      run.judge = { provider: judge.provider, variant: judge.variant, effort };
      setVariants(variantsOf(run));
      persist();
      setJudgeRun({ status: "waiting", judge: judge.provider, message: "Submitting..." });
      void judgeOne({ run, signal, solutions: solutionsRef.current }, body, providers);
    },
    [currentSignal, persist, judgeOne],
  );

  return {
    runs,
    judgeRun,
    progress,
    judgeProgress,
    variants,
    canRerun,
    start,
    cancel,
    restore,
    dismiss,
    solveProvider,
    crossCheck,
  };
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
  tracker: ProgressTracker,
): Promise<"done" | "error"> {
  let charsReceived = 0;
  const stream = await openTaskStream(handle, `/api/solve/${provider}`, body, signal);
  let outcome: "done" | "error" | null = null;

  for await (const event of readSseEvents(stream)) {
    if (takeJobEvent(handle, event, onJob)) {
      tracker.job(handle);
      continue;
    }
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
      tracker.status(payload.message, payload.at);
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
      tracker.end(payload.at);
      update(provider, {
        status: "done",
        solution: payload.solution as ProviderArtifact,
        ...(typeof payload.model === "string" && payload.model ? { model: payload.model } : {}),
      });
    } else if (event.name === "error" && typeof payload.message === "string") {
      outcome = "error";
      tracker.end(payload.at);
      update(provider, {
        status: "error",
        message: payload.message,
        ...(payload.timedOut === true ? { timedOut: true } : {}),
      });
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

type JudgeParams = RunContext & {
  /** Null when nothing may be sent: a restored run only re-attaches. */
  body: SolveRequestBody | null;
  /** The solutions to grade, when the user picked them; otherwise the first finished ones. */
  chosen?: ProviderKey[];
  /** Whether the page could send the check itself later (its images are at hand). */
  canSendLater: boolean;
  handles: JobHandle[];
  persist: () => void;
  setJudgeRun: (run: JudgeRun) => void;
  setJudgeProgress: (progress: Progress) => void;
};

/**
 * The cross-check's last step: every finished solution, flattened to text,
 * goes to the judge with the same images (and confirmed interpretation, if
 * any). The judge sees them as Solution A, B, C... in picker order. A solver
 * that returned nothing is left out and named in the result; fewer than two
 * solutions is nothing to compare.
 *
 * A judge that was already sent before the page reloaded is re-attached to,
 * with the solver order recorded when it was sent. One that was not is not
 * sent by a restore on its own; the page offers to run it when it still has
 * the images.
 */
async function runJudge({
  run,
  body,
  solutions,
  signal,
  chosen,
  canSendLater,
  handles,
  persist,
  setJudgeRun,
  setJudgeProgress,
}: JudgeParams) {
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
        message: canSendLater
          ? "The cross-check had not started when the page closed."
          : "The cross-check had not started when the page closed, and it needs the uploaded images, which this browser no longer has. Upload again to cross-check.",
      });
      return;
    }
    solvers = (chosen ?? run.providers)
      .filter((provider) => solutions.has(provider))
      .slice(0, MAX_JUDGED_SOLUTIONS);
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
      ...(saved.variant ? { variant: saved.variant } : {}),
      ...(saved.effort ? { effort: saved.effort } : {}),
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
  const tracker = trackProgress(setJudgeProgress);

  const attempt = async () => {
    let charsReceived = 0;
    const stream = await openTaskStream(handle, `/api/judge/${judge}`, judgeBody, signal);
    let terminal = false;

    for await (const event of readSseEvents(stream)) {
      if (takeJobEvent(handle, event, onJob)) {
        tracker.job(handle);
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.name === "status" && typeof payload.message === "string") {
        charsReceived = 0;
        tracker.status(payload.message, payload.at);
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
        tracker.end(payload.at);
        setJudgeRun({
          status: "done",
          judge,
          solvers,
          skipped,
          judgement: payload.judgement as JudgementResult,
        });
      } else if (event.name === "error" && typeof payload.message === "string") {
        terminal = true;
        tracker.end(payload.at);
        setJudgeRun({
          status: "error",
          judge,
          message: payload.message,
          ...(payload.timedOut === true ? { timedOut: true } : {}),
        });
      }
    }

    if (!terminal) {
      throw new StreamInterruptedError("The cross-check stream ended before the verdict arrived.");
    }
  };

  try {
    await withResume(attempt, handle, signal, (message) => {
      tracker.note(message);
      setJudgeRun({ status: "waiting", judge, message });
    });
  } catch (error) {
    if (signal.aborted) return;
    tracker.end();
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
