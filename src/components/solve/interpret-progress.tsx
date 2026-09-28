// The interpretation pass while it runs: which step it is on, how long that
// step has taken, and one line per model - its name, then what it is doing -
// so two readers working at once can each be followed at a glance. Stop ends
// the pass; a reader's own Stop ends that reader only, and the other's
// reading goes to review alone.

import type { ReactNode } from "react";
import { Check, CircleSlash, Loader2, Square, X } from "lucide-react";
import type { ModelProgress } from "@/hooks/use-interpret";
import { formatClock } from "@/lib/progress";

export const STOP_BUTTON_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-cs border border-cs-line bg-cs-surface px-2.5 py-1 text-xs font-semibold text-cs-ink-2 transition hover:border-cs-danger hover:text-cs-danger";

/**
 * A running task's line: a spinner and what it is doing, then its clock and
 * Stop. The text asks for 16rem before it shares its row: on a phone the
 * clock and Stop go under it, on the right, and on a wider screen they stay
 * beside it. Beside them on an iPhone the text was squeezed into a column a
 * few words wide (the owner, 29 September 2026). Used by every progress line:
 * the solvers', the verdict's, the notes', the interpretation pass's and a
 * reading being re-generated.
 */
export function StatusRow({
  children,
  clock,
  clockTitle,
  onStop,
  stopTitle,
}: {
  children: ReactNode;
  clock?: string;
  clockTitle?: string;
  onStop?: () => void;
  stopTitle?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{children}</span>
      </div>
      {clock || onStop ? (
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {clock ? (
            <span className="font-semibold tabular-nums" title={clockTitle}>
              {clock}
            </span>
          ) : null}
          {onStop ? (
            <button type="button" onClick={onStop} title={stopTitle} className={STOP_BUTTON_CLASS}>
              <Square className="h-3 w-3 fill-current" aria-hidden="true" />
              Stop
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function InterpretProgress({
  stage,
  step,
  steps,
  models,
  elapsedMs,
  onStop,
  onStopModel,
}: {
  stage: string;
  step: number;
  steps: number;
  models: ModelProgress[];
  elapsedMs: number;
  /** Stops the whole interpretation pass. */
  onStop: () => void;
  /** Stops one reader; the pass goes on with the other. */
  onStopModel: (label: string) => void;
}) {
  // A reader's own Stop only means something while another is still in play.
  const inPlay = models.filter((model) => model.state === "working" || model.state === "done");
  return (
    <div>
      <StatusRow
        clock={formatClock(elapsedMs)}
        clockTitle="Time this step has taken"
        onStop={onStop}
        stopTitle="Stop the interpretation pass"
      >
        <span className="font-semibold text-cs-ink">
          <span className="font-normal text-cs-ink-3">
            Step {step} of {steps} ·{" "}
          </span>
          {stage}
        </span>
      </StatusRow>
      <ul className="mt-2 space-y-1.5 border-t border-cs-line-soft pt-2">
        {models.map((model) => (
          <li key={model.label} className="flex items-start gap-2 text-sm">
            {model.state === "done" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-cs-success" aria-label="Done" />
            ) : model.state === "failed" ? (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-cs-danger" aria-label="Failed" />
            ) : model.state === "stopped" ? (
              <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-cs-ink-3" aria-label="Stopped" />
            ) : (
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-cs-ink-3" aria-label="Working" />
            )}
            <span className="min-w-0 flex-1 sm:flex sm:gap-2">
              <span className="block font-medium text-cs-ink sm:w-40 sm:shrink-0">{model.label}</span>
              <span
                className={`block min-w-0 break-words ${
                  model.state === "failed" ? "text-cs-danger" : "text-cs-ink-3"
                }`}
              >
                {model.status}
              </span>
            </span>
            {model.stoppable && model.state === "working" && inPlay.length > 1 ? (
              <button
                type="button"
                onClick={() => onStopModel(model.label)}
                title={`Stop ${model.label} and review the other reader's reading alone`}
                className={STOP_BUTTON_CLASS}
              >
                <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                Stop
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
