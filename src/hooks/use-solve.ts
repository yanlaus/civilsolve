// Per-provider solve state machine over the app-level SSE protocol.
// Fires one streaming POST per selected provider, all at once; each tab
// progresses independently (spinner -> live progress -> rendered solution).
// With the optional answer cross-check, a judge then grades every finished
// solution against the images.

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
import { fetchSseStream, readSseEvents } from "@/lib/sse";

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

export function useSolve() {
  const [runs, setRuns] = useState<ProviderRuns>(IDLE_RUNS);
  const [judgeRun, setJudgeRun] = useState<JudgeRun>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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
  }, []);

  const start = useCallback(
    (providers: ProviderKey[], body: SolveRequestBody, judge: ProviderKey | null = null) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setRuns(() => {
        const next: ProviderRuns = { ...IDLE_RUNS };
        for (const provider of providers) {
          next[provider] = { status: "waiting", message: "Submitting..." };
        }
        return next;
      });
      setJudgeRun(
        judge
          ? { status: "waiting", judge, message: "Waiting for the solutions..." }
          : { status: "idle" },
      );

      // Finished solutions, kept here as well as in state so the judge step
      // can read them without waiting on a render.
      const solutions = new Map<ProviderKey, ProviderArtifact>();
      const update = (provider: ProviderKey, run: ProviderRun) => {
        if (run.status === "done") solutions.set(provider, run.solution);
        setRuns((current) => ({ ...current, [provider]: run }));
      };

      void (async () => {
        const interrupted: ProviderKey[] = [];
        await runPool(providers, SOLVE_CONCURRENCY, async (provider) => {
          const outcome = await streamProvider(provider, body, abort.signal, update);
          if (outcome === "interrupted" && !abort.signal.aborted) {
            // A stream that closed with no `done` and no `error` was almost
            // certainly killed server side (the isolate is gone, so the
            // Worker cannot send an error). Leave an honest waiting state
            // and retry later.
            update(provider, {
              status: "waiting",
              message: "Interrupted by server load — will retry shortly.",
            });
            interrupted.push(provider);
          }
        });

        // Retries run one at a time, after the wave, so they never stack on
        // top of whatever overloaded the server the first time.
        await runPool(interrupted, 1, async (provider) => {
          if (abort.signal.aborted) return;
          update(provider, {
            status: "waiting",
            message: "Interrupted by server load — retrying...",
          });
          const retry = await streamProvider(provider, body, abort.signal, update);
          if (retry === "interrupted" && !abort.signal.aborted) {
            update(provider, {
              status: "error",
              message:
                "The server ran out of capacity for this provider. Try again, or run fewer at once.",
            });
          }
        });

        if (!judge || abort.signal.aborted) return;
        await runJudge(judge, providers, solutions, body, abort.signal, setJudgeRun);
      })();
    },
    [],
  );

  return { runs, judgeRun, start, cancel };
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

/** How one attempt ended, so the caller can decide whether to retry. */
type StreamOutcome = "done" | "error" | "interrupted" | "aborted";

async function streamProvider(
  provider: ProviderKey,
  body: SolveRequestBody,
  signal: AbortSignal,
  update: (provider: ProviderKey, run: ProviderRun) => void,
): Promise<StreamOutcome> {
  let charsReceived = 0;

  try {
    const stream = await fetchSseStream(`/api/solve/${provider}`, body, signal);
    let outcome: StreamOutcome | null = null;

    for await (const event of readSseEvents(stream)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.name === "status" && typeof payload.message === "string") {
        // Every status precedes a fresh attempt. After partial output that
        // means the Worker discarded a useless fragment and is retrying, so
        // the count starts over rather than continuing from the discarded text.
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

    // No terminal event: the stream closed mid-flight. The caller may retry;
    // it owns the final state so a retry is not preceded by a flash of error.
    return outcome ?? "interrupted";
  } catch (error) {
    if (signal.aborted) return "aborted";
    update(provider, {
      status: "error",
      message: error instanceof Error ? error.message : "The solve request failed.",
    });
    return "error";
  }
}

/**
 * The cross-check's last step: every finished solution, flattened to text,
 * goes to the judge with the same images (and confirmed interpretation, if
 * any). The judge sees them as Solution A, B, C... in picker order. A solver
 * that returned nothing is left out and named in the result; fewer than two
 * solutions is nothing to compare.
 */
async function runJudge(
  judge: ProviderKey,
  providers: ProviderKey[],
  solutions: Map<ProviderKey, ProviderArtifact>,
  body: SolveRequestBody,
  signal: AbortSignal,
  setJudgeRun: (run: JudgeRun) => void,
) {
  const solvers = providers.filter((provider) => solutions.has(provider)).slice(0, MAX_JUDGED_SOLUTIONS);
  const skipped = providers.filter((provider) => !solutions.has(provider));
  if (solvers.length < 2) {
    setJudgeRun({
      status: "error",
      judge,
      message: `Cross-check skipped: ${skipped.map((p) => PROVIDER_LABELS[p]).join(" and ") || "a solver"} did not return a solution, leaving fewer than two to compare.`,
    });
    return;
  }

  const judgeBody: JudgeRequestBody = {
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

  setJudgeRun({
    status: "waiting",
    judge,
    message: `Submitting ${solvers.length} solutions...`,
  });
  let charsReceived = 0;

  try {
    const stream = await fetchSseStream(`/api/judge/${judge}`, judgeBody, signal);
    let terminal = false;

    for await (const event of readSseEvents(stream)) {
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
      setJudgeRun({
        status: "error",
        judge,
        message: "The cross-check stream ended unexpectedly. Try again.",
      });
    }
  } catch (error) {
    if (signal.aborted) return;
    setJudgeRun({
      status: "error",
      judge,
      message: error instanceof Error ? error.message : "The cross-check request failed.",
    });
  }
}
