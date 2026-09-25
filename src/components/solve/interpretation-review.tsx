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
    <section className="mt-6 rounded-2xl border-2 border-[#b35c1e] bg-white p-5 shadow-[0_0_0_4px_rgba(179,92,30,0.12)] print:hidden dark:border-[#e8903a] dark:bg-[#151d2e]">
      <p className="mb-2 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
        <Eye className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
        Review the interpreted question
      </p>
      <p className="mb-3 text-sm text-[#8a7f72] dark:text-[#a8a098]">
        {note
          ? "Check the reading below — especially the diagram geometry, supports, and loads — fix anything that is wrong, then confirm to start solving."
          : "Two models read the question independently and a third reconciled them. Check the reading below — especially the diagram geometry, supports, and loads — fix anything that is wrong, then confirm to start solving."}
      </p>

      {note ? (
        <div className="mb-3 flex gap-2 rounded-[10px] border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-3 text-sm text-[#a85a12] dark:border-[#5b4020] dark:text-[#f0b878]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{note}</span>
        </div>
      ) : null}

      {interpretation.discrepancies ? (
        <div className="mb-3 rounded-[10px] border border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] px-4 py-3 text-sm text-[#7a5d10] dark:border-[#5b512a] dark:text-[#e6d6a0]">
          <span className="font-semibold">Discrepancies found between the two readings:</span>
          <p className="mt-1 whitespace-pre-wrap">{interpretation.discrepancies}</p>
        </div>
      ) : null}

      <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
        English — sent to the solvers
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        aria-label="Verified problem interpretation"
        className="min-h-48 w-full resize-y rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 font-mono text-sm text-[#1b1610] outline-none transition focus:border-[#b35c1e] focus:ring-4 focus:ring-[rgba(179,92,30,0.15)] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db] dark:focus:border-[#e8903a]"
      />

      {chinese ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            繁體中文 · Traditional Chinese — for reference
          </div>
          <div
            lang="zh-Hant-HK"
            className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-[10px] border border-[#e8e3db] bg-[#faf8f5] px-4 py-3 text-sm leading-7 text-[#1b1610] dark:border-[#1e2a40] dark:bg-[#0e1420] dark:text-[#e4e0db]"
          >
            {chinese}
          </div>
          <p className="mt-1 text-[0.7rem] text-[#8a7f72] dark:text-[#6e6960]">
            Written by the reconciler from its own reading. The solvers get the English above,
            so correct mistakes there - edits to the English do not update this translation.
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-2 rounded-[10px] border-2 border-[#d4cdc3] bg-white px-5 py-2.5 text-sm font-semibold text-[#5c5347] transition hover:border-[#c0392b] hover:text-[#c0392b] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098]"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(text.trim())}
          disabled={!text.trim()}
          className="inline-flex items-center gap-2 rounded-[10px] bg-[#b35c1e] px-6 py-2.5 text-sm font-semibold text-white shadow-[0_3px_14px_rgba(179,92,30,0.15)] transition hover:bg-[#9a4d17] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#e8903a] dark:text-[#0e1420] dark:hover:bg-[#f5a04f]"
        >
          <Check className="h-4 w-4" />
          Confirm &amp; Solve
        </button>
      </div>
    </section>
  );
}
