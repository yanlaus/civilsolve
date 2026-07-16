// Pause-for-review step of the diagram-interpretation pipeline: shows the
// verified interpretation for the user to correct before solving starts.

import { useState } from "react";
import { Check, Eye, X } from "lucide-react";
import type { InterpretationResult } from "../../../shared/interpretation";

export function InterpretationReview({
  interpretation,
  initialText,
  onConfirm,
  onCancel,
}: {
  interpretation: InterpretationResult;
  initialText: string;
  onConfirm: (confirmedText: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);

  return (
    <section className="mt-6 rounded-2xl border-2 border-[#b35c1e] bg-white p-5 shadow-[0_0_0_4px_rgba(179,92,30,0.12)] print:hidden dark:border-[#e8903a] dark:bg-[#151d2e]">
      <p className="mb-2 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
        <Eye className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
        Review the interpreted question
      </p>
      <p className="mb-3 text-sm text-[#8a7f72] dark:text-[#a8a098]">
        Two models read the question independently and a third reconciled them. Check the
        reading below — especially the diagram geometry, supports, and loads — fix anything
        that is wrong, then confirm to start solving.
      </p>

      {interpretation.discrepancies ? (
        <div className="mb-3 rounded-[10px] border border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] px-4 py-3 text-sm text-[#7a5d10] dark:border-[#5b512a] dark:text-[#e6d6a0]">
          <span className="font-semibold">Discrepancies found between the two readings:</span>
          <p className="mt-1 whitespace-pre-wrap">{interpretation.discrepancies}</p>
        </div>
      ) : null}

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={12}
        aria-label="Verified problem interpretation"
        className="min-h-48 w-full resize-y rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 font-mono text-sm text-[#1b1610] outline-none transition focus:border-[#b35c1e] focus:ring-4 focus:ring-[rgba(179,92,30,0.15)] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db] dark:focus:border-[#e8903a]"
      />

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
