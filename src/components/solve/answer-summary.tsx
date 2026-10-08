// The answer summary at the top of the solutions (3 October 2026): every
// solver's final answer side by side, how far they line up with each other,
// and the cross-check in one tap until there is a verdict - then its
// verified answer and a ✓ or ✗ per solver. How they line up comes from a
// model that compares the answers once every solver has answered
// (hooks/use-align.ts, since 9 October 2026, the owner's call), without
// waiting for or starting the cross-check; the page compared the numbers by
// rule before, and got directions and answers showing their working wrong.
// Agreement is no proof - on B.8 four models agreed on the same wrong
// answer - which is what the cross-check is for.

import { Check, Hourglass, ListChecks, Loader2, Scale, X } from "lucide-react";
import type { Alignment } from "../../../shared/align";
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
import type { AlignState } from "@/hooks/use-align";
import { isJudgeActive, isRunActive, JUDGE_QUEUED, type JudgeRun, type ProviderRuns } from "@/hooks/use-solve";
import { effortBand } from "@/lib/effort-band";
import { scrollToStep, STEP_IDS } from "@/lib/journey";
import MathProse from "./math-prose";
import { MathTitle } from "./math-title";
import { ProviderLogo } from "./provider-logo";

// Status colours stay fixed on purpose, like the credit badges (CLAUDE.md).
const CHIP: Record<Alignment, { label: string; className: string; title: string }> = {
  aligned: {
    label: "一致 Agree",
    className: "border-[#c9dcc4] bg-[#eef6ea] text-[#3f7a3a]",
    title: "Its answers line up with the other answers' - values, units and directions.",
  },
  partial: {
    label: "部分一致 Partly",
    className: "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10]",
    title: "Some of its answers line up with the others', and some differ - in value or in direction.",
  },
  not_aligned: {
    label: "唔同 Differs",
    className: "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-[#c0392b]",
    title: "Its answers do not line up with the other answers'.",
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
  alignment = { status: "idle" },
  onCompareAgain,
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
  /** How the answers line up with each other (hooks/use-align.ts). */
  alignment?: AlignState;
  /** Compares the answers again, after a comparison that failed. */
  onCompareAgain?: () => void;
}) {
  const shown = order.filter((key) => runs[key].status !== "idle");
  const finished = shown.filter((key) => runs[key].status === "done");
  const running = shown.filter((key) => isRunActive(runs[key]));

  // Shown from the start of a run: the cross-check can be asked for before
  // any answer is in.
  if (!finished.length && !running.length) return null;

  const verdict = judgeRun.status === "done" ? judgeRun : null;
  const headline = !finished.length
    ? "Solving · 解緊題"
    : verdict
      ? `Cross-checked: ${verdict.judgement.correct.length} of ${verdict.solvers.length} correct · 已核對：${verdict.solvers.length} 個有 ${verdict.judgement.correct.length} 個啱`
      : `${finished.length} answer${finished.length === 1 ? "" : "s"} · ${finished.length} 個答案`;

  // How far the answers line up - from the comparison made once every
  // solver answered, for the answers it compared.
  const compared = alignment.status === "done" ? alignment : null;
  const alignmentOf = (key: ProviderKey): { alignment: Alignment; note: string } | null => {
    const index = compared ? compared.solvers.indexOf(key) : -1;
    const value = index >= 0 ? compared?.comparison.alignment[index] : null;
    return value ? { alignment: value, note: compared?.comparison.notes[index] ?? "" } : null;
  };
  const weighed = compared ? compared.solvers.filter((key) => alignmentOf(key)) : [];
  const aligned = weighed.filter((key) => alignmentOf(key)?.alignment === "aligned").length;
  const agreement =
    weighed.length < 2
      ? ""
      : aligned === weighed.length
        ? `The answers: all ${weighed.length} agree · 全部一致`
        : aligned >= 2
          ? `The answers: ${aligned} of ${weighed.length} agree · ${weighed.length} 個有 ${aligned} 個一致`
          : weighed.some((key) => alignmentOf(key)?.alignment === "partial")
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

      {alignment.status === "running" ? (
        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-cs-ink-3">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Comparing the answers... · 比較緊答案
        </p>
      ) : alignment.status === "error" ? (
        <p className="mt-0.5 text-sm text-cs-ink-3">
          The answers could not be compared. · 未能比較答案
          {onCompareAgain ? (
            <button
              type="button"
              onClick={onCompareAgain}
              className="ml-2 font-semibold text-cs-accent underline-offset-2 hover:underline"
            >
              Try again
            </button>
          ) : null}
        </p>
      ) : agreement ? (
        <p className="mt-0.5 text-sm text-cs-ink-2">{agreement}</p>
      ) : null}

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
          const lineUp = run.status === "done" && weighed.length > 1 ? alignmentOf(key) : null;
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
                  <>
                    <MathProse source={run.solution.finalAnswer} className="text-sm leading-6" />
                    {/* What the judge found differs from the others. */}
                    {lineUp?.note && lineUp.alignment !== "aligned" ? (
                      <MathTitle text={lineUp.note} className="mt-1 block text-xs text-[#7a5d10]" />
                    ) : null}
                  </>
                ) : isRunActive(run) ? (
                  <span className="flex items-center gap-1.5 text-xs text-cs-ink-3">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    Still solving...
                  </span>
                ) : (
                  <span className="text-xs text-cs-ink-3">No answer</span>
                )}
              </div>
              {lineUp ? (
                <span
                  className={`${CHIP_BASE} ${CHIP[lineUp.alignment].className} self-start`}
                  title={CHIP[lineUp.alignment].title}
                >
                  {CHIP[lineUp.alignment].label}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

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
