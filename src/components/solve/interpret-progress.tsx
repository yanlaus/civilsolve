// The interpretation pass while it runs: which step it is on, how long that
// step has taken, and one line per model - its name, then what it is doing -
// so two readers working at once can each be followed at a glance. Stop ends
// the pass; a reader's own Stop ends that reader only, and the other's
// reading goes to review alone.

import { Check, CircleSlash, Loader2, Square, X } from "lucide-react";
import type { ModelProgress } from "@/hooks/use-interpret";
import { formatClock } from "@/lib/progress";

export const STOP_BUTTON_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-cs border border-cs-line bg-cs-surface px-2.5 py-1 text-xs font-semibold text-cs-ink-2 transition hover:border-cs-danger hover:text-cs-danger";

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
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-cs-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 font-semibold text-cs-ink">
          <span className="font-normal text-cs-ink-3">
            Step {step} of {steps} ·{" "}
          </span>
          {stage}
        </span>
        <span className="shrink-0 font-semibold tabular-nums" title="Time this step has taken">
          {formatClock(elapsedMs)}
        </span>
        <button
          type="button"
          onClick={onStop}
          title="Stop the interpretation pass"
          className={STOP_BUTTON_CLASS}
        >
          <Square className="h-3 w-3 fill-current" aria-hidden="true" />
          Stop
        </button>
      </div>
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
            <span className="w-32 shrink-0 font-medium text-cs-ink sm:w-40">{model.label}</span>
            <span
              className={`min-w-0 flex-1 break-words ${
                model.state === "failed" ? "text-cs-danger" : "text-cs-ink-3"
              }`}
            >
              {model.status}
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
