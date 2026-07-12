import { useMemo } from "react";
import { renderMarkdown } from "@/lib/math-markdown";

export function SolutionArticle({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);

  return (
    <article
      className="solution-content prose prose-stone max-w-none min-w-0 overflow-x-hidden px-4 py-6 text-[1rem] leading-8 prose-headings:font-serif prose-headings:text-[#1b1610] prose-h1:border-b prose-h1:border-[#b35c1e] prose-h1:pb-2 prose-h2:text-[#b35c1e] prose-pre:overflow-x-auto prose-pre:rounded-[10px] prose-pre:border prose-pre:border-[#e8e3db] prose-pre:bg-[#e8e3db]/70 prose-code:text-[#b35c1e] dark:prose-invert dark:prose-headings:text-[#e4e0db] dark:prose-h2:text-[#e8903a] dark:prose-pre:border-[#1e2a40] dark:prose-pre:bg-[#080d15] dark:prose-code:text-[#e8903a] sm:px-7 sm:py-8 sm:text-[1.05rem]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
