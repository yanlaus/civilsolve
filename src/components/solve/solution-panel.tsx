import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  Languages,
  Loader2,
  RotateCw,
  Scale,
  TriangleAlert,
  X,
} from "lucide-react";
import { SOLUTION_LETTERS } from "../../../shared/judgement";
import {
  PROVIDER_KEYS,
  PROVIDER_VARIANTS,
  providerDisplayName,
  type ModelChoice,
  type ModelVariant,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import type { EffortKey } from "../../../shared/prompt";
import type { ProviderArtifact } from "../../../shared/solution";
import { STUDY_KINDS, type StudyKind } from "../../../shared/study";
import {
  isJudgeActive,
  isRunActive,
  isStudyActive,
  type ConfirmedInterpretation,
  type JudgeRun,
  type ProgressMap,
  type ProviderRuns,
  type RunVariants,
  type SolutionVersions,
  type StudyProgress,
  type StudyRuns,
  type StudySource,
} from "@/hooks/use-solve";
import { exportPdf } from "@/lib/exports";
import { renderMarkdown } from "@/lib/math-markdown";
import { useNow, type Progress } from "@/lib/progress";
import MathProse from "./math-prose";
import { ProviderLogo } from "./provider-logo";
import { RevisePanel, RevisedWith, RevisionNotice } from "./revise-panel";
import { RunActions } from "./run-actions";
import { SolutionArticle } from "./solution-article";
import { StudyNotes } from "./study-notes";
import {
  ERROR_BOX,
  EventLog,
  ProgressBox,
  STOPPED_BOX,
  STOPPED_DOT,
  TIMEOUT_BOX,
  TIMEOUT_DOT,
  tookLabel,
} from "./task-status";
import { PROVIDER_OPTIONS } from "./upload-form";

type ViewKey = "problem" | "assumptions" | "steps" | "answer";

const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: "problem", label: "Problem" },
  { key: "assumptions", label: "Assumptions" },
  { key: "steps", label: "Solution" },
  { key: "answer", label: "Final Answer" },
];

function viewSource(artifact: ProviderArtifact, view: ViewKey) {
  return view === "problem"
    ? artifact.interpretedProblem
    : view === "assumptions"
      ? artifact.assumptions
      : view === "steps"
        ? artifact.stepByStep
        : artifact.finalAnswer;
}

/** What the verdict says about one solver: correct, wrong, or not judged. */
function solverMark(
  judgeRun: JudgeRun,
  provider: ProviderKey,
  versions: SolutionVersions,
): "correct" | "wrong" | null {
  if (judgeRun.status !== "done") return null;
  const index = judgeRun.solvers.indexOf(provider);
  if (index < 0 || changedSinceVerdict(judgeRun, provider, versions)) return null;
  return judgeRun.judgement.correct.includes(index) ? "correct" : "wrong";
}

/**
 * Whether the solution on the page is a newer version than the one the
 * verdict graded - re-generated or retried since. Unknown (a verdict picked
 * back up after a reload) counts as unchanged.
 */
function changedSinceVerdict(judgeRun: JudgeRun, provider: ProviderKey, versions: SolutionVersions) {
  if (judgeRun.status !== "done" || !judgeRun.versions) return false;
  return (versions[provider] ?? 0) > (judgeRun.versions[provider] ?? 0);
}

/**
 * A model as the study notes' picker lists it: a provider that offers several
 * models is named with one - its first, when the run did not record which.
 */
function studyModel(choice: ModelChoice): ModelChoice {
  const offered = PROVIDER_VARIANTS[choice.provider];
  return offered && !choice.variant ? { ...choice, variant: offered[0].key } : choice;
}

