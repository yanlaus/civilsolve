// The page's Markdown + math renderer: the shared pipeline
// (shared/markdown.ts) with DOMPurify as its sanitizer, and KaTeX's
// stylesheet. katex, marked and DOMPurify live only behind this module so the
// whole stack stays out of the initial bundle - import it from lazy chunks.

import DOMPurify from "dompurify";
import "katex/dist/katex.min.css";
import { renderMarkdownWith, type RenderOptions } from "../../shared/markdown";

export type { RenderOptions };

/**
 * One model-written field as HTML, sanitized by DOMPurify before it is set
 * with dangerouslySetInnerHTML.
 */
export function renderMarkdown(value: string, options: RenderOptions = {}) {
  return renderMarkdownWith(value, options, (html) => DOMPurify.sanitize(html));
}
