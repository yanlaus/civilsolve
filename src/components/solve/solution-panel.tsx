import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  GraduationCap,
  Image as ImageIcon,
  Languages,
  LineChart,
  Loader2,
  MessageCircleQuestion,
  RotateCw,
  Scale,
  TriangleAlert,
  X,
} from "lucide-react";
import { SOLUTION_LETTERS } from "../../../shared/judgement";
import {
  DEFAULT_JUDGE,
  PROVIDER_KEYS,
  PROVIDER_VARIANTS,
  providerDisplayName,
  SOLUTION_ORDER,
  type ModelChoice,
  type ModelVariant,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import type { EffortKey } from "../../../shared/prompt";
import type { ProviderArtifact } from "../../../shared/solution";
import type { SolutionStep } from "../../../shared/steps";
import { isStudyKind, STUDY_KINDS, STUDY_TITLES, studyHtml, type StudyKind } from "../../../shared/study";
import {
  isJudgeActive,
  isRunActive,
  isStudyActive,
  type ConfirmedInterpretation,
  type JudgeRun,
  type PdfTarget,
  type ProgressMap,
  type ProviderRuns,
  type RunVariants,
  type SolutionVersions,
  type StudyProgress,
  type StudyRuns,
  type StudySource,
} from "@/hooks/use-solve";
import { exportPdf, slugify } from "@/lib/exports";
import { solutionFileName } from "../../../shared/file-names";
import { journeyBarHeight, STEP_IDS } from "@/lib/journey";
import { renderMarkdown, renderTitle } from "@/lib/math-markdown";
import { useNow, type Progress } from "@/lib/progress";
import type { AlignState } from "@/hooks/use-align";
import type { AskThreads, AskWriter } from "@/hooks/use-ask";
import { AnswerSummary } from "./answer-summary";
import { AskPanel } from "./ask-panel";
import { DiagramList } from "./diagram-prompts";
import { HintStepper } from "./hint-stepper";
import MathProse from "./math-prose";
import { MathTitle } from "./math-title";
import { PdfButton } from "./pdf-button";
import { ProviderLogo } from "./provider-logo";
import { QuestionImages } from "./question-images";
import { RevisePanel, RevisedWith, RevisionNotice } from "./revise-panel";
import { AddSolver, CrossCheckControls } from "./run-actions";
import { StickyHeading } from "./section-heading";
import { SolutionArticle } from "./solution-article";
import { StepsArticle, type StepAction } from "./solution-views";
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

/** The Solutions heading, which the model tabs stick under. */
const SOLUTIONS_HEADING_ID = "solutions-heading";

/** The solution tabs' order: Muse Spark first, then picker order (SOLUTION_ORDER). */
const SOLUTION_TAB_ORDER = SOLUTION_ORDER.flatMap((key) =>
  PROVIDER_OPTIONS.filter((provider) => provider.key === key),
);
const SOLUTION_TAB_KEYS = SOLUTION_TAB_ORDER.map((provider) => provider.key);

/** "diagrams": a solution's charts to draw (diagram-prompts.tsx), a tab only when it has some. */
type ViewKey = "problem" | "assumptions" | "steps" | "answer" | "diagrams";

// Solution open by default. "All" - the whole solution in one scroll - came
// first and open from 3 October 2026 until 12 October, when the owner took
// it out: everything in it is in the other tabs. The history still shows a
// solution whole (AllView in solution-views.tsx).
const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: "problem", label: "Problem" },
  { key: "assumptions", label: "Assumptions" },
  { key: "steps", label: "Solution" },
  { key: "answer", label: "Final Answer" },
];

/** The "Try it yourself" hints' on/off, remembered in this browser (off at first). */
const HINT_MODE_KEY = "civilsolve:hint-mode";

function loadHintMode() {
  try {
    return window.localStorage.getItem(HINT_MODE_KEY) === "on";
  } catch {
    return false;
  }
}

function saveHintMode(on: boolean) {
  try {
    window.localStorage.setItem(HINT_MODE_KEY, on ? "on" : "off");
  } catch {
    // Only the preference is lost.
  }
}

