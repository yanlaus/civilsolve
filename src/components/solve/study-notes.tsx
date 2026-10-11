// Study notes under the solutions (shared/study.ts), the owner's two
// features of 28 September 2026: 題型解題思路 - the type of problem, its
// approach and key formulas - and the question explained simply. Each is
// optional and made on request, by the model picked on its card, starting
// from the solution picked there: one solver's, or the cross-check's
// verified answer. The approach notes come in tabs, one per part, like a
// solution's, each with its Chinese a fold below; the simple explanation
// shows its Cantonese first and the English a fold below (the owner's
// layout, 28 September 2026). Each can be made a PDF, like a solution
// (30 September 2026): every fold open, each part's Chinese under it.

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Compass, GraduationCap, Languages, Lightbulb, Sparkles } from "lucide-react";
import { EFFORT_KEYS, type EffortKey } from "../../../shared/prompt";
import {
  choiceKey,
  canonicalChoice,
  modelStatus,
  MODEL_CHOICES,
  parseChoice,
  providerDisplayName,
  SOLUTION_ORDER,
  type ModelChoice,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import {
  openStudyLabels,
  splitStudyParts,
  STUDY_KINDS,
  STUDY_PARTS,
  STUDY_TITLES,
  type StudyKind,
} from "../../../shared/study";
import {
  isStudyActive,
  type JudgeRun,
  type ProviderRuns,
  type StudyProgress,
  type StudyRun,
  type StudyRuns,
  type StudySource,
} from "@/hooks/use-solve";
import { effortBand } from "@/lib/effort-band";
import type { Progress } from "@/lib/progress";
import MathProse from "./math-prose";
import { PdfButton } from "./pdf-button";
import { RevisePanel, RevisedWith, RevisionNotice } from "./revise-panel";
import { SolutionArticle } from "./solution-article";
import {
  ERROR_BOX,
  EventLog,
  ProgressBox,
  STOPPED_BOX,
  TIMEOUT_BOX,
  tookLabel,
} from "./task-status";

const KINDS: Record<
  StudyKind,
  {
    title: string;
    chinese: string;
    blurb: string;
    Icon: typeof Compass;
    placeholder: string;
  }
> = {
  approach: {
    ...STUDY_TITLES.approach,
    blurb: "What type of problem this is, how problems of this type are solved, and the key formulas.",
    Icon: Compass,
    placeholder: "e.g. Compare it with the Bernoulli-only approach. Add the formula for the force on a vane.",
  },
  explain: {
    ...STUDY_TITLES.explain,
    blurb:
      "The question and its solution talked through like a tutor would - plain words, everyday pictures, what every number means. In Cantonese, with the English a click below.",
    Icon: Lightbulb,
    placeholder: "e.g. Explain why the pressure force points into the control volume. Use a garden-hose analogy.",
  },
};

const SELECT_CLASS =
  "mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent disabled:opacity-50";
const BUTTON_CLASS =
  "cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50";

/** "DeepSeek", "DeepSeek and Muse Spark", "A, B and C". */
function listNames(names: string[]) {
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function StudyNotes({
  studyRuns,
  studyProgress,
  runs,
  judgeRun,
  now,
  providerStatus,
  nameOf,
  judgeLabel,
  markOf,
  modelOf,
  blocked,
  interpretation,
  onWrite,
  onStop,
  onRefine,
  pdfJobOf,
  onPrint,
}: {
  studyRuns: StudyRuns;
  studyProgress: StudyProgress;
  /** The solutions and the verdict on the page: what the notes can start from. */
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  now: number;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** A solver's name as its tab shows it. */
  nameOf: (key: ProviderKey) => string;
  /** The judge's name, for the verdict's entry in "Start from". */
  judgeLabel: string;
  /** What the verdict says of a solver's solution as it is now (solution-panel's solverMark). */
  markOf: (key: ProviderKey) => "correct" | "wrong" | null;
  /** The model that wrote a source: the solver's, or the judge's for the verified answer. */
  modelOf: (source: StudySource) => ModelChoice;
  /** Why notes cannot be asked for right now, if they cannot. */
  blocked?: string;
  /** Whether the run had a confirmed reading, which the notes' model also gets. */
  interpretation: boolean;
  onWrite: (kind: StudyKind, choice: ModelChoice, effort: EffortKey, source: StudySource) => void;
  onStop: (kind: StudyKind) => void;
  onRefine: (kind: StudyKind, instructions: string) => void;
  /** The job that holds a kind's notes, for their PDF (use-solve's pdfJobOf). */
  pdfJobOf: (kind: StudyKind) => string | null;
  /** The browser's print dialog for a kind's notes, when the server cannot make the PDF. */
  onPrint: (kind: StudyKind) => void;
}) {
  // Muse's solution first, matching the tabs, then the verified answer and
  // other finished solutions.
  const judged = judgeRun.status === "done" ? judgeRun : null;
  const finished = SOLUTION_ORDER.filter((key) => runs[key].status === "done");
  const sources: StudySource[] = [
    ...finished.filter((key) => key === "muse"),
    ...(judged ? (["verdict"] as const) : []),
    ...finished.filter((key) => key !== "muse"),
  ];
  const sourceLabel = (source: StudySource) =>
    source === "verdict" ? `Verified answer (${judgeLabel}'s verdict)` : `${nameOf(source)}'s solution`;
  // What goes to the model with each source, for the hints.
  const sentWith = (source: StudySource) =>
    source === "verdict" && judged
      ? `the cross-check's verdict with the ${
          judged.solvers.length === 1 ? "solution" : "solutions"
        } it graded (${listNames(judged.solvers.map(nameOf))})`
      : source === "verdict"
        ? "the cross-check's verdict"
        : `${nameOf(source)}'s solution`;

  return (
    <section className="mt-8 print:hidden" aria-labelledby="study-notes-heading">
      <h2
        id="study-notes-heading"
        className="flex flex-wrap items-baseline gap-x-2 font-display text-2xl font-bold text-cs-ink"
      >
        <GraduationCap className="h-5 w-5 self-center text-cs-accent" aria-hidden="true" />
        Study notes
        <span className="font-sans text-base font-normal text-cs-ink-3">溫習筆記</span>
      </h2>
      <p className="mb-3 mt-1 text-xs text-cs-ink-3">
        Optional - generate either or both, from the solution you pick. The model is the one that
        wrote that solution unless you pick another.
      </p>
      <div className="grid gap-4">
        {STUDY_KINDS.map((kind) => (
          <StudyCard
            key={kind}
            kind={kind}
            run={studyRuns[kind]}
            progress={studyProgress[kind]}
            now={now}
            providerStatus={providerStatus}
            sources={sources}
            nameOf={nameOf}
            sourceLabel={sourceLabel}
            markOf={markOf}
            modelOf={modelOf}
            sentWith={sentWith}
            blocked={blocked || (sources.length ? undefined : "Needs a finished solution.")}
            interpretation={interpretation}
            onWrite={(choice, effort, source) => onWrite(kind, choice, effort, source)}
            onStop={() => onStop(kind)}
            onRefine={(instructions) => onRefine(kind, instructions)}
            pdfJobId={pdfJobOf(kind)}
            onPrint={() => onPrint(kind)}
          />
        ))}
      </div>
    </section>
  );
}

function StudyCard({
  kind,
  run,
  progress,
  now,
  providerStatus,
  sources,
  nameOf,
  sourceLabel,
  markOf,
  modelOf,
  sentWith,
  blocked,
  interpretation,
  onWrite,
  onStop,
  onRefine,
  pdfJobId,
  onPrint,
}: {
  kind: StudyKind;
  run: StudyRun;
  progress?: Progress;
  now: number;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** What the notes can start from now, the default first. */
  sources: StudySource[];
  nameOf: (key: ProviderKey) => string;
  sourceLabel: (source: StudySource) => string;
  markOf: (key: ProviderKey) => "correct" | "wrong" | null;
  modelOf: (source: StudySource) => ModelChoice;
  sentWith: (source: StudySource) => string;
  blocked?: string;
  interpretation: boolean;
  onWrite: (choice: ModelChoice, effort: EffortKey, source: StudySource) => void;
  onStop: () => void;
  onRefine: (instructions: string) => void;
  pdfJobId: string | null;
  onPrint: () => void;
}) {
  const { title, chinese, blurb, Icon, placeholder } = KINDS[kind];
  const configured = (choice: ModelChoice) => modelStatus(providerStatus?.[choice.provider], choice.variant)?.configured !== false;
  const writers = MODEL_CHOICES.filter(configured);

  // What to start from: the user's pick while it is still on the page, else
  // the first in the list - Muse Spark's solution, else the verified answer,
  // else the first finished solution.
  const [sourcePick, setSourcePick] = useState<StudySource | null>(null);
  const source: StudySource | undefined =
    sourcePick && sources.includes(sourcePick) ? sourcePick : sources[0];

  // The model: the user's pick, else the one that wrote the source -
  // DeepSeek's solution is explained by DeepSeek, the verified answer by the
  // judge (the owner's call, 28 September 2026; it was ChatGPT and DeepSeek
  // per card before). Picking another source goes back to that source's
  // model. The level: medium unless picked - the notes explain a solution,
  // they do not derive one - kept inside the model's band (ChatGPT runs at
  // high or max).
  const [pick, setPick] = useState<ModelChoice | null>(null);
  const writer = canonicalChoice(pick ?? (source ? modelOf(source) : writers[0] ?? MODEL_CHOICES[0]));
  const [effortPick, setEffortPick] = useState<EffortKey>("medium");
  const { inBand, clamp } = effortBand(modelStatus(providerStatus?.[writer.provider], writer.variant));
  const effort = clamp(effortPick);

  const active = isStudyActive(run);
  const writerLabel =
    run.status !== "idle" ? providerDisplayName(run.provider, run.variant) : providerDisplayName(writer.provider, writer.variant);
  const hint = source
    ? `One extra model call, with the question${interpretation ? ", the confirmed reading" : ""} and ${sentWith(source)}. Never sent to the cross-check.`
    : "";

  return (
    <div className="cs-panel min-w-0 rounded-cs-lg border border-cs-line-soft bg-cs-surface p-5 shadow-[0_1px_3px_var(--cs-shadow)]">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-display text-lg font-semibold text-cs-ink">
        <Icon className="h-4 w-4 text-cs-accent" aria-hidden="true" />
        <span lang="zh-Hant-HK">{chinese}</span>
        <span className="text-cs-ink-3">·</span>
        {title}
      </p>
      <p className="mt-0.5 text-xs text-cs-ink-3">{blurb}</p>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block text-xs text-cs-ink-3">
          Start from
          <select
            value={source ?? ""}
            disabled={active || !sources.length}
            onChange={(event) => {
              setSourcePick(event.target.value as StudySource);
              setPick(null);
            }}
            className={SELECT_CLASS}
          >
            {sources.map((entry) => (
              <option key={entry} value={entry}>
                {sourceLabel(entry)}
                {entry !== "verdict" && markOf(entry) === "correct" ? " - judged correct ✓" : ""}
                {entry !== "verdict" && markOf(entry) === "wrong" ? " - judged wrong ✗" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-cs-ink-3">
          Model
          <select
            value={choiceKey(writer)}
            disabled={active}
            onChange={(event) => {
              const picked = parseChoice(event.target.value);
              if (picked) setPick(picked);
            }}
            className={SELECT_CLASS}
          >
            {writers.map((choice) => (
              <option key={choiceKey(choice)} value={choiceKey(choice)}>
                {providerDisplayName(choice.provider, choice.variant)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-cs-ink-3">
          Thinking
          <select
            value={effort}
            disabled={active}
            onChange={(event) => setEffortPick(event.target.value as EffortKey)}
            className={SELECT_CLASS}
          >
            {EFFORT_KEYS.map((key) => (
              <option key={key} value={key} disabled={!inBand(key)}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
                {key === "medium" ? " (default)" : ""}
                {inBand(key) ? "" : " - not offered by this model"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={active || Boolean(blocked) || !source}
          onClick={() => source && onWrite(writer, effort, source)}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {active ? "Writing..." : run.status === "idle" ? "Generate" : "Generate again"}
        </button>
      </div>
      <p className="mt-2 text-[0.7rem] text-cs-ink-3">{blocked || hint}</p>
      {source && source !== "verdict" && markOf(source) === "wrong" && !active ? (
        <p className="mt-1 text-xs font-medium text-[#a85a12]">
          The cross-check judged this solution wrong: notes from it follow it, mistakes included.
          Start from the verified answer for notes you can rely on.
        </p>
      ) : null}

      {run.status === "waiting" || run.status === "streaming" ? (
        <div className="mt-3">
          <ProgressBox
            now={now}
            progress={progress}
            line={
              run.status === "streaming"
                ? `${writerLabel} is writing the notes... ${run.charsReceived.toLocaleString()} characters received.`
                : run.message
            }
            onStop={onStop}
            stopTitle="Stop these notes - everything else carries on"
          />
        </div>
      ) : null}

      {run.status === "error" ? (
        <div
          className={`mt-3 rounded-cs border px-4 py-3 text-sm ${
            run.stopped ? STOPPED_BOX : run.timedOut ? TIMEOUT_BOX : ERROR_BOX
          }`}
        >
          <div className="font-semibold">
            {run.stopped ? "Stopped - no notes" : run.timedOut ? "Timed out - no notes" : "No notes returned"}
            {tookLabel(progress) ? <span className="font-normal"> after {tookLabel(progress)}</span> : null}
          </div>
          {run.stopped ? null : <div className="mt-1">{run.message}</div>}
          <EventLog progress={progress} />
          <p className="mt-2 text-xs opacity-80">Generate again above to try once more.</p>
        </div>
      ) : null}

      {run.status === "done" ? (
        <div className="mt-4 border-t border-cs-line-soft pt-3">
          <p className="text-xs text-cs-ink-3">
            By {writerLabel}
            {run.effort ? ` at ${run.effort} thinking` : ""}
            {tookLabel(progress) ? ` in ${tookLabel(progress)}` : ""}
            {run.model ? ` with ${run.model}` : ""}, from{" "}
            {run.basis.source === "verdict"
              ? `the cross-check's verified answer (with the solutions by ${listNames(
                  run.basis.solvers.map(nameOf),
                )})`
              : sourceLabel(run.basis.source)}
            .
          </p>
          {run.revisedWith ? <RevisedWith instructions={run.revisedWith} /> : null}
          {run.notice ? (
            <div className="mt-2">
              <RevisionNotice message={run.notice} />
            </div>
          ) : null}
          <div className="mt-3">
            <PdfButton small key={pdfJobId ?? kind} jobId={pdfJobId} onPrint={onPrint} />
          </div>

          {kind === "approach" ? (
            <ApproachTabs guide={run.study.guide} chinese={run.study.traditional_chinese} />
          ) : (
            <CantoneseFirst guide={run.study.guide} chinese={run.study.traditional_chinese} />
          )}

          <div className="mt-4">
            <RevisePanel
              title={`Want it different? Give ${writerLabel} instructions and re-generate`}
              placeholder={placeholder}
              hint={`Sends the question images, your notes${
                interpretation ? ", the confirmed reading" : ""
              }, ${sentWith(run.basis.source)} as it is now, these notes and your instructions back to ${writerLabel}. These notes stay if that fails.`}
              buttonLabel="Re-generate notes"
              disabledReason={
                blocked ||
                (sources.includes(run.basis.source)
                  ? undefined
                  : `Needs ${sourceLabel(run.basis.source).replace(/^Verified/, "the verified")}, which is not on the page right now.`)
              }
              onSubmit={onRefine}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A fold holding the notes in the other language; closed to begin with. */
function LanguageFold({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  /** Set to keep its state outside, as each approach tab does. */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      className="group/zh rounded-cs border border-cs-line-soft bg-cs-muted"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
        <Languages className="h-3.5 w-3.5" aria-hidden="true" />
        {label}
        <ChevronDown
          className="ml-auto h-3.5 w-3.5 transition group-open/zh:rotate-180"
          aria-label={`Show or hide ${label}`}
        />
      </summary>
      <div className="border-t border-cs-line-soft px-4 py-2">{children}</div>
    </details>
  );
}

const APPROACH_PARTS = STUDY_PARTS.approach;

/**
 * The approach notes in tabs - Problem type, Approach, Key formulas, Common
 * mistakes - drawn like a solution's Problem / Assumptions / Solution / Final
 * Answer tabs, each part's Chinese a fold below it that opens and closes on
 * its own. Notes whose parts cannot be told apart (fewer than two labels)
 * are shown whole.
 */
function ApproachTabs({ guide, chinese }: { guide: string; chinese: string }) {
  const parts = useMemo(() => splitStudyParts(guide, "approach"), [guide]);
  const chineseParts = useMemo(() => (chinese ? splitStudyParts(chinese, "approach") : null), [chinese]);
  const [tab, setTab] = useState(0);
  const [open, setOpen] = useState<boolean[]>(() => APPROACH_PARTS.map(() => false));

  if (!parts) {
    return (
      <>
        <MathProse source={openStudyLabels(guide)} className="mt-2" />
        {chinese ? (
          <div className="mt-3">
            <LanguageFold label="繁體中文 · Traditional Chinese">
              <MathProse source={openStudyLabels(chinese)} chinese />
            </LanguageFold>
          </div>
        ) : null}
      </>
    );
  }

  // Chinese that cannot be cut into parts goes whole under every tab.
  const chineseText = chineseParts ? chineseParts[tab] : chinese;
  return (
    <div className="mt-3 overflow-hidden rounded-cs-lg border border-cs-line-soft">
      <div className="border-b-2 border-cs-line-soft px-2 pt-1">
        <div className="flex overflow-x-auto" role="tablist">
          {APPROACH_PARTS.map((part, index) => (
            <button
              key={part.label}
              type="button"
              role="tab"
              aria-selected={tab === index}
              onClick={() => setTab(index)}
              className={`relative shrink-0 px-4 py-3 text-sm font-semibold transition ${
                tab === index ? "text-cs-accent" : "text-cs-ink-3 hover:text-cs-ink"
              }`}
            >
              {part.label}
              <span
                className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                  tab === index ? "bg-cs-accent" : "bg-transparent"
                }`}
              />
            </button>
          ))}
        </div>
      </div>
      {parts[tab] ? (
        <SolutionArticle source={parts[tab]} />
      ) : (
        <p className="px-4 py-6 text-sm text-cs-ink-3 sm:px-7">This part was left out of the notes.</p>
      )}
      {chineseText ? (
        <div className="px-4 pb-4 sm:px-7">
          <LanguageFold
            // Its own fold per tab, so one tab's state never leaks into another's.
            key={tab}
            label={chineseParts ? "繁體中文 · Traditional Chinese" : "繁體中文 · Traditional Chinese (all parts)"}
            open={open[tab]}
            onToggle={(value) =>
              setOpen((current) =>
                current[tab] === value ? current : current.map((entry, index) => (index === tab ? value : entry)),
              )
            }
          >
            <MathProse source={chineseText} chinese />
          </LanguageFold>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The simple explanation: its Cantonese first, the English a fold below. The
 * labels are put on lines of their own again here, for notes stored before
 * the parser did it with a blank line around them ("Wrap-up" indented).
 */
function CantoneseFirst({ guide, chinese }: { guide: string; chinese: string }) {
  const english = useMemo(() => openStudyLabels(guide), [guide]);
  const cantonese = useMemo(() => openStudyLabels(chinese), [chinese]);
  if (!cantonese) return <MathProse source={english} className="mt-2" />;
  return (
    <>
      <MathProse source={cantonese} chinese className="mt-2" />
      <div className="mt-3">
        <LanguageFold label="English">
          <MathProse source={english} />
        </LanguageFold>
      </div>
    </>
  );
}
