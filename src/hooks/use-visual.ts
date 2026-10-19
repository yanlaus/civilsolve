// Visualize 圖解 (19 October 2026): the full solution drawn as a deck of
// interactive boards (shared/visual.ts), by DeepSeek V4.1 Flash on OpenCode
// Go, from the source the student picks - one solver's solution or the
// verdict with the solutions it graded, as for the study notes - and one board
// of it drawn again on request ("Fix this board").
//
// Kept apart from use-solve.ts, as the questions are (use-ask.ts): this hook
// only reads the run's request body and its answers. A drawing is a job of its
// own (POST /api/visualize/deepseek); its id and the deck's are saved for the
// run in localStorage, so a reload re-attaches - nothing is sent on page load.
//
// A fix's job stores the whole deck with the new board in (worker/tasks.ts),
// so whichever job is read back - after a reload, from the History or the
// usage page - gives the deck whole. While a new deck or a fix is drawn the
// deck on the page stays; one that fails or is stopped leaves it as it was.

import { useCallback, useEffect, useRef, useState } from "react";
import type { EffortKey } from "../../shared/prompt";
import { isProviderKey, PROVIDER_KEYS, type ProviderKey } from "../../shared/providers";
import {
  estimateBodyBytes,
  MAX_BODY_BYTES,
  type SolveRequestBody,
  type VisualRequestBody,
} from "../../shared/stream-protocol";
import { readBoards, VISUAL_PROVIDER, type VisualBoard } from "../../shared/visual";
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
import { sourceSolutions, type JudgeRun, type ProviderRuns, type StudySource } from "./use-solve";

/** What a deck was drawn from: the source, and the solutions it sent (the verdict's A, B, ...). */
export type VisualBasis = { source: StudySource; solvers: ProviderKey[] };

export type VisualDeck = {
  boards: VisualBoard[];
  basis: VisualBasis;
  effort: EffortKey;
  /** The model that drew it. */
  model?: string;
  /** The board drawn again last, and the instructions it was drawn with. */
  fixed?: { board: number; instructions: string };
  /** Why the last request left the deck as it was (it failed, or was stopped). */
  notice?: string;
};

/** The request in flight, or how the last one ended when it left no deck. */
export type VisualTask =
  | { status: "idle" }
  | { status: "waiting"; message: string; board?: number }
  | { status: "streaming"; charsReceived: number; board?: number }
  | { status: "error"; message: string; timedOut?: boolean; stopped?: boolean };

type Pending = {
  jobId?: string;
  basis: VisualBasis;
  effort: EffortKey;
  /** Set on a fix: the board drawn again, and why. */
  board?: number;
  instructions?: string;
};

type SavedVisual = {
  runId: number;
  /** The deck on the page: its job, and what it was drawn from. */
  deck?: { jobId: string; basis: VisualBasis; effort: EffortKey };
  /** The drawing in flight. */
  pending?: Pending;
};

const STORE_KEY = "civilsolve:last-visual";
const STOPPED = "You stopped the drawing.";
const UNREACHABLE =
  "Could not reach the server for 2 minutes. The drawing goes on there - reload this page to pick it up (kept for 24 hours).";

function isBasis(value: unknown): value is VisualBasis {
  const basis = value as VisualBasis | null;
  return (
    Boolean(basis) &&
    (basis?.source === "verdict" || isProviderKey(String(basis?.source))) &&
    Array.isArray(basis?.solvers) &&
    basis.solvers.every((key) => PROVIDER_KEYS.includes(key))
  );
}

function loadVisual(runId: number): SavedVisual {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "null") as SavedVisual | null;
    if (!saved || saved.runId !== runId) return { runId };
    return {
      runId,
      ...(saved.deck?.jobId && isBasis(saved.deck.basis) ? { deck: saved.deck } : {}),
      ...(saved.pending?.jobId && isBasis(saved.pending.basis) ? { pending: saved.pending } : {}),
    };
  } catch {
    return { runId };
  }
}

function saveVisual(saved: SavedVisual) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    // Only the pick-up after a reload is lost.
  }
}

type Running = { handle: JobHandle; abort: AbortController; tracker: ProgressTracker; pending: Pending };

