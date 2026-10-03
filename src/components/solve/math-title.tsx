// A title written by a model - a step's, a problem part's, a solution's - on
// one line, its `$...$` formulas typeset (renderTitle in lib/math-markdown.ts)
// rather than shown as raw LaTeX. For lazy-loaded components only: it brings
// the math renderer with it.

import { useMemo } from "react";
import { renderTitle } from "@/lib/math-markdown";

export function MathTitle({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderTitle(text), [text]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
