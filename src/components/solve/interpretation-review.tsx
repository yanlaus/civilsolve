// Pause-for-review step of the diagram-interpretation pipeline: shows the
// verified interpretation for the user to correct before solving starts,
// with the reconciler's Traditional Chinese version beside it to check
// against.

import { useState } from "react";
import { Check, Eye, Languages, TriangleAlert, X } from "lucide-react";
import type { InterpretationResult } from "../../../shared/interpretation";

export function InterpretationReview({
  interpretation,
  initialText,
  note,
  onConfirm,
  onCancel,
}: {
  interpretation: InterpretationResult;
  initialText: string;
  /** Set when only one reader's reading arrived, so nothing cross-checked it. */
  note?: string;
  onConfirm: (confirmedText: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
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

      {note ? (
        <div className="mb-3 flex gap-2 rounded-cs border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-3 text-sm text-[#a85a12]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{note}</span>
        </div>
      ) : null}

      {interpretation.discrepancies ? (
        <div className="mb-3 rounded-cs border border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] px-4 py-3 text-sm text-[#7a5d10]">
          <span className="font-semibold">Discrepancies found between the two readings:</span>
          <p className="mt-1 whitespace-pre-wrap">{interpretation.discrepancies}</p>
        </div>
      ) : null}

      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
        English — sent to the solvers
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        aria-label="Verified problem interpretation"
        className="min-h-48 w-full resize-y rounded-cs border border-cs-line bg-cs-surface px-4 py-3 font-mono text-sm text-cs-ink outline-none transition focus:border-cs-accent focus:ring-4 focus:ring-cs-ring"
      />

      {chinese ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            繁體中文 · Traditional Chinese — for reference
          </div>
          <div
            lang="zh-Hant-HK"
            className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-cs border border-cs-line-soft bg-cs-muted px-4 py-3 text-sm leading-7 text-cs-ink"
          >
            {chinese}
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
