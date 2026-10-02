// "Ask about this step · 問呢一步" (3 October 2026): a student's questions
// about one finished solution, each answered in a job of its own
// (POST /api/ask/:provider), the way study notes are - re-attached after a
// dropped connection or a reload, stopped one at a time. Each solver's
// solution has its own thread; a question goes with the earlier questions
// and answers on that thread, so a follow-up ("why minus?") makes sense.
//
// Kept apart from use-solve.ts, which already holds the run: this hook only
// reads the run's request body (images, notes, confirmed reading) and the
// solution asked about. The thread's job ids are saved for the run in
// localStorage, so a reload picks the answers back up; nothing is sent on
// page load.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AskResult } from "../../shared/ask";
import type { EffortKey } from "../../shared/prompt";
import { PROVIDER_KEYS, type ModelVariant, type ProviderKey } from "../../shared/providers";
import { artifactToText, type ProviderArtifact } from "../../shared/solution";
import type { SolutionStep } from "../../shared/steps";
import {
  estimateBodyBytes,
  MAX_ASK_ANSWER_TEXT,
  MAX_ASK_HISTORY,
  MAX_BODY_BYTES,
  MAX_SOLUTION_TEXT,
  type AskRequestBody,
  type SolveRequestBody,
} from "../../shared/stream-protocol";
import { trackProgress, type Progress, type ProgressTracker } from "@/lib/progress";
import {
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

/** Who answers: the model, and how hard it thinks. */
export type AskWriter = { provider: ProviderKey; variant?: ModelVariant; effort: EffortKey };

export type AskTurn = {
  id: string;
  question: string;
  /** The step quoted with the question, when it was asked from a step. */
  step?: { title: string; body: string };
  writer: AskWriter;
  /** The solution's version it was asked about (use-solve's solutionVersions). */
  version: number;
  status: "waiting" | "streaming" | "done" | "error";
  message?: string;
  charsReceived?: number;
  answer?: string;
  model?: string;
  stopped?: boolean;
  timedOut?: boolean;
};

export type AskThreads = Partial<Record<ProviderKey, AskTurn[]>>;

const STORE_KEY = "civilsolve:last-asks";
const STOPPED = "You stopped this question.";
const UNREACHABLE =
  "Could not reach the server for 2 minutes. The model keeps working there - reload this page to pick up the answer (kept for 24 hours).";

type SavedTurn = Omit<AskTurn, "status" | "message" | "charsReceived" | "answer" | "model" | "stopped" | "timedOut"> & {
  provider: ProviderKey;
  jobId?: string;
};

type SavedAsks = { runId: number; turns: SavedTurn[] };

function loadAsks(runId: number): SavedTurn[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as SavedAsks | null;
    if (!saved || saved.runId !== runId || !Array.isArray(saved.turns)) return [];
    return saved.turns.filter(
      (turn) => PROVIDER_KEYS.includes(turn.provider) && typeof turn.question === "string",
    );
  } catch {
    return [];
  }
}

function saveAsks(saved: SavedAsks) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    // Only the pick-up after a reload is lost.
  }
}

type Running = { handle: JobHandle; abort: AbortController; tracker: ProgressTracker };

