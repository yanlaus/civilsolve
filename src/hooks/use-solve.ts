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
// without uploading again. So is the confirmed interpretation, which the
// page keeps above the solutions.
//
// Every solver and the judge can be stopped on its own (stopProvider,
// stopJudge), the rest carrying on; cancel() stops them all.
//
// A finished solution or verdict can be asked for again with the user's
// instructions (refineProvider, refineVerdict): the model gets everything the
// first request had, plus its last version and the instructions. The last
// version stays on the page if the re-generation fails or is stopped.

import { useCallback, useRef, useState } from "react";
import {
  judgementToText,
  MAX_JUDGED_SOLUTIONS,
  type JudgementResult,
} from "../../shared/judgement";
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
  type RevisionRequest,
  type SolveRequestBody,
} from "../../shared/stream-protocol";
import { trackProgress, type Progress, type ProgressTracker } from "@/lib/progress";
import { clearRun, loadRun, saveRun, type SavedRun } from "@/lib/run-store";
import {
  cancelJob,
  childController,
  isConnectionLost,
  jobHandle,
  openTaskStream,
  readSseEvents,
  stopTask,
  StreamInterruptedError,
  takeJobEvent,
  withResume,
  type JobHandle,
} from "@/lib/sse";
import { clearBody, loadBody, saveBody, type InterpretationExtras } from "@/lib/upload-store";

// Shown once withResume has tried for RECONNECT_WINDOW_MS. The job itself
// kept running on the server, and its id is saved, so a reload re-attaches.
const UNREACHABLE =
  "Could not reach the server for 2 minutes. The model keeps working there - reload this page to pick up";

/** What the server's job ends with once it was cancelled (worker/run.ts). */
const SERVER_CANCELLED = "Cancelled.";

export type ProviderRun =
  | { status: "idle" }
  | { status: "waiting"; message: string }
  | { status: "streaming"; charsReceived: number }
  /**
   * `model`: the model that answered - after a switch down a chain, not the
   * one picked. `revisedWith`: the user's instructions, when this version was
   * re-generated with them. `notice`: why a re-generation left this version
   * in place (it failed, or was stopped).
   */
  | {
      status: "done";
      solution: ProviderArtifact;
      model?: string;
      revisedWith?: string;
      notice?: string;
    }
  /**
   * `timedOut`: the task ran out of time and returned nothing (an orange dot,
   * not red). `stopped`: the user stopped it (grey) - nothing went wrong.
   */
  | { status: "error"; message: string; timedOut?: boolean; stopped?: boolean };

const STOPPED_RUN: ProviderRun = { status: "error", message: "You stopped this solver.", stopped: true };

/**
 * The confirmed interpretation the run was solved with, kept on the page
 * above the solutions: `text` is the English the solvers got (the body's
 * `interpretation`), the rest is for display only.
 */
export type ConfirmedInterpretation = InterpretationExtras & { text: string };

/**
 * A solver or judge in flight: what its Stop needs to end it. `onStop`, on a
 * re-generation, puts the previous version back instead of showing "stopped".
 */
type RunningTask = {
  handle: JobHandle;
  abort: AbortController;
  tracker: ProgressTracker;
  onStop?: () => void;
};

type DoneRun = Extract<ProviderRun, { status: "done" }>;

/** What a re-generation adds to a request, and the version it falls back to. */
type Refinement<T> = { revision: RevisionRequest; previous: T };

/** Which version of each solver's solution is on the page: 1 for its first answer, +1 per new one. */
export type SolutionVersions = Partial<Record<ProviderKey, number>>;

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
      /** The solutions' versions when they were sent: one re-generated since is not in this verdict. */
      versions?: SolutionVersions;
      revisedWith?: string;
      notice?: string;
    }
  | { status: "error"; judge: ProviderKey; message: string; timedOut?: boolean; stopped?: boolean };

const JUDGE_STOPPED = "You stopped the cross-check.";

type DoneJudge = Extract<JudgeRun, { status: "done" }>;

