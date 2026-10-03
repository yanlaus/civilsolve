// A solution laid out for reading: the "All" view (the final answer first,
// then the problem, assumptions and working in one scroll) and the working
// cut into its steps with something beside each - the "Ask" button. Used by
// the solution panel and by the history, which shows a kept solution the
// same way.

import { useMemo } from "react";
import type { ProviderArtifact } from "../../../shared/solution";
import { splitSolutionSteps, type SolutionStep } from "../../../shared/steps";
import { MathTitle } from "./math-title";
import { SolutionArticle } from "./solution-article";

/** Something to put beside a step of the working, such as asking about it. */
export type StepAction = (step: SolutionStep) => React.ReactNode;

/**
 * The working, with `stepAction` beside each step when it can be cut into
 * steps (shared/steps.ts); rendered whole, as before, when it cannot.
 */
export function StepsArticle({ source, stepAction }: { source: string; stepAction?: StepAction }) {
  const parts = useMemo(() => (stepAction ? splitSolutionSteps(source) : null), [source, stepAction]);
  if (!parts) return <SolutionArticle source={source} compact />;
  return (
    <div>
      {parts.map((part, partIndex) => (
        <div key={partIndex}>
          {part.heading ? (
            <MathTitle
              text={part.heading}
              className="block px-4 pt-4 font-display text-base font-semibold text-cs-ink sm:px-7"
            />
          ) : null}
          {part.intro ? <SolutionArticle source={part.intro} compact /> : null}
          {part.steps.map((step, stepIndex) => (
            <div key={stepIndex}>
              <div className="flex flex-wrap items-center gap-2 px-4 pt-3 sm:px-7">
                <MathTitle text={step.title} className="font-display text-base font-semibold text-cs-ink" />
                {stepAction?.(step)}
              </div>
              <SolutionArticle source={step.body} compact />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The "All" view: the final answer first, then the rest of the solution in order. */
export function AllView({ artifact, stepAction }: { artifact: ProviderArtifact; stepAction?: StepAction }) {
  const sections: Array<{ label: string; source: string }> = [
    { label: "Problem", source: artifact.interpretedProblem },
    { label: "Assumptions", source: artifact.assumptions },
    { label: "Solution", source: artifact.stepByStep },
  ];
  return (
    <div className="pb-4">
      <div className="mx-4 mt-4 rounded-cs border-2 border-cs-accent bg-cs-muted sm:mx-7">
        <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3 sm:px-7">
          Final answer · 答案
        </div>
        <SolutionArticle source={artifact.finalAnswer} compact />
      </div>
      {sections
        .filter((section) => section.source.trim())
        .map((section) => (
          <div key={section.label} className="mt-2">
            <div className="px-4 pt-4 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3 sm:px-7">
              {section.label}
            </div>
            {section.label === "Solution" ? (
              <StepsArticle source={section.source} stepAction={stepAction} />
            ) : (
              <SolutionArticle source={section.source} compact />
            )}
          </div>
        ))}
    </div>
  );
}
