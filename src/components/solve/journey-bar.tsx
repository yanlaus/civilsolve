// The run's four steps, kept at the top of the screen (lib/journey.ts works
// out their states), and a button at the bottom that jumps to the step to
// look at now when it is out of sight - the solutions used to appear below
// the interpreted question with nothing to say so (3 October 2026).

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, Minus, X } from "lucide-react";
import type { JourneyStep, StepState } from "@/lib/journey";

const DOT: Record<StepState, string> = {
  todo: "border-cs-line bg-cs-surface text-cs-ink-3",
  now: "border-cs-accent bg-cs-accent text-cs-on-accent",
  running: "border-cs-accent bg-cs-surface text-cs-accent",
  queued: "border-dashed border-cs-accent bg-cs-surface text-cs-accent",
  yourTurn: "border-cs-accent bg-cs-accent text-cs-on-accent shadow-[0_0_0_4px_var(--cs-ring)]",
  done: "border-cs-success bg-cs-success text-white",
  skipped: "border-dashed border-cs-line bg-cs-surface text-cs-ink-3",
  failed: "border-cs-danger bg-cs-surface text-cs-danger",
};

function StepDot({ state, number }: { state: StepState; number: number }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${DOT[state]}`}
      aria-hidden="true"
    >
      {state === "done" ? (
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      ) : state === "running" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : state === "skipped" ? (
        <Minus className="h-3.5 w-3.5" />
      ) : state === "failed" ? (
        <X className="h-3.5 w-3.5" strokeWidth={3} />
      ) : (
        number
      )}
    </span>
  );
}

/** Where the run stands, read aloud: "Answers: 2/3 ready". */
function spoken(step: JourneyStep) {
  return `${step.label}: ${step.detail?.[0] ?? step.state}`;
}

export function JourneyBar({
  steps,
  current,
  onJump,
}: {
  steps: JourneyStep[];
  current: JourneyStep;
  onJump: (step: JourneyStep) => void;
}) {
  return (
    <nav
      aria-label="Progress"
      className="sticky top-0 z-30 -mx-5 mb-6 border-b border-cs-line-soft bg-cs-page/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6 print:hidden"
    >
      <ol className="flex items-start">
        {steps.map((step, index) => {
          const isCurrent = step.key === current.key;
          const jumpable = Boolean(step.target);
          return (
            <li key={step.key} className="flex min-w-0 flex-1 items-start">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={`mt-3.5 hidden h-0.5 w-4 shrink-0 rounded sm:block lg:w-8 ${
                    step.state === "todo" || step.state === "skipped" ? "bg-cs-line" : "bg-cs-accent"
                  }`}
                />
              ) : null}
              <button
                type="button"
                disabled={!jumpable}
                onClick={() => onJump(step)}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={spoken(step)}
                className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-cs px-1 py-1 text-center transition sm:flex-row sm:items-start sm:gap-2 sm:px-2 sm:text-left ${
                  jumpable ? "hover:bg-cs-surface" : "cursor-default"
                } ${isCurrent ? "bg-cs-surface shadow-[0_1px_3px_var(--cs-shadow)]" : ""}`}
              >
                <StepDot state={step.state} number={index + 1} />
                <span className="min-w-0">
                  <span
                    className={`block truncate text-xs font-semibold ${
                      step.state === "skipped" || step.state === "todo" ? "text-cs-ink-3" : "text-cs-ink"
                    }`}
                  >
                    <span className="sm:hidden">{step.chinese}</span>
                    <span className="hidden sm:inline">{step.label}</span>
                  </span>
                  {/* Under it: on a phone where it stands, in Chinese; on a
                      wider screen the Chinese name, then where it stands. */}
                  <span className="block truncate text-[0.68rem] text-cs-ink-3">
                    <span className="hidden sm:inline">{step.chinese}</span>
                    {step.detail ? (
                      <span
                        className={
                          step.state === "yourTurn"
                            ? "font-semibold text-cs-accent"
                            : step.state === "failed"
                              ? "text-cs-danger"
                              : ""
                        }
                      >
                        <span className="sm:hidden">{step.detail[1]}</span>
                        <span className="hidden sm:inline"> · {step.detail[0]}</span>
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Whether the element with this id is on screen; null while it is not on the page. */
function useOnScreen(id: string | undefined) {
  const [onScreen, setOnScreen] = useState<{ visible: boolean; below: boolean } | null>(null);
  useEffect(() => {
    setOnScreen(null);
    if (!id) return;
    let observer: IntersectionObserver | null = null;
    // The element may mount after the step changes (the solutions panel is
    // lazy-loaded), so look for it until it is there.
    const timer = window.setInterval(() => {
      const element = document.getElementById(id);
      if (!element || observer) return;
      observer = new IntersectionObserver(([entry]) => {
        setOnScreen({ visible: entry.isIntersecting, below: entry.boundingClientRect.top > 0 });
      });
      observer.observe(element);
      window.clearInterval(timer);
    }, 300);
    return () => {
      window.clearInterval(timer);
      observer?.disconnect();
    };
  }, [id]);
  return onScreen;
}

/**
 * "↓ Answers · 2/3 ready": shown while the step to look at now is out of
 * sight, until the student has seen it - it comes back when the step moves
 * on (another answer in, the verdict ready).
 */
export function JumpButton({ step, onJump }: { step: JourneyStep; onJump: (step: JourneyStep) => void }) {
  const position = useOnScreen(step.key === "upload" ? undefined : step.target);
  const signature = `${step.key}:${step.state}:${step.detail?.[0] ?? ""}`;
  const [seen, setSeen] = useState("");
  useEffect(() => {
    if (position?.visible) setSeen(signature);
  }, [position?.visible, signature]);

  if (!position || position.visible || seen === signature) return null;
  const Arrow = position.below ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => onJump(step)}
      className="cs-primary fixed bottom-4 left-1/2 z-40 inline-flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-cs-accent px-4 py-2.5 text-sm font-semibold text-cs-on-accent shadow-[0_4px_18px_var(--cs-shadow),0_0_0_4px_var(--cs-ring)] transition hover:bg-cs-accent-hover sm:left-auto sm:right-6 sm:translate-x-0 print:hidden"
    >
      <Arrow className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {step.label} · {step.chinese}
        {step.detail ? <span className="font-normal"> · {step.detail[0]}</span> : null}
      </span>
    </button>
  );
}
