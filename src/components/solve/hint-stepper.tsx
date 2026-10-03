// "Try it yourself · 先自己諗" (3 October 2026): a solution shown a little at
// a time, so a student can attempt each step before reading it - the
// question, then the plan (every step's title), then one step at a time, and
// the final answer last. Nothing new is asked of a model: the steps are cut
// out of the solution's own working (shared/steps.ts), which the solve
// prompt lays out as bold "Step N - ..." lines.

import { useMemo, type ReactNode } from "react";
import { Eye, ListOrdered, RotateCcw } from "lucide-react";
import type { ProviderArtifact } from "../../../shared/solution";
import { splitSolutionSteps, type SolutionStep } from "../../../shared/steps";
import { MathTitle } from "./math-title";
import { SolutionArticle } from "./solution-article";

const NEXT_BUTTON =
  "cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover";
const QUIET_BUTTON =
  "inline-flex items-center gap-1.5 rounded-cs border border-cs-line bg-cs-surface px-3 py-1.5 text-xs font-semibold text-cs-ink-2 transition hover:border-cs-accent hover:text-cs-accent";

type FlatStep = { part: string | null; intro: string; firstOfPart: boolean; step: SolutionStep };

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-4 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3 sm:px-7">
      {children}
    </div>
  );
}

/**
 * How far the student has got is `revealed`, kept by the panel per solution
 * version so switching tabs does not start over: 0 the question, 1 the plan,
 * 1 + k the first k steps, steps + 2 the final answer too.
 */
export function HintStepper({
  artifact,
  revealed,
  onReveal,
  onShowAll,
  stepAction,
}: {
  artifact: ProviderArtifact;
  revealed: number;
  onReveal: (next: number) => void;
  /** Leaves the hints for the whole solution. */
  onShowAll: () => void;
  /** Something to put beside a step, such as asking about it. */
  stepAction?: (step: SolutionStep, part: string | null) => ReactNode;
}) {
  const steps = useMemo<FlatStep[] | null>(() => {
    const parts = splitSolutionSteps(artifact.stepByStep);
    if (!parts) return null;
    return parts.flatMap((part) =>
      part.steps.map((step, index) => ({
        part: part.heading,
        intro: index === 0 ? part.intro : "",
        firstOfPart: index === 0,
        step,
      })),
    );
  }, [artifact.stepByStep]);

  const exit = (
    <button type="button" onClick={onShowAll} className={QUIET_BUTTON}>
      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
      Show everything · 全部顯示
    </button>
  );

  if (!steps) {
    return (
      <div className="pb-4">
        <p className="mx-4 mt-4 rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-2 text-xs text-cs-ink-3 sm:mx-7">
          This solution is not laid out in steps, so here it is whole. 呢份答案未分步，以下係完整解答。
        </p>
        <SectionLabel>Solution</SectionLabel>
        <SolutionArticle source={artifact.stepByStep} compact />
        <SectionLabel>Final answer</SectionLabel>
        <SolutionArticle source={artifact.finalAnswer} compact />
        <div className="px-4 sm:px-7">{exit}</div>
      </div>
    );
  }

  const total = steps.length;
  const shownSteps = Math.max(0, Math.min(revealed - 1, total));
  const answerShown = revealed >= total + 2;
  const next =
    revealed === 0
      ? { label: "Show the plan · 顯示解題計劃", value: 1 }
      : shownSteps < total
        ? { label: `Show step ${shownSteps + 1} of ${total} · 顯示第 ${shownSteps + 1} 步`, value: revealed + 1 }
        : !answerShown
          ? { label: "Show the final answer · 顯示答案", value: total + 2 }
          : null;

  return (
    <div className="pb-4">
      <p className="mx-4 mt-4 rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-2 text-xs text-cs-ink-2 sm:mx-7">
        Try each part yourself before you open it. 每一步都先自己諗，諗完先揭開對答案。
      </p>

      <SectionLabel>The question · 題目</SectionLabel>
      <SolutionArticle source={artifact.interpretedProblem} compact />

      {revealed >= 1 ? (
        <>
          <SectionLabel>
            <span className="inline-flex items-center gap-1.5">
              <ListOrdered className="h-3.5 w-3.5" aria-hidden="true" />
              The plan · 解題計劃
            </span>
          </SectionLabel>
          <ol className="mx-4 mt-2 space-y-1 text-sm text-cs-ink-2 sm:mx-7">
            {steps.map((entry, index) => (
              <li key={index} className="flex flex-wrap gap-x-2">
                {entry.firstOfPart && entry.part ? (
                  <MathTitle text={entry.part} className="basis-full pt-1 text-xs font-semibold text-cs-ink-3" />
                ) : null}
                <MathTitle text={entry.step.title} className={index < shownSteps ? "text-cs-ink" : ""} />
              </li>
            ))}
          </ol>
        </>
      ) : null}

      {steps.slice(0, shownSteps).map((entry, index) => (
        <div key={index} className="mt-3 border-t border-cs-line-soft">
          {entry.firstOfPart && entry.part ? (
            <SectionLabel>
              <MathTitle text={entry.part} />
            </SectionLabel>
          ) : null}
          {entry.intro ? <SolutionArticle source={entry.intro} compact /> : null}
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-7">
            <MathTitle text={entry.step.title} className="font-display text-base font-semibold text-cs-ink" />
            {stepAction?.(entry.step, entry.part)}
          </div>
          <SolutionArticle source={entry.step.body} compact />
        </div>
      ))}

      {answerShown ? (
        <div className="mx-4 mt-4 rounded-cs border-2 border-cs-accent bg-cs-muted sm:mx-7">
          <SectionLabel>Final answer · 答案</SectionLabel>
          <SolutionArticle source={artifact.finalAnswer} compact />
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 px-4 sm:px-7">
        {next ? (
          <button type="button" onClick={() => onReveal(next.value)} className={NEXT_BUTTON}>
            {next.label}
          </button>
        ) : (
          <button type="button" onClick={() => onReveal(0)} className={QUIET_BUTTON}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Start again · 重新嚟過
          </button>
        )}
        {exit}
      </div>
    </div>
  );
}
