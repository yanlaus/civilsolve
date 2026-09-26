// Pause-for-review step of the diagram-interpretation pipeline: shows the
// verified interpretation for the user to correct before solving starts,
// with the reconciler's Traditional Chinese version beside it to check
// against. Both are rendered like a solution - Markdown, LaTeX typeset - and
// the English can be edited as source, with its preview a tab away.

import { lazy, Suspense, useState } from "react";
import { Check, Eye, Languages, Pencil, TriangleAlert, X } from "lucide-react";
import type { InterpretationResult } from "../../../shared/interpretation";

// The math renderer (katex, marked, dompurify) stays out of the first bundle.
const MathProse = lazy(() => import("./math-prose"));

/** Rendered Markdown and LaTeX, with the plain text in its place while the renderer loads. */
export function RenderedText({ source, chinese = false }: { source: string; chinese?: boolean }) {
  return (
    <Suspense
      fallback={<div className="whitespace-pre-wrap text-sm leading-7 text-cs-ink">{source}</div>}
    >
      <MathProse source={source} chinese={chinese} />
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

export function InterpretationReview({
  interpretation,
  initialText,
  note,
  solvers,
  onConfirm,
  onCancel,
}: {
  interpretation: InterpretationResult;
  initialText: string;
  /** Set when only one reader's reading arrived, so nothing cross-checked it. */
  note?: string;
  /** Who solves once this is confirmed - nobody has started yet. */
  solvers: string[];
  onConfirm: (confirmedText: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [editing, setEditing] = useState(false);
  const chinese = interpretation.traditional_chinese?.trim() ?? "";

  return (
    <section className="cs-panel mt-6 rounded-cs-lg border-2 border-cs-accent bg-cs-surface p-5 shadow-[0_0_0_4px_var(--cs-ring)] print:hidden">
      <p className="mb-2 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
        <Eye className="h-4 w-4 text-cs-accent" />
        Review the interpreted question
      </p>
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

      {interpretation.discrepancies ? (
        <div className="mb-3 rounded-cs border border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] px-4 py-3 text-sm text-[#7a5d10]">
          <span className="font-semibold">Discrepancies found between the two readings:</span>
          <div className="mt-1">
            <RenderedText source={interpretation.discrepancies} />
          </div>
        </div>
      ) : null}

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

      <div className="mt-4 flex flex-wrap justify-end gap-3">
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
          disabled={!text.trim()}
          className="cs-primary inline-flex items-center gap-2 rounded-cs bg-cs-accent px-6 py-2.5 text-sm font-semibold text-cs-on-accent shadow-[0_3px_14px_var(--cs-ring)] transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-4 w-4" />
          Confirm &amp; Solve
        </button>
      </div>
    </section>
  );
}
