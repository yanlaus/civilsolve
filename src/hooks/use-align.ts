// The answers compared with each other (9 October 2026, the owner's call):
// once every solver has answered, their final answers go to a model
// (POST /api/align/:provider, DEFAULT_ALIGNER at "low") that says how each
// lines up with the others - shown in the answer summary at once, without
// waiting for, or starting, the cross-check. It runs again when the
// answers change (a solver added, retried or re-generated) and none is
// still running.
//
// Only for answers sent from this page: a run picked back up after a reload
// re-attaches to a comparison already sent (its job id is kept in
// localStorage), and sends nothing new (CLAUDE.md: nothing is sent on page
// load).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AlignResult } from "../../shared/align";
import { DEFAULT_ALIGNER, PROVIDER_KEYS, type ProviderKey } from "../../shared/providers";
import {
  MAX_ALIGN_ANSWER_TEXT,
  MAX_ALIGN_ANSWERS,
  MAX_ALIGN_QUESTION_TEXT,
  type AlignRequestBody,
  type SolveRequestBody,
} from "../../shared/stream-protocol";
import { isRunActive, type ConfirmedInterpretation, type ProviderRuns } from "@/hooks/use-solve";
import {
  jobHandle,
  openTaskStream,
  readSseEvents,
  stopTask,
  StreamInterruptedError,
  takeJobEvent,
  withResume,
  type JobHandle,
} from "@/lib/sse";

export type AlignState =
  | { status: "idle" }
  | { status: "running"; solvers: ProviderKey[]; signature: string }
  | { status: "done"; solvers: ProviderKey[]; signature: string; comparison: AlignResult }
  | { status: "error"; solvers: ProviderKey[]; signature: string; message: string };

const STORE_KEY = "civilsolve:last-align";

type SavedAlign = { runId: number; jobId: string; solvers: ProviderKey[]; signature: string };

function loadAlign(runId: number): SavedAlign | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as SavedAlign | null;
    return saved && saved.runId === runId && saved.jobId && Array.isArray(saved.solvers) ? saved : null;
  } catch {
    return null;
  }
}

function saveAlign(saved: SavedAlign | null) {
  try {
    if (saved) window.localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    else window.localStorage.removeItem(STORE_KEY);
  } catch {
    // Only the pick-up after a reload is lost.
  }
}

/** A short fingerprint of a text, so a changed answer is told apart from the one compared. */
function fingerprint(text: string) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/** The finished solvers, in picker order, and what their answers are now. */
function finishedOf(runs: ProviderRuns) {
  const solvers = PROVIDER_KEYS.filter((key) => runs[key].status === "done").slice(0, MAX_ALIGN_ANSWERS);
  const signature = solvers
    .map((key) => {
      const run = runs[key];
      return run.status === "done" ? `${key}:${fingerprint(run.solution.finalAnswer)}` : key;
    })
    .join("|");
  return { solvers, signature };
}

type Running = { handle: JobHandle; abort: AbortController };

export function useAlign({
  runId,
  runs,
  interpretation,
  sentHere,
  getBody,
}: {
  runId: number | null;
  runs: ProviderRuns;
  interpretation: ConfirmedInterpretation | null;
  /** Whether this run's answers were sent from this page (not only picked back up after a reload). */
  sentHere: boolean;
  getBody: () => SolveRequestBody | null;
}) {
  const [state, setState] = useState<AlignState>({ status: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef<Running | null>(null);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  /** Sends a comparison (body) or re-attaches to its job (body null). */
  const run = useCallback(
    async (solvers: ProviderKey[], signature: string, body: AlignRequestBody | null, jobId: string | null) => {
      runningRef.current?.abort.abort();
      const handle = jobHandle(jobId);
      const abort = new AbortController();
      runningRef.current = { handle, abort };
      const owner = runIdRef.current;
      const live = () => !abort.signal.aborted && !handle.stopped && runIdRef.current === owner;
      setState({ status: "running", solvers, signature });
      const attempt = async () => {
        const stream = await openTaskStream(handle, `/api/align/${DEFAULT_ALIGNER.provider}`, body, abort.signal);
        let terminal = false;
        for await (const event of readSseEvents(stream)) {
          if (
            takeJobEvent(handle, event, (id) => {
              if (owner !== null) saveAlign({ runId: owner, jobId: id, solvers, signature });
            })
          ) {
            continue;
          }
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.name === "done" && payload.comparison && typeof payload.comparison === "object") {
            terminal = true;
            if (live()) {
              setState({ status: "done", solvers, signature, comparison: payload.comparison as AlignResult });
            }
          } else if (event.name === "error" && typeof payload.message === "string") {
            terminal = true;
            if (live()) setState({ status: "error", solvers, signature, message: payload.message });
          }
        }
        if (!terminal) throw new StreamInterruptedError("The comparison's stream ended before it arrived.");
      };
      try {
        await withResume(attempt, handle, abort.signal, () => undefined);
      } catch (error) {
        if (live()) {
          setState({
            status: "error",
            solvers,
            signature,
            message: error instanceof Error ? error.message : "The answers could not be compared.",
          });
        }
      } finally {
        if (runningRef.current?.abort === abort) runningRef.current = null;
      }
    },
    [],
  );

  /** Compares the answers on the page now. */
  const compare = useCallback(() => {
    const { solvers, signature } = finishedOf(runs);
    if (solvers.length < 2) return;
    const body = getBody();
    // What was asked, in words: the confirmed reading, else the first
    // solver's restatement of the problem.
    const first = runs[solvers[0]];
    const question = interpretation?.text || (first.status === "done" ? first.solution.interpretedProblem : "");
    const sent: AlignRequestBody = {
      answers: solvers.map((key) => {
        const current = runs[key];
        return current.status === "done" ? current.solution.finalAnswer.slice(0, MAX_ALIGN_ANSWER_TEXT) : "";
      }),
      ...(question ? { question: question.slice(0, MAX_ALIGN_QUESTION_TEXT) } : {}),
      notes: body?.notes ?? "",
      effort: "low",
    };
    void run(solvers, signature, sent, null);
  }, [runs, interpretation, getBody, run]);

  // A new run (or none) starts afresh; the same run after a reload picks up
  // a comparison already sent.
  useEffect(() => {
    if (runningRef.current) stopTask(runningRef.current.handle, runningRef.current.abort);
    runningRef.current = null;
    setState({ status: "idle" });
    if (runId === null) return;
    const saved = loadAlign(runId);
    if (saved) void run(saved.solvers, saved.signature, null, saved.jobId);
  }, [runId, run]);

  // Every solver has answered - or the answers changed since they were
  // compared - and none is still running: compare them, once per set.
  const { solvers, signature } = finishedOf(runs);
  const anyRunning = Object.values(runs).some(isRunActive);
  useEffect(() => {
    if (runId === null || !sentHere || anyRunning || solvers.length < 2) return;
    const current = stateRef.current;
    if (current.status !== "idle" && current.signature === signature) return;
    compare();
    // `compare` reads the latest runs itself; the signature says when they changed.
  }, [runId, sentHere, anyRunning, signature]);

  return { alignment: state, compareAgain: compare };
}