/** A message to go mid-sentence: "... did not work: HTTP 500. This is ..." */
function withoutFullStop(message: string) {
  return message.trim().replace(/[.。]+$/, "");
}

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
  const [interpretation, setInterpretation] = useState<ConfirmedInterpretation | null>(null);
  const [solutionVersions, setSolutionVersions] = useState<SolutionVersions>({});
  const versionsRef = useRef<SolutionVersions>({});
  /** Each solver's finished version, and the verdict's: what a re-generation starts from. */
  const doneRef = useRef(new Map<ProviderKey, DoneRun>());
  const judgeDoneRef = useRef<DoneJudge | null>(null);
  /** Whether the run's request body is at hand, so it can be sent again. */
  const [canRerun, setCanRerun] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Every job of the current run, so Stop can cancel them on the server. */
  const handlesRef = useRef<JobHandle[]>([]);
  /** Each solver in flight, and the judge, for their own Stop buttons. */
  const tasksRef = useRef(new Map<ProviderKey, RunningTask>());
  const judgeTaskRef = useRef<RunningTask | null>(null);
  const runRef = useRef<SavedRun | null>(null);
  const bodyRef = useRef<SolveRequestBody | null>(null);
  /** The interpretation's display extras, saved with the body. */
  const extrasRef = useRef<InterpretationExtras | undefined>(undefined);
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
      void saveBody(run.savedAt, body, extrasRef.current);
    }
  }, []);

  /** Ends this page's part of the current run and stops its jobs server side. */
  const stopCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    for (const handle of handlesRef.current) cancelJob(handle);
    handlesRef.current = [];
    tasksRef.current = new Map();
    judgeTaskRef.current = null;
  }, []);

  /**
   * Stop: cancels everything still running. The run is forgotten by this
   * browser's storage, as before, but stays on the page with its body in
   * memory, so a cancelled solver can still be retried from here.
   */
  const cancel = useCallback(() => {
    // Their clocks stop where they were, for "stopped after 1:20".
    for (const task of tasksRef.current.values()) task.tracker.end();
    judgeTaskRef.current?.tracker.end();
    // Re-generations in flight go back to the version they started from.
    const restores = [...tasksRef.current.values(), judgeTaskRef.current].flatMap((task) =>
      task?.onStop ? [task.onStop] : [],
    );
    stopCurrent();
    clearRun();
    void clearBody();
    bodySavedRef.current = null;
    setRuns((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as ProviderKey[]) {
        if (isRunActive(next[key])) next[key] = STOPPED_RUN;
      }
      return next;
    });
    setJudgeRun((current) =>
      isJudgeActive(current)
        ? { status: "error", judge: current.judge, message: JUDGE_STOPPED, stopped: true }
        : current,
    );
    for (const restore of restores) restore();
  }, [stopCurrent]);

  /**
   * One solver's Stop: its job ends on the server, its tab says it was
   * stopped (and offers to run it again), and the other solvers carry on.
   */
  const stopProvider = useCallback((provider: ProviderKey) => {
    const task = tasksRef.current.get(provider);
    if (!task) return;
    tasksRef.current.delete(provider);
    task.tracker.end();
    stopTask(task.handle, task.abort);
    if (task.onStop) task.onStop();
    else {
      setRuns((current) =>
        isRunActive(current[provider]) ? { ...current, [provider]: STOPPED_RUN } : current,
      );
    }
  }, []);

  /** The cross-check's Stop: the solutions stay, and it can be run again. */
  const stopJudge = useCallback(() => {
    const task = judgeTaskRef.current;
    if (!task) return;
    judgeTaskRef.current = null;
    task.tracker.end();
    stopTask(task.handle, task.abort);
    if (task.onStop) task.onStop();
    else {
      setJudgeRun((current) =>
        isJudgeActive(current)
          ? { status: "error", judge: current.judge, message: JUDGE_STOPPED, stopped: true }
          : current,
      );
    }
  }, []);

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
    extrasRef.current = undefined;
    setInterpretation(null);
    versionsRef.current = {};
    setSolutionVersions({});
    doneRef.current = new Map();
    judgeDoneRef.current = null;
  }, [stopCurrent, setBody]);

  /**
   * Runs (or re-attaches to) one solver. `body` is null when nothing may be
   * sent - a run restored after a reload re-attaches to jobs, it does not
   * start new ones on its own - and then a solver that never reached the
   * server says so and waits for a Retry.
   */
  const solveOne = useCallback(
    async (
      context: RunContext,
      provider: ProviderKey,
      body: SolveRequestBody | null,
      refinement?: Refinement<DoneRun>,
    ) => {
      const { run, signal, solutions } = context;
      const known = run.solveJobs[provider];
      const handle = jobHandle(known ?? null);
      // Its own controller, so its Stop leaves the other solvers running.
      const own = childController(signal);
      // Nothing more is shown for a solver once it was stopped.
      const live = () => !own.signal.aborted && !handle.stopped;
      // A re-generation that fails leaves the version it started from.
      const previous = refinement ? { ...refinement.previous, notice: undefined } : null;
      const show = (next: ProviderRun) => {
        if (next.status === "done") doneRef.current.set(provider, next);
        setRuns((current) => ({ ...current, [provider]: next }));
      };
      const update = (_provider: ProviderKey, next: ProviderRun) => {
        if (!live()) return;
        if (next.status === "error" && previous) {
          show({
            ...previous,
            notice: next.stopped
              ? "The re-generation was stopped. This is the previous version."
              : `Re-generating did not work: ${withoutFullStop(next.message)}. This is the previous version.`,
          });
          return;
        }
        if (next.status === "done") {
          solutions.set(provider, next.solution);
          versionsRef.current = {
            ...versionsRef.current,
            [provider]: (versionsRef.current[provider] ?? 0) + 1,
          };
          setSolutionVersions(versionsRef.current);
          show(refinement ? { ...next, revisedWith: refinement.revision.instructions } : next);
          return;
        }
        show(next);
      };

      if (body === null && !known) {
        update(provider, {
          status: "error",
          message: "This solve had not reached the server when the page closed.",
        });
        return;
      }
      handlesRef.current.push(handle);
      const onJob = (id: string) => {
        // A job stopped before it was named, and named only after the
        // solver was run again, must not take the new job's place.
        if (handle.stopped && run.solveJobs[provider]) return;
        run.solveJobs[provider] = id;
        persist();
      };
      // The fields that differ per provider: which of its models to run, and
      // for a re-generation, its last version and the user's instructions.
      const variant = run.variants?.[provider];
      const sent = body
        ? {
            ...body,
            ...(variant ? { variant } : {}),
            ...(refinement ? { revision: refinement.revision } : {}),
          }
        : null;
      const tracker = trackProgress((next) => {
        if (live()) setProgress((current) => ({ ...current, [provider]: next }));
      });
      const task: RunningTask = {
        handle,
        abort: own,
        tracker,
        onStop: previous
          ? () =>
              setRuns((current) =>
                isRunActive(current[provider])
                  ? {
                      ...current,
                      [provider]: {
                        ...previous,
                        notice: "You stopped the re-generation. This is the previous version.",
                      },
                    }
                  : current,
              )
          : undefined,
      };
      tasksRef.current.set(provider, task);
      try {
        // A dropped connection - on a phone, usually the browser being put
        // in the background - re-attaches to this provider's job once the
        // page is visible again (see withResume).
        await withResume(
          () => streamProvider(provider, sent, own.signal, update, handle, onJob, tracker),
          handle,
          own.signal,
          (message) => {
            tracker.note(message);
            update(provider, { status: "waiting", message });
          },
        );
      } catch (error) {
        if (!live()) return;
        tracker.end();
        update(provider, {
          status: "error",
          message: isConnectionLost(error)
            ? `${UNREACHABLE} the solution (kept for 24 hours).`
            : error instanceof Error
              ? error.message
              : "The solve request failed.",
        });
      } finally {
        if (tasksRef.current.get(provider) === task) tasksRef.current.delete(provider);
      }
    },
    [persist],
  );

  /** Sends (or re-attaches to) the run's cross-check; `chosen` picks the solutions. */
  const judgeOne = useCallback(
    (
      context: RunContext,
      body: SolveRequestBody | null,
      chosen?: ProviderKey[],
      refinement?: Refinement<DoneJudge>,
    ) => {
      const previous = refinement ? { ...refinement.previous, notice: undefined } : null;
      return runJudge({
        ...context,
        body,
        chosen,
        canSendLater: bodyRef.current !== null,
        handles: handlesRef.current,
        revision: refinement?.revision,
        previous,
        versions: () => ({ ...versionsRef.current }),
        register: (task) => {
          judgeTaskRef.current = {
            ...task,
            onStop: previous
              ? () =>
                  setJudgeRun({
                    ...previous,
                    notice: "You stopped the re-generation. This is the previous verdict.",
                  })
              : undefined,
          };
        },
        persist,
        setJudgeRun: (next) => {
          if (context.signal.aborted) return;
          if (next.status === "done") judgeDoneRef.current = next;
          setJudgeRun(next);
        },
        setJudgeProgress: (next) => {
          if (!context.signal.aborted) setJudgeProgress(next);
        },
      });
    },
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
      doneRef.current = new Map();
      judgeDoneRef.current = null;
      versionsRef.current = {};
      setSolutionVersions({});
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
      extras?: InterpretationExtras,
    ) => {
      setRuns(waitingRuns(providers, "Submitting..."));
      extrasRef.current = body.interpretation ? extras : undefined;
      setInterpretation(body.interpretation ? { ...extras, text: body.interpretation } : null);
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
    void loadBody(run.savedAt).then((stored) => {
      if (generationRef.current !== generation) return;
      const body = stored?.body ?? null;
      bodySavedRef.current = body ? run.savedAt : null;
      extrasRef.current = stored?.extras;
      setInterpretation(
        body?.interpretation ? { ...stored?.extras, text: body.interpretation } : null,
      );
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
   * One finished solution again, with the user's instructions: the same
   * model gets the run's body - images, notes, lecture notes, confirmed
   * reading - plus its last version and the instructions, and writes a
   * complete new version. The last one stays if this fails or is stopped.
   */
  const refineProvider = useCallback(
    (provider: ProviderKey, instructions: string) => {
      const run = runRef.current;
      const body = bodyRef.current;
      const previous = doneRef.current.get(provider);
      const wanted = instructions.trim();
      if (!run || !body || !previous || !wanted) return;
      const signal = currentSignal();
      delete run.solveJobs[provider];
      persist();
      setRuns((current) => ({
        ...current,
        [provider]: { status: "waiting", message: "Sending your instructions..." },
      }));
      void solveOne({ run, signal, solutions: solutionsRef.current }, provider, body, {
        revision: {
          previous: artifactToText(previous.solution, MAX_SOLUTION_TEXT),
          instructions: wanted,
        },
        previous,
      });
    },
    [currentSignal, persist, solveOne],
  );

  /**
   * The verdict again, with the user's instructions: the same judge, at the
   * same level, over the same solvers' solutions as they are now, with its
   * last verdict and the instructions.
   */
  const refineVerdict = useCallback(
    (instructions: string) => {
      const run = runRef.current;
      const body = bodyRef.current;
      const previous = judgeDoneRef.current;
      const wanted = instructions.trim();
      if (!run || !body || !previous || !run.judge || !wanted) return;
      const signal = currentSignal();
      run.judge = { provider: run.judge.provider, variant: run.judge.variant, effort: run.judge.effort };
      persist();
      setJudgeRun({ status: "waiting", judge: previous.judge, message: "Sending your instructions..." });
      void judgeOne({ run, signal, solutions: solutionsRef.current }, body, previous.solvers, {
        revision: {
          previous: judgementToText(previous.judgement, previous.solvers.length),
          instructions: wanted,
        },
        previous,
      });
    },
    [currentSignal, persist, judgeOne],
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
    interpretation,
    solutionVersions,
    canRerun,
    start,
    cancel,
    restore,
    dismiss,
    solveProvider,
    stopProvider,
    refineProvider,
    crossCheck,
    stopJudge,
    refineVerdict,
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
      // A job stopped from this page or another (Stop, then a reload).
      update(
        provider,
        payload.message === SERVER_CANCELLED
          ? STOPPED_RUN
          : {
              status: "error",
              message: payload.message,
              ...(payload.timedOut === true ? { timedOut: true } : {}),
            },
      );
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
  /** Makes the judge's Stop button able to end this check. */
  register: (task: RunningTask) => void;
  /** A re-generation: the last verdict and the user's instructions. */
  revision?: RevisionRequest;
  /** The verdict a failed re-generation falls back to. */
  previous?: DoneJudge | null;
  /** The solutions' versions now, recorded with a verdict that is sent. */
  versions: () => SolutionVersions;
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
  register,
  revision,
  previous,
  versions,
  persist,
  setJudgeRun: publishJudgeRun,
  setJudgeProgress,
}: JudgeParams) {
  const saved = run.judge;
  if (!saved) return;
  const judge = saved.provider;
  const handle = jobHandle(saved.jobId ?? null);
  // Its own controller, so its Stop leaves the solvers alone.
  const own = childController(signal);
  const live = () => !own.signal.aborted && !handle.stopped;
  // Recorded when the check is sent; a re-attached one (after a reload) has none.
  const sentVersions = handle.id ? undefined : versions();
  const setJudgeRun = (next: JudgeRun) => {
    if (!live()) return;
    if (next.status === "error" && previous) {
      publishJudgeRun({
        ...previous,
        notice: next.stopped
          ? "The re-generation was stopped. This is the previous verdict."
          : `Re-generating the verdict did not work: ${withoutFullStop(next.message)}. This is the previous verdict.`,
      });
      return;
    }
    if (next.status === "done") {
      publishJudgeRun({
        ...next,
        ...(sentVersions ? { versions: sentVersions } : {}),
        ...(revision ? { revisedWith: revision.instructions } : {}),
      });
      return;
    }
    publishJudgeRun(next);
  };

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
      ...(revision ? { revision } : {}),
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
  const tracker = trackProgress((next) => {
    if (live()) setJudgeProgress(next);
  });
  register({ handle, abort: own, tracker });

  const attempt = async () => {
    let charsReceived = 0;
    const stream = await openTaskStream(handle, `/api/judge/${judge}`, judgeBody, own.signal);
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
          ...(payload.message === SERVER_CANCELLED
            ? { message: JUDGE_STOPPED, stopped: true }
            : { message: payload.message }),
          ...(payload.timedOut === true ? { timedOut: true } : {}),
        });
      }
    }

    if (!terminal) {
      throw new StreamInterruptedError("The cross-check stream ended before the verdict arrived.");
    }
  };

  try {
    await withResume(attempt, handle, own.signal, (message) => {
      tracker.note(message);
      setJudgeRun({ status: "waiting", judge, message });
    });
  } catch (error) {
    if (!live()) return;
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