/** "Gemini's solution is correct", "Gemini and Muse Spark are correct", ... */
function verdictHeadline(labels: string[], correct: number[]) {
  if (correct.length === 0) {
    return labels.length === 2 ? "Neither solution is correct" : "None of the solutions is correct";
  }
  if (correct.length === labels.length) {
    return labels.length === 2 ? "Both solutions are correct" : "All solutions are correct";
  }
  const names = correct.map((index) => labels[index]);
  if (names.length === 1) return `${names[0]}'s solution is correct`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are correct`;
}

/**
 * The confirmed interpretation, kept above the solutions for as long as they
 * are on the page - it used to vanish on Confirm & Solve (the owner asked for
 * it to stay, 26 September 2026). Rendered like a solution; the Traditional
 * Chinese is a fold away.
 */
function InterpretationCard({ interpretation }: { interpretation: ConfirmedInterpretation }) {
  const { text, chinese, credit, note } = interpretation;
  return (
    <details
      open
      className="cs-panel group mb-8 overflow-hidden rounded-cs-lg border border-cs-line-soft bg-cs-surface shadow-[0_4px_16px_var(--cs-shadow)] print:hidden"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 sm:px-7">
        <span className="flex flex-1 items-center gap-2 font-display text-lg font-semibold text-cs-ink sm:flex-none">
          <BookOpen className="h-4 w-4 text-cs-accent" aria-hidden="true" />
          Interpreted question
        </span>
        {/* On a phone the remark goes under the heading, not squeezed beside it. */}
        <span className="order-last basis-full text-xs text-cs-ink-3 sm:order-none sm:basis-0 sm:flex-1">
          confirmed by you{credit ? ` · read by ${credit}` : ""} · what the solvers were given
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-cs-ink-3 transition group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="border-t border-cs-line-soft px-5 pb-5 pt-3 sm:px-7">
        {note ? (
          <div className="mb-3 flex gap-2 rounded-cs border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-2 text-xs text-[#a85a12]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{note}</span>
          </div>
        ) : null}
        <MathProse source={text} />
        {chinese ? (
          <details className="group/zh mt-3 rounded-cs border border-cs-line-soft bg-cs-muted">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
              <Languages className="h-3.5 w-3.5" aria-hidden="true" />
              繁體中文 · Traditional Chinese
              <ChevronDown
                className="ml-auto h-3.5 w-3.5 transition group-open/zh:rotate-180"
                aria-hidden="true"
              />
            </summary>
            <div className="border-t border-cs-line-soft px-4 py-2">
              <MathProse source={chinese} chinese />
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}

export default function SolutionPanel({
  runs,
  judgeRun,
  progress,
  judgeProgress,
  variants,
  interpretation,
  solutionVersions,
  providerStatus,
  canRerun,
  locked,
  onSolveProvider,
  onStopProvider,
  onRefineProvider,
  onCrossCheck,
  onStopJudge,
  onRefineVerdict,
  studyRuns,
  studyProgress,
  onWriteStudy,
  onStopStudy,
  onRefineStudy,
}: {
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  progress: ProgressMap;
  judgeProgress: Progress | null;
  /** The model each solver and the judge ran, where a provider offers several. */
  variants: RunVariants;
  /** The confirmed interpretation the run was solved with, if it had one. */
  interpretation: ConfirmedInterpretation | null;
  /** Which version of each solution is on the page, to tell one changed since the verdict. */
  solutionVersions: SolutionVersions;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** Whether the run's images are still at hand, for a retry, another solver or a cross-check. */
  canRerun: boolean;
  /** True while the page prepares or reads a new upload. */
  locked: boolean;
  onSolveProvider: (provider: ProviderKey, variant?: ModelVariant) => void;
  onStopProvider: (provider: ProviderKey) => void;
  /** Re-generates one finished solution with the user's instructions. */
  onRefineProvider: (provider: ProviderKey, instructions: string) => void;
  onCrossCheck: (judge: ModelChoice, providers: ProviderKey[], effort: EffortKey) => void;
  onStopJudge: () => void;
  /** Re-generates the verdict with the user's instructions. */
  onRefineVerdict: (instructions: string) => void;
  /** The optional study notes under the solutions, by kind. */
  studyRuns: StudyRuns;
  studyProgress: StudyProgress;
  onWriteStudy: (kind: StudyKind, choice: ModelChoice, effort: EffortKey, source: StudySource) => void;
  onStopStudy: (kind: StudyKind) => void;
  onRefineStudy: (kind: StudyKind, instructions: string) => void;
}) {
  const [activeProvider, setActiveProvider] = useState<ProviderKey>(PROVIDER_KEYS[0]);
  const [activeView, setActiveView] = useState<ViewKey>("steps");

  // Picker order: the order the solvers were ticked in, and the judge's A, B...
  const visibleProviders = PROVIDER_OPTIONS.filter(
    (provider) => runs[provider.key].status !== "idle",
  );
  // "Gemini (3.1 Pro)" when the run picked one of a provider's models.
  const nameOf = (key: ProviderKey) => providerDisplayName(key, variants.solvers[key]);
  const firstDone = visibleProviders.find(
    (provider) => runs[provider.key].status === "done",
  )?.key;

  // Set once the user opens a tab themselves: from then on the page stops
  // choosing for them. Without it, opening a failed or timed-out tab while
  // another had finished bounced straight back to the finished one, so the
  // failure's message could never be read.
  const userPicked = useRef(false);
  const pickProvider = (key: ProviderKey) => {
    userPicked.current = true;
    setActiveProvider(key);
  };
  // A retried or added solver's tab is where its progress shows.
  const solveWith = (key: ProviderKey, variant?: ModelVariant) => {
    pickProvider(key);
    onSolveProvider(key, variant);
  };
  const judgeBusy = isJudgeActive(judgeRun);

  // Auto-activate the first finished provider once, or keep a sensible tab
  // active while the current one has nothing to show yet.
  useEffect(() => {
    // A fresh run, nothing finished yet: the page may choose again.
    if (visibleProviders.every((provider) => isRunActive(runs[provider.key]))) {
      userPicked.current = false;
    }
    if (runs[activeProvider].status === "idle" && visibleProviders.length) {
      setActiveProvider(firstDone ?? visibleProviders[0].key);
    } else if (
      !userPicked.current &&
      firstDone &&
      runs[activeProvider].status !== "done" &&
      !isRunActive(runs[activeProvider])
    ) {
      setActiveProvider(firstDone);
    }
  }, [runs, activeProvider, firstDone, visibleProviders]);

  const activeRun = runs[activeProvider];
  const activeArtifact = activeRun.status === "done" ? activeRun.solution : null;
  const activeLabel = nameOf(activeProvider);
  const activeProgress = progress[activeProvider];
  // Ticks every second while anything is still running, for the clocks.
  const solving = visibleProviders.some((provider) => isRunActive(runs[provider.key]));
  const now = useNow(
    solving || isJudgeActive(judgeRun) || STUDY_KINDS.some((kind) => isStudyActive(studyRuns[kind])),
  );

  // What "Save as PDF" prints: the open solution, or the verdict. Set just
  // before printing (flushSync, so the print area has it when the dialog
  // opens) and left as it is afterwards - each button sets its own.
  const [printTarget, setPrintTarget] = useState<"solution" | "verdict">("solution");
  const printAs = (target: "solution" | "verdict", title: string) => {
    flushSync(() => setPrintTarget(target));
    exportPdf(title);
  };

  // The verdict's PDF is its verified final answer and nothing else - the
  // answer is what gets kept (the owner's call, 27 September 2026).
  const verdictPrintHtml = useMemo(() => {
    if (judgeRun.status !== "done" || !judgeRun.judgement.final_answer) return "";
    return ["<h1>Verified final answer</h1>", renderMarkdown(judgeRun.judgement.final_answer)].join("\n");
  }, [judgeRun]);

  const printHtml = useMemo(() => {
    if (!activeArtifact) return "";
    const escapedTitle = activeArtifact.title
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return [
      `<h1>${escapedTitle}</h1>`,
      "<h2>Interpreted Problem</h2>",
      renderMarkdown(activeArtifact.interpretedProblem),
      "<h2>Assumptions</h2>",
      renderMarkdown(activeArtifact.assumptions),
      "<h2>Solution</h2>",
      renderMarkdown(activeArtifact.stepByStep),
      "<h2>Final Answer</h2>",
      renderMarkdown(activeArtifact.finalAnswer),
    ].join("\n");
  }, [activeArtifact]);

  if (!visibleProviders.length) return null;

  return (
    <section className="mt-10">
      {interpretation ? <InterpretationCard interpretation={interpretation} /> : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h2 className="flex items-center gap-2 font-display text-2xl font-bold text-cs-ink">
          <CheckCircle2 className="h-5 w-5 text-cs-success" />
          Solutions
        </h2>
      </div>

      <div className="cs-panel overflow-hidden rounded-cs-lg border border-cs-line-soft bg-cs-surface shadow-[0_4px_16px_var(--cs-shadow)] print:hidden">
        <div className="border-b-2 border-cs-line-soft px-2 pt-1">
          <div className="flex overflow-x-auto">
            {visibleProviders.map((provider) => {
              const run = runs[provider.key];
              const mark = solverMark(judgeRun, provider.key, solutionVersions);
              return (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => pickProvider(provider.key)}
                  className={`relative shrink-0 px-4 py-3 pr-8 text-left text-sm font-semibold transition ${
                    activeProvider === provider.key
                      ? "text-cs-accent"
                      : "text-cs-ink-3 hover:text-cs-ink"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <ProviderLogo provider={provider.key} className="h-4 w-4 shrink-0" />
                    {nameOf(provider.key)}
                    {mark === "correct" ? (
                      <Check className="h-3.5 w-3.5 text-cs-success" aria-label="Judged correct" />
                    ) : mark === "wrong" ? (
                      <X className="h-3.5 w-3.5 text-cs-danger" aria-label="Judged wrong" />
                    ) : null}
                  </div>
                  <span
                    className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                      activeProvider === provider.key ? "bg-cs-accent" : "bg-transparent"
                    }`}
                  />
                  {isRunActive(run) ? (
                    <Loader2 className="absolute right-2.5 top-3 h-3 w-3 animate-spin text-cs-ink-3" />
                  ) : (
                    <span
                      title={
                        run.status === "error"
                          ? run.stopped
                            ? "Stopped - no solution"
                            : run.timedOut
                              ? "Timed out - no solution"
                              : "Failed - no solution"
                          : "Finished"
                      }
                      className={`absolute right-3 top-3 h-2.5 w-2.5 rounded-full ${
                        run.status === "error"
                          ? run.stopped
                            ? STOPPED_DOT
                            : run.timedOut
                              ? TIMEOUT_DOT
                              : "bg-cs-danger"
                          : "bg-cs-success"
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {activeArtifact ? (
          <>
            <div className="border-b border-cs-line-soft px-7 py-5">
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-cs-ink-3">
                {activeLabel}
                {tookLabel(activeProgress) || (activeRun.status === "done" && activeRun.model) ? (
                  <span className="ml-2 font-normal normal-case tracking-normal">
                    answered
                    {tookLabel(activeProgress) ? ` in ${tookLabel(activeProgress)}` : ""}
                    {activeRun.status === "done" && activeRun.model ? ` with ${activeRun.model}` : ""}
                  </span>
                ) : null}
              </div>
              <div className="font-display text-2xl font-semibold text-cs-ink">
                {activeArtifact.title}
              </div>
              {activeRun.status === "done" && activeRun.revisedWith ? (
                <RevisedWith instructions={activeRun.revisedWith} />
              ) : null}
              {activeRun.status === "done" && activeRun.notice ? (
                <div className="mt-3">
                  <RevisionNotice message={activeRun.notice} />
                </div>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => printAs("solution", activeArtifact.title)}
                  className="inline-flex items-center gap-2 rounded-cs bg-cs-ink px-4 py-2 text-sm font-semibold text-cs-surface"
                >
                  <Download className="h-4 w-4" />
                  Save as PDF
                </button>
              </div>
            </div>

            <div className="border-b-2 border-cs-line-soft px-2 pt-1">
              <div className="flex overflow-x-auto">
                {VIEWS.map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    onClick={() => setActiveView(view.key)}
                    className={`relative shrink-0 px-4 py-3 text-sm font-semibold transition ${
                      activeView === view.key
                        ? "text-cs-accent"
                        : "text-cs-ink-3 hover:text-cs-ink"
                    }`}
                  >
                    {view.label}
                    <span
                      className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                        activeView === view.key ? "bg-cs-accent" : "bg-transparent"
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>

            <SolutionArticle source={viewSource(activeArtifact, activeView)} />

            <div className="border-t border-cs-line-soft px-4 py-4 sm:px-7">
              <RevisePanel
                title={`Not right? Give ${activeLabel} instructions and re-generate`}
                placeholder="e.g. The inclined jet is 30° from the vertical, not the horizontal. Take the inlet pressure as gauge. Show the continuity step."
                hint={`Sends the question images, your notes${
                  interpretation ? ", the confirmed reading" : ""
                }, this solution and your instructions back to ${activeLabel}, which writes a new version. This one stays if that fails.`}
                disabledReason={
                  !canRerun
                    ? "Needs this run's images, which this browser no longer has."
                    : locked
                      ? "Waits until the new upload is ready."
                      : judgeBusy
                        ? "Waits for the cross-check to finish."
                        : undefined
                }
                onSubmit={(instructions) => onRefineProvider(activeProvider, instructions)}
              />
            </div>
          </>
        ) : (
          <div className="px-7 py-8">
            {activeRun.status === "error" ? (
              <div
                className={`rounded-cs border px-4 py-3 text-sm ${
                  activeRun.stopped ? STOPPED_BOX : activeRun.timedOut ? TIMEOUT_BOX : ERROR_BOX
                }`}
              >
                <div className="font-semibold">
                  {activeRun.stopped
                    ? "Stopped - no solution"
                    : activeRun.timedOut
                      ? "Timed out - no solution returned"
                      : "No solution returned"}
                  {tookLabel(activeProgress) ? (
                    <span className="font-normal"> after {tookLabel(activeProgress)}</span>
                  ) : null}
                </div>
                <div className="mt-1">{activeRun.message}</div>
                <EventLog progress={activeProgress} />
                {canRerun ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => solveWith(activeProvider)}
                      disabled={locked || judgeBusy}
                      className="inline-flex items-center gap-2 rounded-[10px] border-2 border-current px-3 py-1.5 text-sm font-semibold transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCw className="h-4 w-4" aria-hidden="true" />
                      {activeRun.stopped ? `Run ${activeLabel} again` : `Retry ${activeLabel}`}
                    </button>
                    {judgeBusy ? (
                      <span className="text-xs opacity-80">Waits for the cross-check to finish.</span>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-3 text-xs opacity-80">
                    To try again, upload the question again - this browser no longer has its images.
                  </p>
                )}
              </div>
            ) : (
              <ProgressBox
                now={now}
                progress={activeProgress}
                line={
                  activeRun.status === "streaming"
                    ? `${activeLabel} is writing the solution... ${activeRun.charsReceived.toLocaleString()} characters received.`
                    : activeRun.status === "waiting"
                      ? activeRun.message
                      : "Waiting..."
                }
                onStop={isRunActive(activeRun) ? () => onStopProvider(activeProvider) : undefined}
                stopTitle={`Stop ${activeLabel} - the other solvers carry on`}
              />
            )}
          </div>
        )}
      </div>

      <RunActions
        runs={runs}
        judgeRun={judgeRun}
        variants={variants}
        providerStatus={providerStatus}
        canRerun={canRerun}
        locked={locked}
        onSolveProvider={solveWith}
        onCrossCheck={onCrossCheck}
      />

      {/* The verdict comes last, under the controls that run it: it is read
          after the solutions, not before them (the owner's order since
          26 September 2026). */}
      {judgeRun.status !== "idle" ? (
        <div className="mt-4">
          <JudgementCard
            judgeRun={judgeRun}
            runs={runs}
            variants={variants}
            solutionVersions={solutionVersions}
            progress={judgeProgress ?? undefined}
            now={now}
            onStop={onStopJudge}
            refineBlocked={
              !canRerun
                ? "Needs this run's images, which this browser no longer has."
                : locked
                  ? "Waits until the new upload is ready."
                  : solving
                    ? "Waits for every solver to finish."
                    : undefined
            }
            interpretation={Boolean(interpretation)}
            onRefine={onRefineVerdict}
            onSavePdf={() => printAs("verdict", "verified final answer")}
          />
        </div>
      ) : null}

      {/* Study notes last: written from a solution or the verdict above, as
          picked on each card, and never sent back to the cross-check. */}
      {visibleProviders.some((provider) => runs[provider.key].status === "done") ||
      STUDY_KINDS.some((kind) => studyRuns[kind].status !== "idle") ? (
        <StudyNotes
          studyRuns={studyRuns}
          studyProgress={studyProgress}
          runs={runs}
          judgeRun={judgeRun}
          now={now}
          providerStatus={providerStatus}
          nameOf={nameOf}
          judgeLabel={judgeRun.status !== "idle" ? providerDisplayName(judgeRun.judge, variants.judge) : ""}
          markOf={(key) => solverMark(judgeRun, key, solutionVersions)}
          modelOf={(source) =>
            studyModel(
              source === "verdict" && judgeRun.status !== "idle"
                ? { provider: judgeRun.judge, variant: variants.judge }
                : { provider: source as ProviderKey, variant: variants.solvers[source as ProviderKey] },
            )
          }
          interpretation={Boolean(interpretation)}
          blocked={
            !canRerun
              ? "Needs this run's images, which this browser no longer has. Upload the question again to make notes."
              : locked
                ? "Waits until the new upload is ready."
                : undefined
          }
          onWrite={onWriteStudy}
          onStop={onStopStudy}
          onRefine={onRefineStudy}
        />
      ) : null}

      {/* Hidden on screen; the only visible content when printing (Save as PDF). */}
      {(printTarget === "verdict" ? verdictPrintHtml : printHtml) ? (
        <div
          className="print-area solution-content prose prose-stone hidden max-w-none print:block"
          dangerouslySetInnerHTML={{
            __html: printTarget === "verdict" ? verdictPrintHtml : printHtml,
          }}
        />
      ) : null}
    </section>
  );
}

const CONFIDENCE_CLASS = {
  high: "border-[#c9dcc4] bg-[#eef6ea] text-[#3f7a3a]",
  medium:
    "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10]",
  low: "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-cs-danger",
} as const;


function Assessment({
  label,
  letter,
  text,
  chinese,
  correct,
}: {
  label: string;
  letter: string;
  text: string;
  /** The same assessment in Traditional Chinese, when the judge wrote it. */
  chinese?: string;
  correct: boolean;
}) {
  return (
    <div className="min-w-0 rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
        {correct ? (
          <Check className="h-3.5 w-3.5 text-cs-success" aria-hidden="true" />
        ) : (
          <X className="h-3.5 w-3.5 text-cs-danger" aria-hidden="true" />
        )}
        Solution {letter} · {label}
      </div>
      {text ? <MathProse source={text} /> : <p className="text-sm text-cs-ink-3">No assessment given.</p>}
      {chinese?.trim() ? (
        <div className="mt-2 border-t border-cs-line-soft pt-2">
          <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            繁體中文
          </div>
          <MathProse source={chinese} chinese />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The answer cross-check's result: which solvers the judge found correct,
 * the judge's own verified answer, and what each solution got wrong. The
 * judge only ever saw "Solution A", "Solution B", ...; the provider names
 * are added back here from the order the solvers ran in.
 */
function JudgementCard({
  judgeRun,
  runs,
  variants,
  progress,
  now,
  onStop,
  solutionVersions,
  refineBlocked,
  interpretation,
  onRefine,
  onSavePdf,
}: {
  judgeRun: JudgeRun;
  /** The solvers now, to tell which finished after this verdict was given. */
  runs: ProviderRuns;
  variants: RunVariants;
  progress?: Progress;
  now: number;
  onStop: () => void;
  solutionVersions: SolutionVersions;
  /** Why the verdict cannot be re-generated right now, if it cannot. */
  refineBlocked?: string;
  /** Whether the run had a confirmed reading, which the judge also gets. */
  interpretation: boolean;
  onRefine: (instructions: string) => void;
  /** Prints the verified final answer as a PDF. */
  onSavePdf: () => void;
}) {
  if (judgeRun.status === "idle") return null;
  const judgeLabel = providerDisplayName(judgeRun.judge, variants.judge);
  const nameOf = (key: ProviderKey) => providerDisplayName(key, variants.solvers[key]);

  if (judgeRun.status === "error") {
    return (
      <div
        className={`mb-4 rounded-cs border px-4 py-3 text-sm print:hidden ${
          judgeRun.stopped ? STOPPED_BOX : judgeRun.timedOut ? TIMEOUT_BOX : ERROR_BOX
        }`}
      >
        <div className="flex items-center gap-3">
          <Scale className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">
              Cross-check ({judgeLabel})
              {judgeRun.stopped ? " stopped" : judgeRun.timedOut ? " timed out" : ""}
              {tookLabel(progress) ? ` after ${tookLabel(progress)}` : ""}:{" "}
            </span>
            {judgeRun.stopped
              ? "No verdict. Run the cross-check again above when you want one."
              : judgeRun.message}
          </span>
        </div>
        <EventLog progress={progress} />
      </div>
    );
  }

  if (judgeRun.status !== "done") {
    // Until every solver finishes the judge has not started, so there is no
    // clock yet - just the wait.
    return (
      <div className="mb-4 print:hidden">
        <ProgressBox
          now={now}
          progress={progress}
          line={`Cross-check (${judgeLabel}): ${
            judgeRun.status === "streaming"
              ? `writing the verdict... ${judgeRun.charsReceived.toLocaleString()} characters received.`
              : judgeRun.message
          }`}
          onStop={onStop}
          stopTitle="Stop the cross-check - the solutions stay"
        />
      </div>
    );
  }

  const { judgement, solvers } = judgeRun;
  const labels = solvers.map(nameOf);
  // A solver retried or added after the verdict: not graded by it, and no
  // longer "returned no solution" once it has one.
  const notGraded = PROVIDER_KEYS.filter(
    (provider) => runs[provider].status === "done" && !solvers.includes(provider),
  );
  // Re-generated (or retried) since the verdict: the verdict is about the
  // version before.
  const changed = solvers.filter((provider) => changedSinceVerdict(judgeRun, provider, solutionVersions));
  const skipped = judgeRun.skipped.filter((provider) => runs[provider].status !== "done");
  const headlineTone =
    judgement.correct.length === 0
      ? "text-cs-danger"
      : "text-cs-success";

  return (
    <div className="cs-panel mb-4 rounded-cs-lg border-2 border-cs-accent bg-cs-surface p-5 shadow-[0_0_0_4px_var(--cs-ring)] print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Scale className="h-4 w-4 text-cs-accent" aria-hidden="true" />
          Cross-check verdict
          <span className="font-sans text-sm font-normal text-cs-ink-3">
            judged by {judgeLabel}
            {variants.judgeEffort ? ` at ${variants.judgeEffort} thinking` : ""}
            {tookLabel(progress) ? ` in ${tookLabel(progress)}` : ""}
          </span>
        </p>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.7rem] font-medium ${CONFIDENCE_CLASS[judgement.confidence]}`}
        >
          {judgement.confidence} confidence
        </span>
      </div>

      {/* The verdict itself, first and on its own: which solution is right,
          which is wrong - before any of the reasoning. */}
      <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Verdict per solution">
        {solvers.map((provider, index) => {
          const correct = judgement.correct.includes(index);
          return (
            <li
              key={provider}
              className={`flex items-center gap-2 rounded-cs border px-3 py-2 text-sm font-semibold ${
                correct
                  ? "border-[#c9dcc4] bg-[#eef6ea] text-[#3f7a3a]"
                  : "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-cs-danger"
              }`}
            >
              {correct ? (
                <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <X className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">
                {SOLUTION_LETTERS[index] ?? String(index + 1)} · {nameOf(provider)}
              </span>
              <span className="shrink-0">{correct ? "Correct 正確" : "Wrong 錯誤"}</span>
            </li>
          );
        })}
      </ul>

      <p className={`mt-3 text-base font-semibold ${headlineTone}`}>
        {verdictHeadline(labels, judgement.correct)}
      </p>
      {skipped.length ? (
        <p className="mt-1 text-xs text-cs-ink-3">
          Not graded: {skipped.map(nameOf).join(", ")} returned
          no solution.
        </p>
      ) : null}
      {notGraded.length ? (
        <p className="mt-1 text-xs font-medium text-[#a85a12]">
          Not in this verdict: {notGraded.map(nameOf).join(", ")}{" "}
          finished after it. Run the cross-check again above to include{" "}
          {notGraded.length === 1 ? "it" : "them"}.
        </p>
      ) : null}
      {changed.length ? (
        <p className="mt-1 text-xs font-medium text-[#a85a12]">
          {changed.map(nameOf).join(", ")} {changed.length === 1 ? "has" : "have"} a new
          version since this verdict, which graded the one before. Re-generate the verdict below,
          or run the cross-check again above, to grade the new one.
        </p>
      ) : null}
      {judgeRun.revisedWith ? <RevisedWith instructions={judgeRun.revisedWith} /> : null}
      {judgeRun.notice ? (
        <div className="mt-2">
          <RevisionNotice message={judgeRun.notice} />
        </div>
      ) : null}

      {judgement.final_answer ? (
        <div className="mt-3">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
              Verified final answer
            </span>
            <button
              type="button"
              onClick={onSavePdf}
              title="Save the verified final answer as a PDF"
              className="inline-flex items-center gap-1.5 rounded-cs bg-cs-ink px-3 py-1.5 text-xs font-semibold text-cs-surface"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Save as PDF
            </button>
          </div>
          <MathProse source={judgement.final_answer} />
        </div>
      ) : null}

      {/* The reasoning, for whoever wants it: each solution's assessment,
          why, and the Traditional Chinese version. */}
      {/* Open to begin with (the owner's call, 27 September 2026); the
          chevron folds it away. */}
      <details open className="group mt-4 rounded-cs border border-cs-line-soft">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-sm font-semibold text-cs-accent">
          <span className="min-w-0 flex-1">Full verdict · 完整評語</span>
          {/* Folded: on a phone the remark goes under the heading. */}
          <span className="order-last basis-full text-xs font-normal text-cs-ink-3 group-open:hidden sm:order-none sm:basis-auto">
            what each solution got right and wrong, and why
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-cs-ink-3 transition group-open:rotate-180"
            aria-label="Show or hide the full verdict"
          />
        </summary>
        <div className="border-t border-cs-line-soft px-4 pb-4">
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {solvers.map((provider, index) => (
              <Assessment
                key={provider}
                label={nameOf(provider)}
                letter={SOLUTION_LETTERS[index] ?? String(index + 1)}
                text={judgement.assessments[index] ?? ""}
                chinese={judgement.assessments_chinese?.[index]}
                correct={judgement.correct.includes(index)}
              />
            ))}
          </div>

          {judgement.comparison ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                Why
              </div>
              <MathProse source={judgement.comparison} />
            </div>
          ) : null}

          {judgement.traditional_chinese ? (
            <div className="mt-4 rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                繁體中文 · Traditional Chinese
              </div>
              <MathProse source={judgement.traditional_chinese} chinese />
            </div>
          ) : null}
        </div>
      </details>

      <div className="mt-4">
        <RevisePanel
          title={`Disagree? Give ${judgeLabel} instructions and re-generate the verdict`}
          placeholder="e.g. Solution B takes the pressure as absolute - re-check its y-momentum. Explain the sign of F_y."
          hint={`Sends the question images, your notes${
            interpretation ? ", the confirmed reading" : ""
          }, the solutions graded here as they are now, this verdict and your instructions back to ${judgeLabel}. This verdict stays if that fails.`}
          buttonLabel="Re-generate verdict"
          disabledReason={refineBlocked}
          onSubmit={onRefine}
        />
      </div>

      <p className="mt-4 text-xs text-cs-ink-3">
        The judge is a model too — treat this as a second opinion, not an answer key. Open
        each solution above and check the step it flags.
      </p>
    </div>
  );
}
