// How a task that calls a model looks while it runs and once it failed:
// the progress box with its clock, status log and Stop, and the colours of
// a failure, a timeout and a stop. Shared by the solutions, the verdict and
// the study notes.

import { Loader2, Square } from "lucide-react";
import { formatDuration } from "../../../shared/stream-protocol";
import { formatClock, type Progress } from "@/lib/progress";
import { STOP_BUTTON_CLASS } from "./interpret-progress";

// A task that ran out of time and returned nothing is shown in orange, apart
// from the red of a real failure: nothing went wrong that a rerun could not fix.
export const TIMEOUT_DOT = "bg-[#e67e22]";
export const TIMEOUT_BOX =
  "border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] text-[#a85a12]";
export const ERROR_BOX =
  "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-cs-danger";
// Stopped by the user: grey - neither a failure nor a timeout.
export const STOPPED_DOT = "bg-cs-ink-3";
export const STOPPED_BOX = "border-cs-line bg-cs-muted text-cs-ink-2";

/**
 * Every status line so far, with when it came, so a long wait shows its
 * history - each retry, model switch and dropped connection - instead of one
 * line that never changes. The line already shown above is left out.
 */
export function EventLog({ progress, current }: { progress?: Progress; current?: string }) {
  if (!progress) return null;
  const events = progress.events.filter(
    (event, index, all) => !(index === all.length - 1 && event.message === current),
  );
  if (!events.length) return null;
  return (
    <ol className="mt-3 space-y-1 border-t border-current/10 pt-2 text-xs opacity-80">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className="flex gap-2">
          <span className="shrink-0 tabular-nums opacity-70">
            {formatClock(event.at - progress.startedAt)}
          </span>
          <span className="min-w-0 break-words">{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The progress bar of a task still running: what it is doing, how long it has
 * taken so far, and what happened on the way. The timeout is deliberately not
 * shown - only the time spent (the owner's choice, 25 September 2026).
 */
export function ProgressBox({
  line,
  progress,
  now,
  onStop,
  stopTitle,
}: {
  line: string;
  progress?: Progress;
  now: number;
  /** This task's own Stop; the others carry on. */
  onStop?: () => void;
  stopTitle?: string;
}) {
  const elapsed = progress ? now - progress.startedAt : 0;
  return (
    <div className="rounded-cs border border-cs-line bg-cs-surface px-4 py-3 text-sm text-cs-ink-2">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs-accent" />
        <span className="min-w-0 flex-1 break-words">{line}</span>
        {progress ? (
          <span className="shrink-0 font-semibold tabular-nums" title="Time since the request was sent">
            {formatClock(elapsed)}
          </span>
        ) : null}
        {onStop ? (
          <button type="button" onClick={onStop} title={stopTitle} className={STOP_BUTTON_CLASS}>
            <Square className="h-3 w-3 fill-current" aria-hidden="true" />
            Stop
          </button>
        ) : null}
      </div>
      <EventLog progress={progress} current={line} />
    </div>
  );
}

/**
 * How long a finished task took, when known: "2 min 15 s". Nothing under a
 * second - that is a request refused outright, or a job the server no longer
 * had, where a time would only mislead.
 */
export function tookLabel(progress?: Progress) {
  if (!progress?.endedAt) return "";
  const took = progress.endedAt - progress.startedAt;
  return took >= 1000 ? formatDuration(took) : "";
}
