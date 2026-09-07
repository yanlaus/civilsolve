// Markdown + math rendering pipeline (moved verbatim from the old
// civil-answer-app monolith). katex/marked live only in this module so the
// whole stack stays out of the initial bundle — import it from lazy chunks.

import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";
import "katex/dist/katex.min.css";
import { sanitizeText } from "../../shared/solution";

marked.setOptions({ breaks: true, gfm: true });

function protectCodeSpans(value: string) {
  const protectedChunks: string[] = [];
  const protectedText = value.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    const token = `@@CIVILSOLVE_CODE_${protectedChunks.length}@@`;
    protectedChunks.push(match);
    return token;
  });

  return { protectedText, protectedChunks };
}

function restoreCodeSpans(value: string, protectedChunks: string[]) {
  return protectedChunks.reduce(
    (current, chunk, index) => current.replaceAll(`@@CIVILSOLVE_CODE_${index}@@`, chunk),
    value,
  );
}

function normalizeMathMarkdown(value: string) {
  return autoFormatPlainMath(
    normalizeProviderArtifacts(value)
      .replace(/\s+(Step\s+\d+\s*(?:[–-]|:))/gi, "\n\n$1")
      .replace(
        /```(?:latex|tex|math)\s*([\s\S]*?)```/gi,
        (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`,
      ),
  );
}

function normalizeProviderArtifacts(value: string) {
  return value
    .replace(/^\s*\\\s*$/gm, "")
    .replace(/(^|\n)\s*\\\s*(?=\\)/g, "$1")
    .replace(/(^|\n)\s*代入[:：]\s*/g, "$1Substitute:\n")
    .replace(/(^|\n)\s*結果[:：]\s*/g, "$1Result:\n")
    .replace(/(^|\n)\s*已知[:：]\s*/g, "$1Given:\n")
    .replace(/(^|\n)\s*所求[:：]\s*/g, "$1Required:\n")
    .replace(/(^|\n)\s*公式[:：]\s*/g, "$1Formula:\n")
    .replace(/\\times\s*\\times\s*([^\n]*?)\s*\\times\s*\\times/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/\\times\s+([A-Za-z][^\\\n]{1,80}?)\s*\\times/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/×\s*×\s*([^\n]*?)\s*×\s*×/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/\\begin\{align\\times\s*\}/g, "\\begin{align*}")
    .replace(/\\end\{align\\times\s*\}/g, "\\end{align*}")
    .replace(/\\section\\times\s*\{/g, "\\section*{")
    .replace(/\\text\{\s*\\mathrm\{([^{}]+)\}\s*\}/g, "\\text{$1}")
    .replace(/\\text\{\s+([^{}]+)\s+\}/g, "\\text{$1}");
}

function autoFormatPlainMath(value: string) {
  let inDisplayMath = false;

  return value
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();

      if (trimmed === "$$") {
        inDisplayMath = !inDisplayMath;
        return line;
      }

      if (trimmed === "\\[" || /^\\begin\{(?:aligned|align\*?)\}/.test(trimmed)) {
        inDisplayMath = true;
        return line;
      }

      if (trimmed === "\\]" || /^\\end\{(?:aligned|align\*?)\}/.test(trimmed)) {
        inDisplayMath = false;
        return line;
      }

      if (inDisplayMath) {
        return line;
      }

      return formatPlainMathLine(line);
    })
    .join("\n");
}

function formatPlainMathLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || isMarkdownStructureLine(trimmed) || isDelimitedMathLine(trimmed)) {
    return line;
  }

  if (hasInlineMath(trimmed)) {
    return line;
  }

  const prefixMatch = trimmed.match(/^(.{1,90}:)\s+(.+)$/);
  if (prefixMatch && isMathHeavyText(prefixMatch[2])) {
    const split = splitMathTail(prefixMatch[2]);
    return `${prefixMatch[1]}\n\n$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
  }

  const labeledMath = splitLeadingPlainTextLabel(trimmed);
  if (labeledMath && isMathHeavyText(labeledMath.math)) {
    const split = splitMathTail(labeledMath.math);
    return `${labeledMath.label}\n\n$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
  }

  if (!isMathHeavyText(trimmed)) return line;

  const split = splitMathTail(trimmed);
  return `$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
}

function hasInlineMath(value: string) {
  return /(^|[^\\\w])\$[^\n$]+?\$(?!\w)/.test(value) || /\\\([^\n]+?\\\)/.test(value);
}

function isMarkdownStructureLine(value: string) {
  return /^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\|)/.test(value);
}

function isDelimitedMathLine(value: string) {
  return (
    value.startsWith("$$") ||
    value.endsWith("$$") ||
    value.startsWith("\\[") ||
    value.endsWith("\\]") ||
    value.startsWith("\\begin{") ||
    value.endsWith("\\end{aligned}")
  );
}

function isMathHeavyText(value: string) {
  const text = value.replace(/\\([_*])/g, "$1");
  if (!/[=≈<>±]|\b(?:frac|sqrt|sin|cos|tan)\b|\\(?:frac|sqrt|text|mathrm|gamma|sum)|[σΣΔθπγ]/i.test(text)) return false;
  const mathSignals = [
    /[A-Za-z0-9)]\s*=\s*[-+A-Za-z0-9(]/,
    /[A-Za-z][A-Za-z]?_\{?[A-Za-z0-9]+\}?/,
    /\\[A-Za-z]+/,
    /[A-Za-z][A-Za-z]?\^\d/,
    /[²³⁴⁵⁶⁷⁸⁹]/,
    /\d\s*(?:[-+*/×])\s*\d/,
    /\d\s*(?:kN|N|mm|m|MPa|Pa)\b/i,
    /[σΣΔθπ]/,
    /\b[PMVIABD]\s*=/,
  ];
  return mathSignals.some((pattern) => pattern.test(text));
}

function splitMathTail(value: string) {
  const stepMatch = value.match(/^(.*?)(\s+Step\s+\d+\s*(?:[–-]|:).*)$/i);
  if (stepMatch) {
    return { math: stepMatch[1].trim(), tail: stepMatch[2].trim() };
  }
  const tailMatch = value.match(/^(.*?)(?:,?\s+where\b|\s+Note:)\s+(.+)$/i);
  if (!tailMatch) return { math: value, tail: "" };
  return { math: tailMatch[1].trim(), tail: tailMatch[2].trim() };
}

function splitLeadingPlainTextLabel(value: string) {
  const match = value.match(
    /^([A-Z][A-Za-z\s,()/.-]{2,70}?)\s+((?:[A-Za-z]{1,3}|[σΣΔθπ]|[A-Za-z]{1,3}_[A-Za-z0-9]+)\s*(?:\\_)?[A-Za-z0-9]*\s*=.+)$/u,
  );
  if (!match) return null;
  return {
    label: match[1].replace(/\s*,\s*$/, "").trim(),
    math: match[2].trim(),
  };
}

function toLatexishMath(value: string) {
  return normalizeMathExpression(value)
    .replace(/\\([_*])/g, "$1")
    .replace(/[−–—]/g, "-")
    .replace(/[×*]/g, "\\times ")
    .replace(/·/g, "\\cdot ")
    .replace(/≈/g, "\\approx ")
    .replace(/≤/g, "\\le ")
    .replace(/≥/g, "\\ge ")
    .replace(/σ/g, "\\sigma ")
    .replace(/Σ/g, "\\Sigma ")
    .replace(/Δ/g, "\\Delta ")
    .replace(/θ/g, "\\theta ")
    .replace(/γ/g, "\\gamma ")
    .replace(/π/g, "\\pi ")
    .replace(/²/g, "^{2}")
    .replace(/³/g, "^{3}")
    .replace(/⁴/g, "^{4}")
    .replace(/⁵/g, "^{5}")
    .replace(/⁶/g, "^{6}")
    .replace(/⁷/g, "^{7}")
    .replace(/⁸/g, "^{8}")
    .replace(/⁹/g, "^{9}")
    .replace(/\\sigma\s*_([A-Za-z0-9]+)/g, "\\sigma_{$1}")
    .replace(/\\Sigma\s*_([A-Za-z0-9]+)/g, "\\Sigma_{$1}")
    .replace(/\\Delta\s*_([A-Za-z0-9]+)/g, "\\Delta_{$1}")
    .replace(/\\theta\s*_([A-Za-z0-9]+)/g, "\\theta_{$1}")
    .replace(/\\gamma\s*_([A-Za-z0-9]+)/g, "\\gamma_{$1}")
    .replace(/\\pi\s*_([A-Za-z0-9]+)/g, "\\pi_{$1}")
    .replace(/\b([A-Za-z]{1,3})_([A-Za-z0-9]+)\b/g, "$1_{$2}")
    .replace(/\b([A-Za-z]{1,3})_\{([A-Za-z0-9]+)\}/g, "$1_{$2}")
    .replace(/\b([A-Za-z]{1,3})\^([0-9]+)\b/g, "$1^{$2}")
    .replace(/\b(\d[\d,]*(?:\.\d+)?)\s*(kN|N|mm|m|MPa|Pa)\b/g, "$1\\,\\mathrm{$2}")
    .replace(/\b(mm|MPa|Pa|kN|N)\^\{(\d+)\}/g, "\\mathrm{$1}^{$2}")
    .replace(/\b(mm|MPa|Pa|kN|N)\b/g, "\\mathrm{$1}")
    .replace(/\((Compressive|Tensile|max|min)\)/gi, (_match, label: string) => `(\\text{${label}})`)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMathExpression(value: string) {
  return value
    .replace(/\\{2,},/g, "\\,")
    .replace(
      /\\{2,}(?=(?:left|right|frac|sqrt|gamma|text|mathrm|sum|pi|theta|sigma|Delta|Sigma)\b)/g,
      "\\",
    )
    .replace(/\\,\s*/g, " ")
    .replace(/\\([_&%#])/g, "$1")
    .replace(
      /(^|[^\\A-Za-z])(left|right|frac|sqrt|gamma|text|mathrm|sum|pi|theta|sigma|Delta|Sigma)\b/g,
      "$1\\$2",
    )
    .replace(/\\text\{\s*\\mathrm\{([^{}]+)\}\s*\}/g, "\\text{$1}")
    .replace(/\\text\{\s+([^{}]+)\s+\}/g, "\\text{$1}")
    .replace(/\\mathrm\{\s*([^{}]+)\s*\}/g, "\\mathrm{$1}")
    .replace(/,\s*\\text\{/g, "\\,\\text{")
    .replace(/\\times\s+\\times/g, "\\times")
    .trim();
}

function renderMathExpression(expression: string, displayMode: boolean) {
  return katex.renderToString(normalizeMathExpression(expression), {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });
}

function replaceMathWithPlaceholders(value: string) {
  const mathHtml: string[] = [];
  let next = value;

  const addMath = (expression: string, displayMode: boolean) => {
    const token = `@@CIVILSOLVE_MATH_${mathHtml.length}@@`;
    mathHtml.push(renderMathExpression(expression, displayMode));
    return token;
  };

  next = next.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression: string) =>
    addMath(expression, true),
  );
  next = next.replace(/\\\[([\s\S]+?)\\\]/g, (_match, expression: string) =>
    addMath(expression, true),
  );
  next = next.replace(/\\\(([\s\S]+?)\\\)/g, (_match, expression: string) =>
    addMath(expression, false),
  );
  next = next.replace(/(^|[^\\\w])\$([^\n$]+?)\$(?!\w)/g, (_match, prefix: string, expression: string) =>
    `${prefix}${addMath(expression, false)}`,
  );

  return { markdown: next, mathHtml };
}

function restoreMathHtml(value: string, mathHtml: string[]) {
  return mathHtml.reduce(
    (current, html, index) => current.replaceAll(`@@CIVILSOLVE_MATH_${index}@@`, html),
    value,
  );
}

/**
 * Renders one provider field to HTML.
 *
 * The input is model output, which is untrusted: the assignment images are
 * user-supplied, so anything in them can steer what the model writes. `marked`
 * passes raw HTML straight through, and the result is injected with
 * dangerouslySetInnerHTML, so the markdown HTML is sanitized before it reaches
 * the DOM. KaTeX output is spliced in afterwards, from placeholders, so our own
 * generated math markup is never mangled by the sanitizer.
 */
export function renderMarkdown(value: string) {
  try {
    const { protectedText, protectedChunks } = protectCodeSpans(
      normalizeMathMarkdown(sanitizeText(value)),
    );
    const { markdown, mathHtml } = replaceMathWithPlaceholders(protectedText);
    const html = marked.parse(restoreCodeSpans(markdown, protectedChunks)) as string;
    return restoreMathHtml(DOMPurify.sanitize(html), mathHtml);
  } catch {
    const escaped = sanitizeText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre>${escaped}</pre>`;
  }
}
