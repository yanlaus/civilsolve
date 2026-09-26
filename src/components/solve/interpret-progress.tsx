// The interpretation pass while it runs: which step it is on, how long that
// step has taken, and one line per model - its name, then what it is doing -
// so two readers working at once can each be followed at a glance.

import { Check, Loader2, X } from "lucide-react";
import type { ModelProgress } from "@/hooks/use-interpret";
import { formatClock } from "@/lib/progress";

export function InterpretProgress({
  stage,
  step,
  steps,
  models,
  elapsedMs,
}: {
  stage: string;
  step: number;
  steps: number;
  models: ModelProgress[];
  elapsedMs: number;
}) {
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
      </div>
      <ul className="mt-2 space-y-1.5 border-t border-cs-line-soft pt-2">
        {models.map((model) => (
          <li key={model.label} className="flex items-start gap-2 text-sm">
            {model.state === "done" ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-cs-success" aria-label="Done" />
            ) : model.state === "failed" ? (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-cs-danger" aria-label="Failed" />
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
          </li>
        ))}
      </ul>
    </div>
  );
}
