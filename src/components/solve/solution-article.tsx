import { useMemo } from "react";
import { renderMarkdown } from "@/lib/math-markdown";

export function SolutionArticle({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);

  return (
    <article
      // Every heading level in the ink colour and a modest size: sub-headers
      // are the model's choice of #, ##, ### or bold, and ## used to come out
      // large and in the accent colour (brown in Classic and Unicorn) next to
      // dark ### and bold ones - "some sub-headers turned brown" (the owner,
      // 27 September 2026).
      className="solution-content prose prose-stone max-w-none min-w-0 overflow-x-hidden px-4 py-6 text-[1rem] leading-8 prose-headings:mb-2 prose-headings:mt-5 prose-headings:font-display prose-headings:text-cs-ink prose-h1:border-b prose-h1:border-cs-line prose-h1:pb-2 prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-h4:text-base prose-pre:overflow-x-auto prose-pre:rounded-cs prose-pre:border prose-pre:border-cs-line-soft prose-pre:bg-cs-sunken/70 prose-code:text-cs-ink sm:px-7 sm:py-8 sm:text-[1.05rem]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
