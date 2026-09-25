// What a running task has been doing, for the progress box under its tab:
// when it started, when the server gives up on it, and every status line so
// far - each retry, model switch, dropped connection - with the time it came
// in. A phone left on a long solve should never be looking at one unchanging
// line with no idea whether anything is happening.
//
// All times are this page's clock. The job reports its own times on the
// server's clock (JobEvent, and `at` on statuses); they are converted once,
// with the offset measured on the first `job` event, so a phone whose clock
// is off still shows the right elapsed time, and a status the job replays on
// re-attach lands on the same instant and is recognised as already shown.

import { useEffect, useState } from "react";
import type { JobHandle } from "./sse";

export type ProgressEvent = { at: number; message: string };

export type Progress = {
  startedAt: number;
  /** When the server gives up on the task. Unknown until the job says. */
  deadlineAt?: number;
  /** When the task finished, either way. */
  endedAt?: number;
  events: ProgressEvent[];
};

/** Client-side notes (reconnecting) replace one another rather than pile up. */
const CONNECTION_NOTE = /^(Connection lost|This device is offline)/;

export type ProgressTracker = {
  /** The job's `job` event arrived: take its start time and deadline. */
  job(handle: JobHandle): void;
  /** A status from the server; `at` is the server's time, when it sent one. */
  status(message: string, at?: unknown): void;
  /** Something the page itself reports, such as a lost connection. */
  note(message: string): void;
  /** The task finished; `at` is the server's time, when it sent one. */
  end(at?: unknown): void;
};

/**
 * Keeps one task's Progress and hands every new version to `publish` (a
 * React state setter). Starts the clock now; the job's own start time
 * replaces it once known.
 */
export function trackProgress(publish: (progress: Progress) => void): ProgressTracker {
  let progress: Progress = { startedAt: Date.now(), events: [] };
  let clockOffset: number | null = null;
  const local = (serverTime: unknown) =>
    typeof serverTime === "number" && clockOffset !== null ? serverTime + clockOffset : Date.now();
  const set = (next: Progress) => {
    progress = next;
    publish(next);
  };

  return {
    job(handle) {
      const timing = handle.timing;
      if (!timing) return;
      if (clockOffset === null) clockOffset = timing.clockOffset;
      set({
        ...progress,
        ...(timing.startedAt !== undefined ? { startedAt: timing.startedAt + clockOffset } : {}),
        ...(timing.deadlineAt !== undefined ? { deadlineAt: timing.deadlineAt + clockOffset } : {}),
      });
    },
    status(message, at) {
      const when = local(at);
      // A re-attach replays every status so far; those are already here.
      if (progress.events.some((event) => event.at === when && event.message === message)) return;
      set({ ...progress, events: [...progress.events, { at: when, message }] });
    },
    note(message) {
      const events = progress.events;
      const last = events[events.length - 1];
      const kept = last && CONNECTION_NOTE.test(last.message) && CONNECTION_NOTE.test(message)
        ? events.slice(0, -1)
        : events;
      set({ ...progress, events: [...kept, { at: Date.now(), message }] });
    },
    end(at) {
      set({ ...progress, endedAt: local(at) });
    },
  };
}

/** "2:05" - a running clock. */
export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The current time, updated every second while `active`. */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