export function useVisual({
  runId,
  getBody,
  runs,
  judgeRun,
}: {
  /** The run on the page; a new one starts afresh. */
  runId: number | null;
  getBody: () => SolveRequestBody | null;
  runs: ProviderRuns;
  judgeRun: JudgeRun;
}) {
  const [deck, setDeck] = useState<VisualDeck | null>(null);
  const [deckJobId, setDeckJobId] = useState<string | null>(null);
  const [task, setTask] = useState<VisualTask>({ status: "idle" });
  const [progress, setProgress] = useState<Progress | undefined>(undefined);
  const [focus, setFocus] = useState<number | undefined>(undefined);
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const judgeRunRef = useRef(judgeRun);
  judgeRunRef.current = judgeRun;
  const savedRef = useRef<SavedVisual | null>(null);
  const runningRef = useRef<Running | null>(null);
  /** A deck drawn (or fixed) since the run was picked up: newer than the one re-attached. */
  const freshRef = useRef(false);

  const persist = useCallback(() => {
    if (savedRef.current) saveVisual(savedRef.current);
  }, []);

  /**
   * Sends a drawing (body) or re-attaches to its job (body null). `quiet`
   * re-attaches to the deck already drawn, after a reload: no progress shown.
   */
  const attach = useCallback(
    async (body: VisualRequestBody | null, pending: Pending, quiet = false) => {
      const handle = jobHandle(pending.jobId ?? null);
      const abort = new AbortController();
      const live = () => !abort.signal.aborted && !handle.stopped;
      const tracker = trackProgress((next) => {
        if (live() && !quiet) setProgress(next);
      });
      const running: Running = { handle, abort, tracker, pending };
      if (!quiet) runningRef.current = running;
      const board = pending.board;
      const showTask = (next: VisualTask) => {
        if (live() && !quiet) setTask(next);
      };
      // A fix that fails leaves the deck as it was, with a note; a new deck
      // that fails says so, and any deck already there stays.
      const fail = (message: string, extra: { timedOut?: boolean; stopped?: boolean } = {}) => {
        if (!live() || quiet) return;
        if (savedRef.current?.pending === pending) {
          savedRef.current.pending = undefined;
          persist();
        }
        const current = deckRef.current;
        if (current) {
          const what = board === undefined ? "Drawing a new deck" : `Drawing board ${board + 1} again`;
          setDeck({ ...current, notice: extra.stopped ? `${what} was stopped.` : `${what} did not work: ${message.replace(/\.$/, "")}.` });
          setTask({ status: "idle" });
        } else {
          setTask({ status: "error", message, ...extra });
        }
      };
      const onJob = (id: string) => {
        pending.jobId = id;
        persist();
      };
      const attempt = async () => {
        let charsReceived = 0;
        const stream = await openTaskStream(handle, `/api/visualize/${VISUAL_PROVIDER}`, body, abort.signal);
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
            showTask({ status: "waiting", message: payload.message, board });
          } else if (event.name === "delta" && typeof payload.text === "string") {
            charsReceived += payload.text.length;
            showTask({ status: "streaming", charsReceived, board });
          } else if (event.name === "done") {
            terminal = true;
            tracker.end(payload.at);
            const boards = readBoards((payload.visual as { boards?: unknown } | undefined)?.boards);
            if (!boards) {
              fail("The drawing came back in a shape the page cannot show.");
              continue;
            }
            // After a reload the deck and a fix in flight are picked up at
            // once; the old deck must not land on top of the new one.
            if (!live() || (quiet && freshRef.current)) continue;
            if (!quiet) freshRef.current = true;
            setDeck({
              boards,
              basis: pending.basis,
              effort: pending.effort,
              ...(typeof payload.model === "string" && payload.model ? { model: payload.model } : {}),
              ...(board !== undefined && pending.instructions ? { fixed: { board, instructions: pending.instructions } } : {}),
            });
            if (handle.id) {
              setDeckJobId(handle.id);
              if (savedRef.current) {
                savedRef.current.deck = { jobId: handle.id, basis: pending.basis, effort: pending.effort };
                if (savedRef.current.pending === pending) savedRef.current.pending = undefined;
                persist();
              }
            }
            if (!quiet) {
              setTask({ status: "idle" });
              setFocus(board ?? 0);
            }
          } else if (event.name === "error" && typeof payload.message === "string") {
            terminal = true;
            tracker.end(payload.at);
            if (quiet) {
              // The deck's job is gone (expired): nothing to show, and nothing to keep.
              const saved = savedRef.current;
              if (saved?.deck && saved.deck.jobId === pending.jobId) {
                saved.deck = undefined;
                persist();
              }
              continue;
            }
            if (payload.message === "Cancelled.") fail(STOPPED, { stopped: true });
            else fail(payload.message, payload.timedOut === true ? { timedOut: true } : {});
          }
        }
        if (!terminal) throw new StreamInterruptedError("The drawing's stream ended before it arrived.");
      };
      try {
        await withResume(attempt, handle, abort.signal, (message) => {
          tracker.note(message);
          showTask({ status: "waiting", message, board });
        });
      } catch (error) {
        if (!live()) return;
        tracker.end();
        fail(
          isConnectionLost(error)
            ? UNREACHABLE
            : error instanceof Error
              ? error.message
              : "The drawing could not be sent.",
        );
      } finally {
        if (runningRef.current === running) runningRef.current = null;
      }
    },
    [persist],
  );

  // A new run starts afresh; the same run after a reload picks its deck and
  // any drawing in flight back up - re-attaching, never re-sending.
  useEffect(() => {
    runningRef.current?.abort.abort();
    runningRef.current = null;
    freshRef.current = false;
    setDeck(null);
    setDeckJobId(null);
    setTask({ status: "idle" });
    setProgress(undefined);
    setFocus(undefined);
    if (runId === null) {
      savedRef.current = null;
      return;
    }
    const saved = loadVisual(runId);
    savedRef.current = saved;
    if (saved.deck) void attach(null, { jobId: saved.deck.jobId, basis: saved.deck.basis, effort: saved.deck.effort }, true);
    if (saved.pending) {
      setTask({ status: "waiting", message: "Picking the drawing back up...", board: saved.pending.board });
      void attach(null, saved.pending);
    }
  }, [runId, attach]);

  /** Sends a drawing; refuses while one is in flight. */
  const send = useCallback(
    (source: StudySource, effort: EffortKey, extra: Pick<VisualRequestBody, "fix"> = {}) => {
      const body = getBody();
      const saved = savedRef.current;
      if (!body || !saved || runningRef.current) return;
      const picked = sourceSolutions(source, runsRef.current, judgeRunRef.current);
      if (!picked) {
        setTask({ status: "error", message: "The solution to draw from is no longer on the page." });
        return;
      }
      const sent: VisualRequestBody = {
        images: body.images,
        notes: body.notes,
        ...(body.interpretation ? { interpretation: body.interpretation } : {}),
        solutions: picked.solutions,
        ...(picked.verdict ? { verdict: picked.verdict } : {}),
        effort,
        ...extra,
      };
      if (estimateBodyBytes(sent) > MAX_BODY_BYTES) {
        setTask({ status: "error", message: "The images plus the solutions exceed the request size limit." });
        return;
      }
      const pending: Pending = {
        basis: { source, solvers: picked.solvers },
        effort,
        ...(extra.fix ? { board: extra.fix.board, instructions: extra.fix.instructions } : {}),
      };
      saved.pending = pending;
      persist();
      if (deckRef.current?.notice) setDeck({ ...deckRef.current, notice: undefined });
      setProgress(undefined);
      setTask({
        status: "waiting",
        message: extra.fix ? `Drawing board ${extra.fix.board + 1} again...` : "Submitting...",
        board: extra.fix?.board,
      });
      void attach(sent, pending);
    },
    [attach, getBody, persist],
  );

  /** A new deck, from the solution the student picked, at the level they picked. */
  const draw = useCallback((source: StudySource, effort: EffortKey) => send(source, effort), [send]);

  /** One board of the deck on the page drawn again, with the student's instructions. */
  const fix = useCallback(
    (board: number, instructions: string) => {
      const current = deckRef.current;
      const wanted = instructions.trim();
      if (!current || !wanted || !current.boards[board]) return;
      send(current.basis.source, current.effort, { fix: { board, instructions: wanted, boards: current.boards } });
    },
    [send],
  );

  /** Stops the drawing in flight; the deck on the page stays. */
  const stop = useCallback(() => {
    const running = runningRef.current;
    if (!running) return;
    runningRef.current = null;
    running.tracker.end();
    stopTask(running.handle, running.abort);
    if (savedRef.current?.pending === running.pending) {
      savedRef.current.pending = undefined;
      persist();
    }
    const current = deckRef.current;
    if (current) {
      const what = running.pending.board === undefined ? "Drawing a new deck" : `Drawing board ${running.pending.board + 1} again`;
      setDeck({ ...current, notice: `${what} was stopped.` });
      setTask({ status: "idle" });
    } else {
      setTask({ status: "error", message: STOPPED, stopped: true });
    }
  }, [persist]);

  const active = task.status === "waiting" || task.status === "streaming";
  return { deck, deckJobId, task, progress, focus, draw, fix, stop, active };
}

/** What the page passes down to the Visualize section. */
export type VisualControls = ReturnType<typeof useVisual>;
