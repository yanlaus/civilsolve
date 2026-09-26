import { useMemo } from "react";
import { renderMarkdown } from "@/lib/math-markdown";

export function SolutionArticle({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);

  return (
    <article
      className="solution-content prose prose-stone max-w-none min-w-0 overflow-x-hidden px-4 py-6 text-[1rem] leading-8 prose-headings:font-display prose-headings:text-cs-ink prose-h1:border-b prose-h1:border-cs-accent prose-h1:pb-2 prose-h2:text-cs-accent prose-pre:overflow-x-auto prose-pre:rounded-cs prose-pre:border prose-pre:border-cs-line-soft prose-pre:bg-cs-sunken/70 prose-code:text-cs-accent sm:px-7 sm:py-8 sm:text-[1.05rem]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
