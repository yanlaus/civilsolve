// The run's four steps, kept at the top of the screen (lib/journey.ts works
// out their states), and a button at the bottom that jumps to the step to
// look at now when it is out of sight - the solutions used to appear below
// the interpreted question with nothing to say so (3 October 2026).

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, Minus, X } from "lucide-react";
import type { JourneyStep, StepState } from "@/lib/journey";

// One colour for the way through (the theme's accent), grey for what is
// still ahead; a step left out keeps a dashed outline. Every dot sits in a
// ring of the page colour, so the track stops short of it.
const PAGE_RING = "shadow-[0_0_0_4px_var(--cs-page)]";
const ACTIVE_RING = "shadow-[0_0_0_4px_var(--cs-page),0_0_0_7px_var(--cs-ring)]";

const DOT: Record<StepState, string> = {
  todo: `border-cs-line bg-cs-surface text-cs-ink-3 ${PAGE_RING}`,
  now: `border-cs-accent bg-cs-surface text-cs-accent ${ACTIVE_RING}`,
  running: `border-cs-accent bg-cs-surface text-cs-accent ${ACTIVE_RING}`,
  queued: `border-dashed border-cs-accent bg-cs-surface text-cs-accent ${PAGE_RING}`,
  yourTurn: `border-cs-accent bg-cs-accent text-cs-on-accent ${ACTIVE_RING}`,
  done: `border-cs-accent bg-cs-accent text-cs-on-accent ${PAGE_RING}`,
  skipped: `border-dashed border-cs-line bg-cs-surface text-cs-ink-3 ${PAGE_RING}`,
  failed: `border-cs-danger bg-cs-surface text-cs-danger ${PAGE_RING}`,
};

function StepDot({ state, number }: { state: StepState; number: number }) {
  return (
    <span className="relative flex h-7 w-7 shrink-0" aria-hidden="true">
      {/* Waiting for the student: a soft pulse round the dot. */}
      {state === "yourTurn" ? (
        <span className="absolute inset-0 animate-ping rounded-full bg-cs-accent opacity-30 motion-reduce:hidden" />
      ) : null}
      <span
        className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors duration-300 ${DOT[state]}`}
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
    </span>
  );
}

/** Where the run stands, read aloud: "Answers: 2/3 ready". */
function spoken(step: JourneyStep) {
  return `${step.label}: ${step.detail?.[0] ?? step.state}`;
}

/**
 * A stepper with the labels under the dots, joined by one track that fills
 * in as the run moves on (the owner found the dashes between the steps
 * unprofessional, 3 October 2026).
 */
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
      className="sticky top-0 z-30 -mx-5 mb-6 border-b border-cs-line-soft bg-cs-page/95 px-2 pb-2 pt-3 backdrop-blur sm:-mx-6 sm:px-6 print:hidden"
    >
      <ol className="flex">
        {steps.map((step, index) => {
          const isCurrent = step.key === current.key;
          const jumpable = Boolean(step.target);
          const quiet = step.state === "todo" || step.state === "skipped";
          return (
            <li key={step.key} className="relative min-w-0 flex-1">
              {/* The track from the step before to this one: filled once the
                  run has got here (a step left out is passed through). */}
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute left-[-50%] right-1/2 top-[13px] h-0.5 overflow-hidden rounded-full bg-cs-line-soft"
                >
                  <span
                    className={`block h-full rounded-full bg-cs-accent transition-[width] duration-500 ease-out ${
                      step.state === "todo" ? "w-0" : "w-full"
                    }`}
                  />
                </span>
              ) : null}
              <button
                type="button"
                disabled={!jumpable}
                onClick={() => onJump(step)}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={spoken(step)}
                className={`group relative z-10 flex w-full flex-col items-center gap-1.5 px-1 text-center outline-none ${
                  jumpable ? "cursor-pointer" : "cursor-default"
                }`}
              >
                <StepDot state={step.state} number={index + 1} />
                <span className="w-full min-w-0">
                  <span
                    className={`block truncate text-xs font-semibold transition-colors ${
                      isCurrent ? "text-cs-accent" : quiet ? "text-cs-ink-3" : "text-cs-ink"
                    } ${jumpable ? "group-hover:text-cs-accent group-focus-visible:underline" : ""}`}
                  >
                    <span className="sm:hidden">{step.chinese}</span>
                    <span className="hidden sm:inline">
                      {step.label} <span className="font-normal text-cs-ink-3">{step.chinese}</span>
                    </span>
                  </span>
                  <span
                    className={`block truncate text-[0.68rem] ${
                      step.state === "yourTurn"
                        ? "font-semibold text-cs-accent"
                        : step.state === "failed"
                          ? "text-cs-danger"
                          : "text-cs-ink-3"
                    }`}
                  >
                    {step.detail ? (
                      <>
                        <span className="sm:hidden">{step.detail[1]}</span>
                        <span className="hidden sm:inline">{step.detail[0]}</span>
                      </>
                    ) : (
                      // Keeps every step the same height.
                      <span aria-hidden="true">&nbsp;</span>
                    )}
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
