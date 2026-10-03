// Pause-for-review step of the diagram-interpretation pipeline: shows the
// verified interpretation for the user to correct before solving starts,
// with the reconciler's Traditional Chinese version beside it to check
// against. Both are rendered like a solution - Markdown, LaTeX typeset - and
// the English can be edited as source, with its preview a tab away. Or the
// reconciler can be asked for the reading again, with the user's instructions.

import { lazy, Suspense, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  Image as ImageIcon,
  Info,
  Languages,
  Pencil,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  readingAgreement,
  type InterpretationResult,
  type ReadingAgreement,
} from "../../../shared/interpretation";
import { STEP_IDS } from "@/lib/journey";
import { formatClock, useNow } from "@/lib/progress";
import { StatusRow } from "./interpret-progress";
import { QuestionImages } from "./question-images";
import { RevisePanel, RevisedWith, RevisionNotice } from "./revise-panel";

// The math renderer (katex, marked, dompurify) stays out of the first bundle.
const MathProse = lazy(() => import("./math-prose"));

/** Rendered Markdown and LaTeX, with the plain text in its place while the renderer loads. */
export function RenderedText({
  source,
  chinese = false,
  className,
}: {
  source: string;
  chinese?: boolean;
  className?: string;
}) {
  return (
    <Suspense
      fallback={<div className="whitespace-pre-wrap text-sm leading-7 text-cs-ink">{source}</div>}
    >
      <MathProse source={source} chinese={chinese} className={className} />
    </Suspense>
  );
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]) {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const TAB_CLASS = "inline-flex items-center gap-1 px-3 py-1 transition";

/** The headline per agreement: for two readings compared, and for a re-generated one. */
const VERDICT: Record<
  ReadingAgreement,
  { readings: [string, string]; changes: [string, string]; box: string; icon: typeof Info }
> = {
  agree: {
    readings: ["兩個讀法一致", "The two readings agree"],
    changes: ["冇改動", "Nothing changed"],
    box: "border-[#c9dcc4] bg-[#eef6ea] text-[#2f6b2c]",
    icon: CheckCircle2,
  },
  minor: {
    readings: ["大致一致，有細微分別", "Minor differences"],
    changes: ["小改動", "Small changes"],
    box: "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10]",
    icon: Info,
  },
  differ: {
    readings: ["兩個讀法有分歧 - 請核對", "The readings differ - check these"],
    changes: ["有重要改動 - 請核對", "Key changes - check these"],
    box: "border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] text-[#a85a12]",
    icon: CircleAlert,
  },
};

/**
 * The comparison of the two readings, summed up first (the owner, 3 October
 * 2026): whether they agree and the key differences, in Chinese then
 * English, with the full discrepancies - Chinese first too - a fold away.
 * A reading from before the conclusion existed shows the discrepancies open.
 */
function ReadingConclusion({
  interpretation,
  revised,
}: {
  interpretation: InterpretationResult;
  revised: boolean;
}) {
  const agreement = readingAgreement(interpretation.agreement);
  const chinese = interpretation.conclusion_chinese?.trim() ?? "";
  const english = interpretation.conclusion?.trim() ?? "";
  const hasConclusion = Boolean(agreement || chinese || english);
  const verdict = agreement ? VERDICT[agreement] : null;
  const [headline, headlineEnglish] = verdict
    ? revised
      ? verdict.changes
      : verdict.readings
    : revised
      ? ["改動摘要", "What changed"]
      : ["兩份解讀的比較", "How the two readings compare"];
  const Icon = verdict?.icon ?? Info;
  const detailsChinese = interpretation.discrepancies_chinese?.trim() ?? "";
  const detailsEnglish = interpretation.discrepancies?.trim() ?? "";

  return (
    <div
      className={`mb-3 rounded-cs border px-4 py-3 text-sm ${
        verdict?.box ?? "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10]"
      }`}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-semibold">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-base">{headline}</span>
        <span className="font-normal opacity-80">· {headlineEnglish}</span>
      </p>
      {chinese ? (
        <div className="mt-1">
          <RenderedText source={chinese} chinese />
        </div>
      ) : null}
      {english ? (
        <div className="mt-1">
          <RenderedText source={english} className="!text-[0.82rem] !leading-6 opacity-80" />
        </div>
      ) : null}
      {detailsChinese || detailsEnglish ? (
        <details open={!hasConclusion} className="group/details mt-2 border-t border-current/20 pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold">
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            {revised ? "詳細改動 · Full list of changes" : "詳細分歧 · Full details"}
            <ChevronDown className="h-3.5 w-3.5 transition group-open/details:rotate-180" aria-hidden="true" />
          </summary>
          {detailsChinese ? (
            <div className="mt-2">
              <RenderedText source={detailsChinese} chinese />
            </div>
          ) : null}
          {detailsEnglish ? (
            <div className={detailsChinese ? "mt-2 border-t border-current/20 pt-2" : "mt-2"}>
              <div className="mb-1 text-[0.7rem] font-semibold uppercase tracking-[0.15em] opacity-80">English</div>
              <RenderedText source={detailsEnglish} />
            </div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

export function InterpretationReview({
  images = [],
  interpretation,
  initialText,
  note,
  solvers,
  reviser,
  revising,
  reviseError,
  revisedWith,
  onRevise,
  onStopRevise,
  onConfirm,
  onCancel,
}: {
  /** The question's pages as uploaded, to check the reading against. */
  images?: string[];
  interpretation: InterpretationResult;
  initialText: string;
  /** Set when only one reader's reading arrived, so nothing cross-checked it. */
  note?: string;
  /** Who solves once this is confirmed - nobody has started yet. */
  solvers: string[];
  /** The model that re-generates the reading: the reconciler. */
  reviser: string;
  revising?: { startedAt: number; status: string };
  reviseError?: string;
  /** The instructions this reading was re-generated with. */
  revisedWith?: string;
  onRevise: (currentText: string, instructions: string) => void;
  onStopRevise: () => void;
  onConfirm: (confirmedText: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [editing, setEditing] = useState(false);
  const chinese = interpretation.traditional_chinese?.trim() ?? "";
  const now = useNow(Boolean(revising));

  return (
    <section
      id={STEP_IDS.review}
      tabIndex={-1}
      className="cs-panel mt-6 scroll-mt-28 rounded-cs-lg border-2 border-cs-accent bg-cs-surface p-5 shadow-[0_0_0_4px_var(--cs-ring)] outline-none sm:scroll-mt-20 print:hidden"
    >
      <p className="mb-2 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
        <Eye className="h-4 w-4 text-cs-accent" />
        Review the interpreted question
      </p>

      {interpretation.discrepancies || interpretation.conclusion || interpretation.conclusion_chinese ? (
        <ReadingConclusion interpretation={interpretation} revised={Boolean(revisedWith)} />
      ) : null}
      <p className="mb-3 text-sm text-cs-ink-3">
        {note
          ? "Check the reading below — especially the diagram geometry, supports, and loads — fix anything that is wrong, then confirm to start solving."
          : "Two models read the question independently and a third reconciled them. Check the reading below — especially the diagram geometry, supports, and loads — fix anything that is wrong, then confirm to start solving."}
      </p>

      {solvers.length ? (
        <p className="mb-3 text-sm font-medium text-cs-ink-2">
          Nothing is solved yet: {joinNames(solvers)} start{solvers.length === 1 ? "s" : ""} when
          you confirm.
        </p>
      ) : null}

      {note ? (
        <div className="mb-3 flex gap-2 rounded-cs border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-3 text-sm text-[#a85a12]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{note}</span>
        </div>
      ) : null}

      {revisedWith ? (
        <div className="mb-3">
          <RevisedWith instructions={revisedWith} />
        </div>
      ) : null}

      {reviseError ? (
        <div className="mb-3">
          <RevisionNotice message={reviseError} />
        </div>
      ) : null}

      {/* The question beside its reading (3 October 2026): two columns on a
          wide screen, the pages above the reading on a phone. */}
      <div className={images.length ? "lg:grid lg:grid-cols-2 lg:items-start lg:gap-5" : ""}>
        {images.length ? (
          <details open className="group/img mb-3 lg:sticky lg:top-4 lg:mb-0">
            <summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
              <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
              The question · 題目原圖
              <ChevronDown className="h-3.5 w-3.5 transition group-open/img:rotate-180" aria-hidden="true" />
            </summary>
            <QuestionImages images={images} />
          </details>
        ) : null}
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
              English — sent to the solvers
            </span>
            <span
              className="flex overflow-hidden rounded-full border border-cs-line text-xs font-semibold"
              role="tablist"
              aria-label="Show the reading or edit it"
            >
              <button
                type="button"
                role="tab"
                aria-selected={!editing}
                onClick={() => setEditing(false)}
                className={`${TAB_CLASS} ${
                  editing ? "bg-cs-surface text-cs-ink-2 hover:text-cs-accent" : "bg-cs-accent text-cs-on-accent"
                }`}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                Preview
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={editing}
                onClick={() => setEditing(true)}
                className={`${TAB_CLASS} ${
                  editing ? "bg-cs-accent text-cs-on-accent" : "bg-cs-surface text-cs-ink-2 hover:text-cs-accent"
                }`}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </button>
            </span>
          </div>
          {editing ? (
            <>
              <textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={12}
                aria-label="Verified problem interpretation"
                className="min-h-48 w-full resize-y rounded-cs border border-cs-line bg-cs-surface px-4 py-3 font-mono text-sm text-cs-ink outline-none transition focus:border-cs-accent focus:ring-4 focus:ring-cs-ring"
              />
              <p className="mt-1 text-[0.7rem] text-cs-ink-3">
                Formulas are LaTeX between dollar signs, such as{" "}
                <code>{"$F_x = 10\\,\\text{N}$"}</code>. Switch to Preview to see them typeset.
              </p>
            </>
          ) : (
            <div className="rounded-cs border border-cs-line bg-cs-surface px-4 py-2">
              {text.trim() ? (
                <RenderedText source={text} />
              ) : (
                <p className="py-2 text-sm text-cs-ink-3">Empty - switch to Edit to write the question.</p>
              )}
            </div>
          )}

          {chinese ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                繁體中文 · Traditional Chinese — for reference
              </div>
              <div className="max-h-96 overflow-y-auto rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-2">
                <RenderedText source={chinese} chinese />
              </div>
              <p className="mt-1 text-[0.7rem] text-cs-ink-3">
                Written by the reconciler from its own reading. The solvers get the English above,
                so correct mistakes there - edits to the English do not update this translation.
              </p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        {revising ? (
          <div className="rounded-cs border border-cs-line bg-cs-surface px-4 py-3 text-sm text-cs-ink-2">
            <StatusRow clock={formatClock(now - revising.startedAt)} onStop={onStopRevise}>
              {reviser} is re-generating the reading with your instructions - {revising.status}
            </StatusRow>
          </div>
        ) : (
          <RevisePanel
            title={`Not right? Ask ${reviser} to change the reading`}
            placeholder="e.g. The inclined jet is 30° from the vertical, not the horizontal. The 100 kPa is a gauge pressure."
            hint={`Sends the question images, your notes, the reading above (with your edits)${
              note ? "" : " and both readers' readings"
            } and your instructions back to ${reviser}, which writes a new reading, Chinese included. Or edit the English yourself.`}
            buttonLabel="Re-generate reading"
            disabledReason={text.trim() ? undefined : "The reading is empty - write it in Edit first."}
            onSubmit={(instructions) => onRevise(text, instructions)}
          />
        )}
      </div>

      {/* On a phone the reading is long, so Confirm stays at the bottom of the
          screen while it is read (3 October 2026). */}
      <div className="sticky bottom-0 z-20 -mx-5 mt-4 flex flex-wrap justify-end gap-3 border-t border-cs-line-soft bg-cs-surface/95 px-5 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-2 rounded-cs border-2 border-cs-line bg-cs-surface px-5 py-2.5 text-sm font-semibold text-cs-ink-2 transition hover:border-cs-danger hover:text-cs-danger"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(text.trim())}
          disabled={!text.trim() || Boolean(revising)}
          className="cs-primary inline-flex items-center gap-2 rounded-cs bg-cs-accent px-6 py-2.5 text-sm font-semibold text-cs-on-accent shadow-[0_3px_14px_var(--cs-ring)] transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          Confirm &amp; Solve
        </button>
      </div>
    </section>
  );
}
