// Model-written text rendered the way the solutions are: Markdown with its
// LaTeX typeset by KaTeX. Used for the interpretation (the review step and
// the confirmed reading kept above the solutions) and the verdict. It pulls
// in lib/math-markdown.ts, so it is only ever reached through a lazy chunk -
// the solution panel, or the lazy() import in interpretation-review.tsx.

import { useMemo } from "react";
import { renderMarkdown } from "@/lib/math-markdown";

/**
 * Lines of about 70 characters - some 35 in Chinese - and air between
 * paragraphs and points (11 October 2026, the owner: the reading, the
 * verdict and the study notes ran the full width of a wide screen, about
 * 100 characters a line, and read as a wall of text). A narrow column, a
 * card in a grid or a phone, is not affected.
 */
export const READABLE_MEASURE = "max-w-[70ch]";

export default function MathProse({
  source,
  chinese = false,
  wide = false,
  className = "",
}: {
  source: string;
  /** Traditional Chinese text: keeps its 已知 / 所求 labels (lib/math-markdown.ts). */
  chinese?: boolean;
  /** The full width instead of a readable line length. */
  wide?: boolean;
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(source, { chinese }), [source, chinese]);
  return (
    <div
      lang={chinese ? "zh-Hant-HK" : undefined}
      className={`solution-content prose prose-stone ${wide ? "max-w-none" : READABLE_MEASURE} min-w-0 overflow-x-hidden text-[0.95rem] leading-7 prose-p:my-3 prose-ul:my-2.5 prose-ol:my-2.5 prose-li:my-1 prose-code:text-cs-accent ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
