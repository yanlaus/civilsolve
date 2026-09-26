// Model-written text rendered the way the solutions are: Markdown with its
// LaTeX typeset by KaTeX. Used for the interpretation (the review step and
// the confirmed reading kept above the solutions) and the verdict. It pulls
// in lib/math-markdown.ts, so it is only ever reached through a lazy chunk -
// the solution panel, or the lazy() import in interpretation-review.tsx.

import { useMemo } from "react";
import { renderMarkdown } from "@/lib/math-markdown";

export default function MathProse({
  source,
  chinese = false,
  className = "",
}: {
  source: string;
  /** Traditional Chinese text: keeps its 已知 / 所求 labels (lib/math-markdown.ts). */
  chinese?: boolean;
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(source, { chinese }), [source, chinese]);
  return (
    <div
      lang={chinese ? "zh-Hant-HK" : undefined}
      className={`solution-content prose prose-stone max-w-none min-w-0 overflow-x-hidden text-[0.95rem] leading-7 prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-code:text-cs-accent ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