export function useAsk({
  runId,
  getBody,
}: {
  /** The run on the page; a new one starts the threads afresh. */
  runId: number | null;
  getBody: () => SolveRequestBody | null;
}) {
  const [threads, setThreads] = useState<AskThreads>({});
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const savedRef = useRef<SavedAsks | null>(null);
  const runningRef = useRef(new Map<string, Running>());

  const persist = useCallback(() => {
    if (savedRef.current) saveAsks(savedRef.current);
  }, []);

  const update = useCallback((provider: ProviderKey, id: string, change: Partial<AskTurn>) => {
    setThreads((current) => ({
      ...current,
      [provider]: (current[provider] ?? []).map((turn) => (turn.id === id ? { ...turn, ...change } : turn)),
    }));
  }, []);

  /** Sends a question (body) or re-attaches to its job (body null). */
  const run = useCallback(
    async (provider: ProviderKey, turn: SavedTurn, body: AskRequestBody | null) => {
      const handle = jobHandle(turn.jobId ?? null);
      const abort = new AbortController();
      const live = () => !abort.signal.aborted && !handle.stopped;
      const tracker = trackProgress((next) => {
        if (live()) setProgress((current) => ({ ...current, [turn.id]: next }));
      });
      runningRef.current.set(turn.id, { handle, abort, tracker });
      const show = (change: Partial<AskTurn>) => {
        if (live()) update(provider, turn.id, change);
      };
      const onJob = (id: string) => {
        turn.jobId = id;
        persist();
      };
      const attempt = async () => {
        let charsReceived = 0;
        const stream = await openTaskStream(handle, `/api/ask/${provider}`, body, abort.signal);
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
            show({ status: "waiting", message: payload.message });
          } else if (event.name === "delta" && typeof payload.text === "string") {
            charsReceived += payload.text.length;
            show({ status: "streaming", charsReceived });
          } else if (event.name === "done" && payload.answer && typeof payload.answer === "object") {
            terminal = true;
            tracker.end(payload.at);
            show({
              status: "done",
              answer: (payload.answer as AskResult).answer,
              ...(typeof payload.model === "string" && payload.model ? { model: payload.model } : {}),
            });
          } else if (event.name === "error" && typeof payload.message === "string") {
            terminal = true;
            tracker.end(payload.at);
            show({
              status: "error",
              message: payload.message === "Cancelled." ? STOPPED : payload.message,
              ...(payload.message === "Cancelled." ? { stopped: true } : {}),
              ...(payload.timedOut === true ? { timedOut: true } : {}),
            });
          }
        }
        if (!terminal) throw new StreamInterruptedError("The answer's stream ended before it arrived.");
      };
      try {
        await withResume(attempt, handle, abort.signal, (message) => {
          tracker.note(message);
          show({ status: "waiting", message });
        });
      } catch (error) {
        if (!live()) return;
        tracker.end();
        show({
          status: "error",
          message: isConnectionLost(error)
            ? UNREACHABLE
            : error instanceof Error
              ? error.message
              : "The question could not be sent.",
        });
      } finally {
        runningRef.current.delete(turn.id);
      }
    },
    [persist, update],
  );

  // A new run starts the threads afresh; the same run after a reload picks
  // its questions back up - re-attaching to their jobs, never re-sending.
  useEffect(() => {
    for (const task of runningRef.current.values()) task.abort.abort();
    runningRef.current.clear();
    setProgress({});
    if (runId === null) {
      savedRef.current = null;
      setThreads({});
      return;
    }
    const turns = loadAsks(runId);
    savedRef.current = { runId, turns };
    const restored: AskThreads = {};
    for (const turn of turns) {
      restored[turn.provider] = [
        ...(restored[turn.provider] ?? []),
        {
          id: turn.id,
          question: turn.question,
          step: turn.step,
          writer: turn.writer,
          version: turn.version,
          status: turn.jobId ? "waiting" : "error",
          message: turn.jobId ? "Picking the answer back up..." : "This question had not reached the server when the page closed.",
        },
      ];
    }
    setThreads(restored);
    for (const turn of turns) if (turn.jobId) void run(turn.provider, turn, null);
  }, [runId, run]);

  /** Asks a question about a provider's finished solution. */
  const ask = useCallback(
    (
      provider: ProviderKey,
      solution: ProviderArtifact,
      version: number,
      question: string,
      writer: AskWriter,
      step?: SolutionStep,
    ) => {
      const body = getBody();
      const saved = savedRef.current;
      if (!body || !saved || !question.trim()) return;
      // The earlier answered questions about this solution, oldest first.
      const history = (threadsRef.current[provider] ?? [])
        .filter((turn) => turn.status === "done" && turn.answer)
        .slice(-MAX_ASK_HISTORY)
        .map((turn) => ({ question: turn.question, answer: (turn.answer ?? "").slice(0, MAX_ASK_ANSWER_TEXT) }));
      const sent: AskRequestBody = {
        images: body.images,
        notes: body.notes,
        ...(body.interpretation ? { interpretation: body.interpretation } : {}),
        solution: artifactToText(solution, MAX_SOLUTION_TEXT),
        question: question.trim(),
        ...(step ? { step: `${step.title}\n\n${step.body}` } : {}),
        ...(history.length ? { history } : {}),
        effort: writer.effort,
        ...(writer.variant ? { variant: writer.variant } : {}),
      };
      const turn: SavedTurn = {
        provider,
        id: crypto.randomUUID(),
        question: question.trim(),
        ...(step ? { step: { title: step.title, body: step.body } } : {}),
        writer,
        version,
      };
      const tooBig = estimateBodyBytes({ images: sent.images, notes: sent.notes, solutions: [sent.solution] }) > MAX_BODY_BYTES;
      setThreads((current) => ({
        ...current,
        [provider]: [
          ...(current[provider] ?? []),
          {
            id: turn.id,
            question: turn.question,
            step: turn.step,
            writer,
            version,
            status: tooBig ? "error" : "waiting",
            message: tooBig ? "The images plus the solution exceed the request size limit." : "Sending your question...",
          },
        ],
      }));
      if (tooBig) return;
      saved.turns.push(turn);
      persist();
      void run(provider, turn, sent);
    },
    [getBody, persist, run],
  );

  /** Stops one question's answer; the rest of the thread carries on. */
  const stop = useCallback(
    (provider: ProviderKey, id: string) => {
      const task = runningRef.current.get(id);
      if (!task) return;
      runningRef.current.delete(id);
      task.tracker.end();
      stopTask(task.handle, task.abort);
      update(provider, id, { status: "error", message: STOPPED, stopped: true });
    },
    [update],
  );

  /** Whether any answer is still on its way (for the page's alerts). */
  const active = Object.values(threads).some((turns) =>
    (turns ?? []).some((turn) => turn.status === "waiting" || turn.status === "streaming"),
  );

  return { threads, progress, ask, stop, active };
}
