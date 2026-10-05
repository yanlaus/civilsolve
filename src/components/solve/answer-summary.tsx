// The answer summary at the top of the solutions (3 October 2026): every
// solver's final answer side by side, and the cross-check in one tap until
// there is a verdict - then its verified answer, a ✓ or ✗ per solver, and
// how far the answers agree, worked out on the page from the numbers and
// units each one states (shared/answers.ts, no model call). Nothing is
// compared before the verdict (the owner, 4 October 2026): agreement is no
// proof - on B.8 four models agreed on the same wrong answer.

import { useMemo } from "react";
import { Check, Hourglass, ListChecks, Loader2, Scale, X } from "lucide-react";
import { extractQuantities, groupAnswers, type Agreement } from "../../../shared/answers";
import { MAX_JUDGED_SOLUTIONS } from "../../../shared/judgement";
import type { EffortKey } from "../../../shared/prompt";
import {
  DEFAULT_JUDGE,
  PROVIDER_KEYS,
  providerDisplayName,
  type ModelChoice,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import { isJudgeActive, isRunActive, JUDGE_QUEUED, type JudgeRun, type ProviderRuns } from "@/hooks/use-solve";
import { effortBand } from "@/lib/effort-band";
import { scrollToStep, STEP_IDS } from "@/lib/journey";
import MathProse from "./math-prose";
import { ProviderLogo } from "./provider-logo";

// Status colours stay fixed on purpose, like the credit badges (CLAUDE.md).
const CHIP: Record<Agreement, { label: string; className: string; title: string }> = {
  agree: {
    label: "一致 Agree",
    className: "border-[#c9dcc4] bg-[#eef6ea] text-[#3f7a3a]",
    title: "Its numbers match the most common answer.",
  },
  partial: {
    label: "部分一致 Partly",
    className: "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10]",
    title: "Some of its numbers match, or only the signs differ - a sign convention, perhaps.",
  },
  differ: {
    label: "唔同 Differs",
    className: "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-[#c0392b]",
    title: "Its numbers do not match the other answers.",
  },
  unknown: {
    label: "無法比較 Can't compare",
    className: "border-cs-line bg-cs-muted text-cs-ink-3",
    title: "No number with a unit to compare in its final answer.",
  },
};

const CHIP_BASE =
  "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[0.7rem] font-medium leading-none";

export function AnswerSummary({
  order,
  runs,
  judgeRun,
  nameOf,
  judgeLabel,
  markOf,
  providerStatus,
  canRerun,
  locked,
  onPick,
  onCrossCheck,
  canQueue = false,
  onQueueCrossCheck,
  onStopJudge,
}: {
  /** The solution tabs' order. */
  order: ProviderKey[];
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  nameOf: (key: ProviderKey) => string;
  judgeLabel: string;
  /** What the verdict says about a solver, when there is one. */
  markOf: (key: ProviderKey) => "correct" | "wrong" | null;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  canRerun: boolean;
  locked: boolean;
  /** Opens a solver's tab. */
  onPick: (key: ProviderKey) => void;
  onCrossCheck: (judge: ModelChoice, providers: ProviderKey[], effort: EffortKey) => void;
  /** Whether a cross-check can be asked for now and sent once the solvers are done. */
  canQueue?: boolean;
  onQueueCrossCheck?: (judge: ModelChoice, effort: EffortKey) => void;
  /** Takes a queued cross-check back. */
  onStopJudge?: () => void;
}) {
  const shown = order.filter((key) => runs[key].status !== "idle");
  const finished = shown.filter((key) => runs[key].status === "done");
  const running = shown.filter((key) => isRunActive(runs[key]));

  // Re-read only when a solution changes, not on every tick of the clocks.
  const { groups, status } = useMemo(() => {
    const entries = PROVIDER_KEYS.flatMap((key) => {
      const run = runs[key];
      return run.status === "done"
        ? [{ key, quantities: extractQuantities(run.solution.finalAnswer) }]
        : [];
    });
    return groupAnswers(entries);
  }, [runs]);

  // Shown from the start of a run: the cross-check can be asked for before
  // any answer is in.
  if (!finished.length && !running.length) return null;

  const verdict = judgeRun.status === "done" ? judgeRun : null;
  const headline = !finished.length
    ? "Solving · 解緊題"
    : verdict
      ? `Cross-checked: ${verdict.judgement.correct.length} of ${verdict.solvers.length} correct · 已核對：${verdict.solvers.length} 個有 ${verdict.judgement.correct.length} 個啱`
      : `${finished.length} answer${finished.length === 1 ? "" : "s"} · ${finished.length} 個答案`;

  // How far the answers agree - shown once there is a verdict, never before.
  const comparable = finished.filter((key) => status.get(key) !== "unknown");
  const largest = groups[0] ?? [];
  const agreement =
    !verdict || finished.length < 2
      ? ""
      : comparable.length < 2
        ? "Not enough numbers to compare · 無法自動比較"
        : largest.length === comparable.length
          ? `The answers: all ${comparable.length} agree · 全部一致`
          : largest.length >= 2
            ? `The answers: ${largest.length} of ${comparable.length} agree · ${comparable.length} 個有 ${largest.length} 個一致`
            : comparable.some((key) => status.get(key) === "partial")
              ? "The answers partly agree · 答案部分一致"
              : "The answers differ · 答案各有不同";

  // The one-tap cross-check: the default judge, at high (or the nearest level
  // its route offers), over the first finished solutions in picker order -
  // the same as the cross-check section's defaults.
  const hasVerdict = judgeRun.status === "done";
  const judging = isJudgeActive(judgeRun);
  const toJudge = PROVIDER_KEYS.filter((key) => runs[key].status === "done").slice(0, MAX_JUDGED_SOLUTIONS);
  const judgeEffort = effortBand(providerStatus?.[DEFAULT_JUDGE.provider]).clamp("high");
  // Greyed out until two solutions are in (the owner, 4 October 2026). A tap
  // while other solvers still run is queued: sent once, when they are done,
  // so the verdict grades them all.
  const queued = judgeRun.status === "waiting" && judgeRun.message === JUDGE_QUEUED;
  const queueable = running.length > 0 && canQueue && Boolean(onQueueCrossCheck);
  const blocked = !canRerun
    ? "Needs this run's images, which this browser no longer has."
    : locked
      ? "Waits until the new upload is ready."
      : toJudge.length < 2
        ? "Needs at least two finished solutions."
        : running.length && !queueable
          ? "Waits for the solvers still running."
          : "";
  const judgeName = providerDisplayName(DEFAULT_JUDGE.provider, DEFAULT_JUDGE.variant);
  // Clear of the sticky step bar (lib/journey.ts).
  const scrollToCrossCheck = () => scrollToStep(STEP_IDS.check);

  return (
    <div className="cs-panel mb-4 rounded-cs-lg border border-cs-line-soft bg-cs-surface p-4 shadow-[0_1px_3px_var(--cs-shadow)] print:hidden sm:p-5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-cs-ink">
        <ListChecks className="h-4 w-4 text-cs-accent" aria-hidden="true" />
        Answer summary · 答案總覽
      </p>
      <p className="mt-1 text-base font-semibold text-cs-ink">
        {headline}
        {running.length ? (
          <span className="ml-2 text-xs font-normal text-cs-ink-3">
            ({running.length} still solving)
          </span>
        ) : null}
      </p>

      {agreement ? <p className="mt-0.5 text-sm text-cs-ink-2">{agreement}</p> : null}

      {hasVerdict && judgeRun.judgement.final_answer ? (
        <div className="mt-3 rounded-cs border-2 border-cs-accent bg-cs-muted px-3 py-2">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
            Verified answer · 核對後答案 <span className="normal-case tracking-normal">({judgeLabel})</span>
          </div>
          <MathProse source={judgeRun.judgement.final_answer} className="text-sm" />
        </div>
      ) : null}

      <ul className="mt-3 divide-y divide-cs-line-soft">
        {shown.map((key) => {
          const run = runs[key];
          const mark = markOf(key);
          const agrees = verdict && run.status === "done" && finished.length > 1 ? status.get(key) : undefined;
          return (
            <li key={key} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3">
              <button
                type="button"
                onClick={() => onPick(key)}
                className="flex shrink-0 items-center gap-1.5 text-left text-sm font-semibold text-cs-ink hover:text-cs-accent sm:w-40"
                title={`Open ${nameOf(key)}'s solution`}
              >
                <ProviderLogo provider={key} className="h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{nameOf(key)}</span>
                {mark === "correct" ? (
                  <Check className="h-3.5 w-3.5 text-cs-success" aria-label="Judged correct" />
                ) : mark === "wrong" ? (
                  <X className="h-3.5 w-3.5 text-cs-danger" aria-label="Judged wrong" />
                ) : null}
              </button>
              <div className="min-w-0 flex-1">
                {run.status === "done" ? (
                  <MathProse source={run.solution.finalAnswer} className="text-sm leading-6" />
                ) : isRunActive(run) ? (
                  <span className="flex items-center gap-1.5 text-xs text-cs-ink-3">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Still solving...
                  </span>
                ) : (
                  <span className="text-xs text-cs-ink-3">No answer</span>
                )}
              </div>
              {agrees ? (
                <span className={`${CHIP_BASE} ${CHIP[agrees].className} self-start`} title={CHIP[agrees].title}>
                  {CHIP[agrees].label}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {verdict && finished.length > 1 ? (
        <p className="mt-2 text-xs text-cs-ink-3">
          ✓ / ✗ is the judge&apos;s verdict. 一致 / 唔同 only compares the numbers and units in each final
          answer, worked out on the page.
        </p>
      ) : null}

      {queued ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-cs border border-dashed border-cs-accent bg-cs-muted px-3 py-2 text-sm text-cs-ink-2">
          <Hourglass className="h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">答案出齊就核對一次</span> · The cross-check runs once, when
            the answers are in.
          </span>
          {onStopJudge ? (
            <button
              type="button"
              onClick={onStopJudge}
              className="text-xs font-semibold text-cs-ink-3 underline-offset-2 hover:text-cs-danger hover:underline"
            >
              Cancel · 取消
            </button>
          ) : null}
        </div>
      ) : !hasVerdict ? (
        <div className="mt-3 flex flex-col gap-2">
          {/* The button on a line of its own, its description under it (the owner, 4 October 2026). */}
          <button
            type="button"
            disabled={judging || Boolean(blocked)}
            onClick={() =>
              queueable
                ? onQueueCrossCheck?.(DEFAULT_JUDGE, judgeEffort)
                : onCrossCheck(DEFAULT_JUDGE, toJudge, judgeEffort)
            }
            className={`flex w-full items-center justify-center gap-2 rounded-cs px-4 py-2.5 text-sm font-semibold transition ${
              judging || blocked
                ? "cursor-not-allowed bg-cs-sunken text-cs-ink-3"
                : "cs-primary bg-cs-accent text-cs-on-accent hover:bg-cs-accent-hover"
            }`}
          >
            <Scale className="h-4 w-4" aria-hidden="true" />
            {judging ? "Cross-checking..." : "核對答案 · Run the cross-check"}
          </button>
          <span className="text-xs text-cs-ink-3">
            {(blocked && `${blocked} `) ||
              (queueable
                ? `${judgeName} grades the solutions once every solver is done - one model call. `
                : `${judgeName} grades ${toJudge.length} solutions - one model call. `)}
            <button type="button" onClick={scrollToCrossCheck} className="font-semibold text-cs-accent underline-offset-2 hover:underline">
              Choose the judge
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