function viewSource(artifact: ProviderArtifact, view: Exclude<ViewKey, "diagrams">) {
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
 * Chinese is a fold away. Open while the solvers work - there is nothing
 * else to read yet - and folded once the first solution is in (the owner's
 * call, 3 October 2026: open, it pushed the solutions out of sight). A run
 * picked back up with its solutions in starts folded. The step bar's "Check
 * reading" opens it.
 */
function InterpretationCard({
  interpretation,
  solved,
}: {
  interpretation: ConfirmedInterpretation;
  /** Whether any solver has returned a solution. */
  solved: boolean;
}) {
  const { text, chinese, credit, note } = interpretation;
  const [open, setOpen] = useState(!solved);
  const wasSolved = useRef(solved);
  useEffect(() => {
    if (solved && !wasSolved.current) setOpen(false);
    wasSolved.current = solved;
  }, [solved]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
      id={STEP_IDS.reading}
      tabIndex={-1}
      className="cs-panel group mb-3 scroll-mt-28 overflow-hidden rounded-cs-lg border border-cs-line-soft bg-cs-surface shadow-[0_1px_3px_var(--cs-shadow)] outline-none sm:scroll-mt-20 print:hidden"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 sm:px-7">
        <span className="flex flex-1 items-center gap-2 text-sm font-semibold text-cs-ink sm:flex-none">
          <BookOpen className="h-4 w-4 text-cs-accent" aria-hidden="true" />
          Interpreted question · 題目解讀
          <span className="inline-flex items-center gap-0.5 rounded-full bg-[rgba(45,138,78,0.12)] px-2 py-0.5 text-[0.7rem] font-semibold text-cs-success">
            <Check className="h-3 w-3" aria-hidden="true" />
            confirmed
          </span>
        </span>
        {/* On a phone the remark goes under the heading, not squeezed beside it. */}
        <span className="order-last basis-full text-xs text-cs-ink-3 sm:order-none sm:basis-0 sm:flex-1">
          by you{credit ? ` · read by ${credit}` : ""} · what the solvers were given
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
  questionImages,
  locked,
  onSolveProvider,
  onStopProvider,
  onRefineProvider,
  onCrossCheck,
  crossCheckJudge = DEFAULT_JUDGE,
  alignment,
  onCompareAgain,
  askThreads,
  askProgress,
  onAsk,
  onStopAsk,
  onStopJudge,
  onRefineVerdict,
  studyRuns,
  studyProgress,
  onWriteStudy,
  onStopStudy,
  onRefineStudy,
  pdfJobOf,
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
  /** The question's pages as the run sent them; empty when this browser no longer has them. */
  questionImages: string[];
  /** True while the page prepares or reads a new upload. */
  locked: boolean;
  onSolveProvider: (provider: ProviderKey, variant?: ModelVariant) => void;
  onStopProvider: (provider: ProviderKey) => void;
  /** Re-generates one finished solution with the user's instructions. */
  onRefineProvider: (provider: ProviderKey, instructions: string) => void;
  onCrossCheck: (judge: ModelChoice, providers: ProviderKey[], effort: EffortKey) => void;
  /** Who a tapped cross-check goes to on this run (Expert: Claude Opus). */
  crossCheckJudge?: ModelChoice;
  /** How the answers line up with each other, compared once every solver answered (hooks/use-align.ts). */
  alignment: AlignState;
  onCompareAgain: () => void;
  /** Questions about each solution, and their answers (hooks/use-ask.ts). */
  askThreads: AskThreads;
  askProgress: Record<string, Progress>;
  onAsk: (
    provider: ProviderKey,
    solution: ProviderArtifact,
    version: number,
    question: string,
    writer: AskWriter,
    step?: SolutionStep,
  ) => void;
  onStopAsk: (provider: ProviderKey, id: string) => void;
  onStopJudge: () => void;
  /** Re-generates the verdict with the user's instructions. */
  onRefineVerdict: (instructions: string) => void;
  /** The optional study notes under the solutions, by kind. */
  studyRuns: StudyRuns;
  studyProgress: StudyProgress;
  onWriteStudy: (kind: StudyKind, choice: ModelChoice, effort: EffortKey, source: StudySource) => void;
  onStopStudy: (kind: StudyKind) => void;
  onRefineStudy: (kind: StudyKind, instructions: string) => void;
  /** The job of an answer on the page, for its PDF (use-solve's pdfJobOf). */
  pdfJobOf: (target: PdfTarget) => string | null;
}) {
  const [activeProvider, setActiveProvider] = useState<ProviderKey>(PROVIDER_KEYS[0]);
  const [activeView, setActiveView] = useState<ViewKey>("steps");
  const [hintMode, setHintModeState] = useState(loadHintMode);
  const setHintMode = (on: boolean) => {
    setHintModeState(on);
    saveHintMode(on);
  };
  // How far the hints have got on each solution version, so a tab switch
  // does not start over (hint-stepper.tsx).
  const [revealed, setRevealed] = useState<Record<string, number>>({});
  // The step a question will quote, picked from beside the working.
  // `at`: when the step was picked - picking the same step again still takes
  // the student back to the question box.
  const [askStep, setAskStep] = useState<{ provider: ProviderKey; step: SolutionStep; at: number } | null>(null);

  // Muse Spark's tab first, then the rest in picker order. The judge's
  // A, B... stay in picker order.
  const visibleProviders = SOLUTION_TAB_ORDER.filter(
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

  // The model tabs stay at the top of the screen, under the step bar, while
  // the student reads a solution, so they can switch models mid-way and
  // compare (the owner's request, 11 October 2026). Each tab keeps how far
  // into its solution the student had read: a tab opened for the first time
  // starts at its top, and one opened again goes back to where they were.
  const panelRef = useRef<HTMLDivElement>(null);
  const readingAt = useRef<Partial<Record<ProviderKey, number>>>({});
  const pendingScroll = useRef<number | null>(null);
  /** Where the tabs stick: under the step bar and the Solutions heading. */
  const stickLine = () =>
    journeyBarHeight() + (document.getElementById(SOLUTIONS_HEADING_ID)?.parentElement?.offsetHeight ?? 0);
  /** How far the page has scrolled past the top of the panel; 0 or less while the tabs are not stuck. */
  const scrolledInto = () =>
    panelRef.current ? stickLine() - panelRef.current.getBoundingClientRect().top : 0;
  const [tabsStuck, setTabsStuck] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setTabsStuck(scrolledInto() > 0);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const pickProvider = (key: ProviderKey) => {
    userPicked.current = true;
    const into = scrolledInto();
    if (key !== activeProvider && into > 0) {
      readingAt.current[activeProvider] = into;
      pendingScroll.current = readingAt.current[key] ?? 0;
    }
    setActiveProvider(key);
  };
  // After the switch, before the paint: the new tab's place, under the bars.
  useLayoutEffect(() => {
    const into = pendingScroll.current;
    const panel = panelRef.current;
    if (into === null || !panel) return;
    pendingScroll.current = null;
    const panelTop = panel.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: panelTop - stickLine() + into, behavior: "instant" });
  }, [activeProvider]);
  // On a phone the tabs overflow sideways: keep the open one in sight. The
  // strip scrolls sideways only - the page itself never moves for it.
  const tablistRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tablistRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const listBox = list.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < listBox.left) list.scrollLeft -= listBox.left - tabBox.left + 8;
    else if (tabBox.right > listBox.right) list.scrollLeft += tabBox.right - listBox.right + 8;
  }, [activeProvider, visibleProviders.length]);
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
  // Its charts to draw; on a tab with none, a Diagrams pick shows the working.
  const activeDiagrams = activeArtifact?.diagrams ?? [];
  const shownView: ViewKey = activeView === "diagrams" && !activeDiagrams.length ? "steps" : activeView;
  const activeLabel = nameOf(activeProvider);
  const hintKey = `${activeProvider}:${solutionVersions[activeProvider] ?? 0}`;
  const askBlocked = !canRerun
    ? "Asking needs this run's images, which this browser no longer has. Upload the question again to ask."
    : locked
      ? "Waits until the new upload is ready."
      : undefined;
  // "Ask about this step" beside each step of the working (ask-panel.tsx).
  const askAction = useMemo<StepAction | undefined>(
    () =>
      askBlocked
        ? undefined
        : (step: SolutionStep) => (
            <button
              type="button"
              onClick={() => setAskStep({ provider: activeProvider, step, at: Date.now() })}
              className="inline-flex items-center gap-1 rounded-full border border-cs-line px-2 py-0.5 text-[0.7rem] font-semibold text-cs-ink-3 transition hover:border-cs-accent hover:text-cs-accent"
              title="Ask a question about this step"
            >
              <MessageCircleQuestion className="h-3 w-3" aria-hidden="true" />
              問呢一步 · Ask
            </button>
          ),
    [askBlocked, activeProvider],
  );
  const activeProgress = progress[activeProvider];
  // Ticks every second while anything is still running, for the clocks.
  const solving = visibleProviders.some((provider) => isRunActive(runs[provider.key]));
  const now = useNow(
    solving || isJudgeActive(judgeRun) || STUDY_KINDS.some((kind) => isStudyActive(studyRuns[kind])),
  );

  // PDFs are made by the server now ("Generate PDF", pdf-button.tsx). The
  // print dialog stays for when it cannot: "Print instead" prints the open
  // solution, the verdict's answer, or one kind of study notes. Set just
  // before printing (flushSync, so the print area has it when the dialog
  // opens) and left as it is afterwards - each button sets its own.
  const [printTarget, setPrintTarget] = useState<"solution" | "verdict" | StudyKind>("solution");
  /** Prints one answer; `fileName` is what "Save as PDF" calls it. */
  const printAs = (target: "solution" | "verdict" | StudyKind, fileName: string) => {
    flushSync(() => setPrintTarget(target));
    exportPdf(fileName);
  };

  // The verdict's PDF is its verified final answer and, since 14 October
  // 2026, the full solution behind it - the answer is what gets kept (the
  // owner's call, 27 September 2026), not the assessments.
  const verdictPrintHtml = useMemo(() => {
    if (judgeRun.status !== "done" || !judgeRun.judgement.final_answer) return "";
    const solution = judgeRun.judgement.verified_solution?.trim();
    return [
      "<h1>Verified final answer</h1>",
      renderMarkdown(judgeRun.judgement.final_answer),
      solution ? "<h2>Full solution</h2>" : "",
      solution ? renderMarkdown(solution) : "",
    ].join("\n");
  }, [judgeRun]);

  // Study notes, laid out as their PDF lays them out (studyHtml).
  const studyPrintHtml = useMemo(() => {
    if (!isStudyKind(printTarget)) return "";
    const run = studyRuns[printTarget];
    if (run.status !== "done") return "";
    return studyHtml(printTarget, run.study, (markdown, chinese) => renderMarkdown(markdown, { chinese }));
  }, [printTarget, studyRuns]);

  const printHtml = useMemo(() => {
    if (!activeArtifact) return "";
    return [
      // Escaped, with its formulas typeset.
      `<h1>${renderTitle(activeArtifact.title)}</h1>`,
      "<h2>Interpreted Problem</h2>",
      renderMarkdown(activeArtifact.interpretedProblem),
      "<h2>Assumptions</h2>",
      renderMarkdown(activeArtifact.assumptions),
      "<h2>Solution</h2>",
      renderMarkdown(activeArtifact.stepByStep),
      "<h2>Final Answer</h2>",
      renderMarkdown(activeArtifact.finalAnswer),
      // As in the server's PDF (worker/pdf.ts): each diagram's key points,
      // without the prompt for an AI that draws (19 October 2026, the owner).
      ...(activeArtifact.diagrams?.length
        ? [
            "<h2>Diagrams to draw</h2>",
            ...activeArtifact.diagrams.flatMap((diagram) => [
              `<h3>${renderTitle(diagram.title)}</h3>`,
              renderMarkdown(diagram.description),
            ]),
          ]
        : []),
    ].join("\n");
  }, [activeArtifact]);

  const printAreaHtml =
    printTarget === "verdict" ? verdictPrintHtml : printTarget === "solution" ? printHtml : studyPrintHtml;

  if (!visibleProviders.length) return null;

  return (
    <section className="mt-6">
      {interpretation ? (
        <InterpretationCard
          interpretation={interpretation}
          solved={Object.values(runs).some((run) => run.status === "done")}
        />
      ) : null}

      {/* The question as uploaded, a fold away while reading the solutions. */}
      {questionImages.length ? (
        <details className="cs-panel group mb-3 rounded-cs-lg border border-cs-line-soft bg-cs-surface shadow-[0_1px_3px_var(--cs-shadow)] print:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-semibold text-cs-ink sm:px-7">
            <ImageIcon className="h-4 w-4 text-cs-accent" aria-hidden="true" />
            The question · 題目原圖
            <span className="text-xs font-normal text-cs-ink-3">
              {questionImages.length} page{questionImages.length === 1 ? "" : "s"}
            </span>
            <ChevronDown className="ml-auto h-4 w-4 text-cs-ink-3 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-cs-line-soft px-5 py-4 sm:px-7">
            <QuestionImages images={questionImages} />
          </div>
        </details>
      ) : null}

      {/* The answers, from the heading to Add a solver: where the step bar's
          "Answers" and the jump button land. */}
      <div id={STEP_IDS.answers} tabIndex={-1} className="scroll-mt-28 pt-3 outline-none sm:scroll-mt-20">
      {/* A direct child of the answers block, so it sticks all the way
          through the summary, the tabs and Add a solver. */}
      <StickyHeading
        id={SOLUTIONS_HEADING_ID}
        icon={CheckCircle2}
        iconClassName="text-cs-success"
        title="Solutions"
        chinese="答案"
        className="print:hidden"
      />
      <div className="mb-2" />

      <AnswerSummary
        order={SOLUTION_TAB_KEYS}
        runs={runs}
        judgeRun={judgeRun}
        nameOf={nameOf}
        judgeLabel={judgeRun.status !== "idle" ? providerDisplayName(judgeRun.judge, variants.judge) : ""}
        queuedJudge={
          judgeRun.status !== "idle"
            ? { choice: { provider: judgeRun.judge, variant: variants.judge }, effort: variants.judgeEffort }
            : undefined
        }
        markOf={(key) => solverMark(judgeRun, key, solutionVersions)}
        providerStatus={providerStatus}
        canRerun={canRerun}
        locked={locked}
        onPick={pickProvider}
        onCrossCheck={onCrossCheck}
        crossCheckJudge={crossCheckJudge}
        onStopJudge={onStopJudge}
        alignment={alignment}
        onCompareAgain={onCompareAgain}
      />

      {/* overflow-clip, not -hidden: it rounds the corners the same, and a
          hidden overflow would stop the tabs below from sticking. */}
      <div
        ref={panelRef}
        className="cs-panel overflow-clip rounded-cs-lg border border-cs-line-soft bg-cs-surface shadow-[0_4px_16px_var(--cs-shadow)] print:hidden"
      >
        <div
          className={`sticky top-[calc(var(--cs-journey-h,0px)+var(--cs-section-h))] z-20 border-b-2 border-cs-line-soft bg-cs-surface px-2 pt-1 transition-shadow ${
            tabsStuck ? "shadow-[0_6px_12px_-8px_var(--cs-shadow)]" : ""
          }`}
        >
          <div ref={tablistRef} className="flex overflow-x-auto" role="tablist" aria-label="Solutions by model">
            {visibleProviders.map((provider) => {
              const run = runs[provider.key];
              const mark = solverMark(judgeRun, provider.key, solutionVersions);
              return (
                <button
                  key={provider.key}
                  type="button"
                  role="tab"
                  aria-selected={activeProvider === provider.key}
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
              <MathTitle text={activeArtifact.title} className="block font-display text-2xl font-semibold text-cs-ink" />
              {activeRun.status === "done" && activeRun.revisedWith ? (
                <RevisedWith instructions={activeRun.revisedWith} />
              ) : null}
              {activeRun.status === "done" && activeRun.notice ? (
                <div className="mt-3">
                  <RevisionNotice message={activeRun.notice} />
                </div>
              ) : null}
              <div className="mt-4">
                <PdfButton
                  // A new version, or another tab: a fresh button.
                  key={pdfJobOf(activeProvider) ?? activeProvider}
                  jobId={pdfJobOf(activeProvider)}
                  onPrint={() =>
                    printAs(
                      "solution",
                      solutionFileName({
                        at: activeProgress?.endedAt ?? Date.now(),
                        model: activeRun.status === "done" ? activeRun.model : undefined,
                        problem: activeArtifact.title,
                      }),
                    )
                  }
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end justify-between gap-x-2 border-b-2 border-cs-line-soft px-2 pt-1">
              <div className={`flex overflow-x-auto ${hintMode ? "opacity-40" : ""}`}>
                {[
                  ...VIEWS,
                  // Only for a solution with charts to draw.
                  ...(activeDiagrams.length
                    ? [{ key: "diagrams" as const, label: `Diagrams 畫圖 (${activeDiagrams.length})` }]
                    : []),
                ].map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    disabled={hintMode}
                    onClick={() => setActiveView(view.key)}
                    className={`relative inline-flex shrink-0 items-center gap-1.5 px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed ${
                      shownView === view.key && !hintMode
                        ? "text-cs-accent"
                        : "text-cs-ink-3 hover:text-cs-ink"
                    }`}
                  >
                    {view.key === "diagrams" ? <LineChart className="h-4 w-4" aria-hidden="true" /> : null}
                    {view.label}
                    <span
                      className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                        shownView === view.key && !hintMode ? "bg-cs-accent" : "bg-transparent"
                      }`}
                    />
                  </button>
                ))}
              </div>
              {/* The hints: the solution a step at a time (hint-stepper.tsx). */}
              <button
                type="button"
                aria-pressed={hintMode}
                onClick={() => setHintMode(!hintMode)}
                title="Show the solution a step at a time, so you can try each step first"
                className={`mb-2 mr-2 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition ${
                  hintMode
                    ? "border-cs-accent bg-cs-accent text-cs-on-accent"
                    : "border-cs-line bg-cs-surface text-cs-ink-2 hover:border-cs-accent hover:text-cs-accent"
                }`}
              >
                <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
                Try it yourself · 先自己諗
              </button>
            </div>

            {/* A question with charts to draw: say so where the student reads
                the working and the answer, and take them to the drawings. The
                English, the Chinese and the button each on a line of their own
                on a phone - side by side, the button left the words a column
                three words wide (the owner, 16 October 2026). */}
            {activeDiagrams.length && !hintMode && (shownView === "steps" || shownView === "answer") ? (
              <div className="mx-4 mt-4 rounded-cs border border-cs-line bg-cs-muted px-4 py-3 sm:mx-7 sm:flex sm:items-center sm:gap-4">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <LineChart className="mt-0.5 h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
                  <div className="min-w-0 text-sm leading-6 text-cs-ink-2">
                    <p>
                      This question asks you to draw{" "}
                      {activeDiagrams.length === 1
                        ? "a diagram: see its key points, and a prompt to have Gemini draw it."
                        : `${activeDiagrams.length} diagrams: see their key points, and a prompt to have Gemini draw each.`}
                    </p>
                    <p lang="zh-Hant-HK" className="mt-1">
                      題目要你畫圖，可以叫 Gemini 幫你畫。
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveView("diagrams")}
                  className="mt-3 flex w-full items-center justify-center gap-1 rounded-cs border border-cs-accent px-3 py-1.5 text-sm font-semibold text-cs-accent transition hover:bg-cs-accent hover:text-cs-on-accent sm:mt-0 sm:w-auto sm:shrink-0"
                >
                  Open Diagrams · 睇畫圖
                </button>
              </div>
            ) : null}

            {hintMode ? (
              <HintStepper
                artifact={activeArtifact}
                revealed={revealed[hintKey] ?? 0}
                onReveal={(next) => setRevealed((current) => ({ ...current, [hintKey]: next }))}
                onShowAll={() => setHintMode(false)}
                stepAction={askAction}
              />
            ) : shownView === "diagrams" ? (
              <div className="px-4 py-6 sm:px-7">
                <DiagramList diagrams={activeDiagrams} />
              </div>
            ) : shownView === "steps" ? (
              <StepsArticle source={activeArtifact.stepByStep} stepAction={askAction} />
            ) : (
              <SolutionArticle source={viewSource(activeArtifact, shownView)} />
            )}

            <div className="border-t border-cs-line-soft px-4 pt-4 sm:px-7">
              <AskPanel
                key={activeProvider}
                provider={activeProvider}
                label={activeLabel}
                solution={activeArtifact}
                version={solutionVersions[activeProvider] ?? 0}
                threads={askThreads}
                progress={askProgress}
                now={now}
                defaultModel={studyModel({ provider: activeProvider, variant: variants.solvers[activeProvider] })}
                providerStatus={providerStatus}
                disabledReason={askBlocked}
                step={askStep?.provider === activeProvider ? askStep.step : null}
                stepPickedAt={askStep?.provider === activeProvider ? askStep.at : undefined}
                onClearStep={() => setAskStep(null)}
                onAsk={(question, writer, step) =>
                  onAsk(activeProvider, activeArtifact, solutionVersions[activeProvider] ?? 0, question, writer, step)
                }
                onStop={(id) => onStopAsk(activeProvider, id)}
              />
            </div>

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

      <AddSolver
        runs={runs}
        judgeRun={judgeRun}
        providerStatus={providerStatus}
        canRerun={canRerun}
        locked={locked}
        onSolveProvider={solveWith}
      />
      </div>

      {/* The cross-check, a section of its own since 3 October 2026 (the
          owner's call; it shared a panel with Add a solver): its controls,
          then the verdict under them - read after the solutions, not before
          them (the owner's order since 26 September 2026). */}
      <section
        id={STEP_IDS.check}
        tabIndex={-1}
        className="mt-8 scroll-mt-28 outline-none sm:scroll-mt-20 print:hidden"
        aria-labelledby="cross-check-heading"
      >
        <StickyHeading id="cross-check-heading" icon={Scale} title="Cross-check" chinese="交叉核對" />
        <p className="mb-3 text-xs text-cs-ink-3">
          Optional - a judge model grades the solutions you tick against the question and gives
          the verified answer.
        </p>
        <CrossCheckControls
          runs={runs}
          judgeRun={judgeRun}
          variants={variants}
          providerStatus={providerStatus}
          canRerun={canRerun}
          locked={locked}
          onCrossCheck={onCrossCheck}
          defaultJudge={crossCheckJudge}
        />

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
              pdfJobId={pdfJobOf("verdict")}
              onPrint={() =>
                printAs(
                  "verdict",
                  solutionFileName({
                    at: judgeProgress?.endedAt ?? Date.now(),
                    model: judgeRun.status === "done" ? judgeRun.model : undefined,
                    problem: verdictProblem(judgeRun, runs),
                  }),
                )
              }
            />
          </div>
        ) : null}
      </section>

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
          pdfJobOf={pdfJobOf}
          onPrint={(kind) => printAs(kind, slugify(STUDY_TITLES[kind].title))}
        />
      ) : null}

      {/* Hidden on screen; the only visible content when printing ("Print instead"). */}
      {printAreaHtml ? (
        <div
          className="print-area solution-content prose prose-stone hidden max-w-none print:block"
          dangerouslySetInnerHTML={{ __html: printAreaHtml }}
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
  provider,
  label,
  letter,
  text,
  chinese,
  correct,
}: {
  provider: ProviderKey;
  label: string;
  letter: string;
  text: string;
  /** The same assessment in Traditional Chinese, when the judge wrote it. */
  chinese?: string;
  correct: boolean;
}) {
  // The point that matters most first - the judge puts a wrong solution's
  // first error at the top (shared/prompt.ts) - in English and in Chinese;
  // the rest a tap away (the owner, 11 October 2026: the assessments read
  // as paragraphs).
  const [headline, details] = splitFirstPoint(text);
  const [headlineChinese, detailsChinese] = splitFirstPoint(chinese ?? "");
  return (
    <div className="min-w-0 rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
        {correct ? (
          <Check className="h-3.5 w-3.5 text-cs-success" aria-hidden="true" />
        ) : (
          <X className="h-3.5 w-3.5 text-cs-danger" aria-hidden="true" />
        )}
        <ProviderLogo provider={provider} className="h-4 w-4 shrink-0" />
        Solution {letter} · {label}
      </div>
      {headline ? <MathProse source={headline} /> : <p className="text-sm text-cs-ink-3">No assessment given.</p>}
      {headlineChinese ? <MathProse source={headlineChinese} chinese className="text-cs-ink-2" /> : null}
      {details || detailsChinese ? (
        <details className="group/more mt-1 border-t border-cs-line-soft pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-cs-accent">
            More · 詳情
            <ChevronDown className="h-3.5 w-3.5 transition group-open/more:rotate-180" aria-hidden="true" />
          </summary>
          {details ? <MathProse source={details} className="mt-1" /> : null}
          {detailsChinese ? (
            <div className="mt-2">
              <div className="mb-1 flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                繁體中文
              </div>
              <MathProse source={detailsChinese} chinese />
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/**
 * A Markdown list's first point (with anything before it) and the rest; the
 * whole text first when it is not a list of two or more points - a verdict
 * written before 11 October 2026 may be prose.
 */
function splitFirstPoint(text: string): [string, string] {
  const lines = text.trim().split("\n");
  const points = lines.flatMap((line, index) => (/^\s*[-*]\s+/.test(line) ? [index] : []));
  if (points.length < 2) return [text.trim(), ""];
  return [lines.slice(0, points[1]).join("\n").trim(), lines.slice(points[1]).join("\n").trim()];
}

/**
 * The problem a verdict is about, for its PDF's file name - the verdict has
 * no title of its own: the title of the first solution it graded.
 */
function verdictProblem(judgeRun: JudgeRun, runs: ProviderRuns) {
  if (judgeRun.status !== "done") return undefined;
  for (const key of judgeRun.solvers) {
    const run = runs[key];
    if (run.status === "done" && run.solution.title) return run.solution.title;
  }
  return undefined;
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
  pdfJobId,
  onPrint,
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
  /** The verdict's job, which the server makes the PDF of the verified answer from. */
  pdfJobId: string | null;
  /** The browser's print dialog, for when the server cannot make the PDF. */
  onPrint: () => void;
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
  // Left out when the verdict was asked for: failed, or - a cross-check runs
  // as soon as two solutions are in - still solving.
  const skipped = judgeRun.skipped.filter(
    (provider) => runs[provider].status !== "done" && !isRunActive(runs[provider]),
  );
  const pending = judgeRun.skipped.filter((provider) => isRunActive(runs[provider]));
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
              {/* Each model's logo on its verdict (the owner's request, 3 October 2026). */}
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cs-line-soft bg-cs-surface">
                <ProviderLogo provider={provider} className="h-4 w-4" />
              </span>
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
      {pending.length ? (
        <p className="mt-1 text-xs text-cs-ink-3">
          Not in this verdict: {pending.map(nameOf).join(", ")} {pending.length === 1 ? "is" : "are"}{" "}
          still solving. Run the cross-check again above once {pending.length === 1 ? "it is" : "they are"} in.
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
            <PdfButton
              small
              key={pdfJobId ?? "verdict"}
              jobId={pdfJobId}
              problem={verdictProblem(judgeRun, runs)}
              onPrint={onPrint}
            />
          </div>
          <MathProse source={judgement.final_answer} />
          {/* The judge's own working behind the answer (since 14 October
              2026, the owner: the answer alone was not enough to learn
              from), laid out like a solution; open, and folds away. */}
          {judgement.verified_solution?.trim() ? (
            <details open className="group/solution mt-3 rounded-cs border border-cs-line-soft">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-semibold text-cs-accent">
                <span className="min-w-0 flex-1">Full solution · 完整解法</span>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-cs-ink-3 transition group-open/solution:rotate-180"
                  aria-label="Show or hide the full solution"
                />
              </summary>
              <div className="border-t border-cs-line-soft px-4 py-2">
                <SolutionArticle source={judgement.verified_solution} measure bare />
              </div>
            </details>
          ) : null}
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
          {/* Why first, as three short points (Agree / Differ / Decisive
              reason - shared/prompt.ts), then each solution's assessment. */}
          {judgement.comparison ? (
            <div className="mt-4 rounded-cs border-l-4 border-cs-accent bg-cs-muted px-4 py-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                Why · 原因
              </div>
              <MathProse source={judgement.comparison} />
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {solvers.map((provider, index) => (
              <Assessment
                key={provider}
                provider={provider}
                label={nameOf(provider)}
                letter={SOLUTION_LETTERS[index] ?? String(index + 1)}
                text={judgement.assessments[index] ?? ""}
                chinese={judgement.assessments_chinese?.[index]}
                correct={judgement.correct.includes(index)}
              />
            ))}
          </div>

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
