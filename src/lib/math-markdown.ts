// Markdown + math rendering pipeline (moved verbatim from the old
// civil-answer-app monolith). katex/marked live only in this module so the
// whole stack stays out of the initial bundle — import it from lazy chunks.

import DOMPurify from "dompurify";
import katex from "katex";
import { marked } from "marked";
import "katex/dist/katex.min.css";
import { fixEscapedNewlines, sanitizeText } from "../../shared/solution";

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

export type RenderOptions = {
  /**
   * Text written in Chinese on purpose (the Traditional Chinese reading and
   * verdict): its 已知 / 所求 / 代入 labels are kept, not turned into the
   * English ones a solver that slipped into Chinese gets.
   */
  chinese?: boolean;
};

/**
 * A response cut off mid-formula leaves its math open - "$$\sum F_y=(7.60)(10)+
 * (14.74)(-16." then the cut-off note - and the whole formula showed as raw
 * text. Closed here, before the note: an odd `$$`, or a lone `$` on the last
 * line when what follows it reads as math. Only a cut-off field is touched;
 * anywhere else an odd dollar is more likely a price than a formula.
 */
function closeCutOffMath(value: string) {
  const note = value.search(/\s*\[The response was cut off[^\]\n]*\]\s*$/);
  if (note < 0) return value;
  let body = value.slice(0, note);
  if ((body.match(/\$\$/g) || []).length % 2 === 1) {
    body = `${body}\n$$`;
  } else {
    const lastLine = body.slice(body.lastIndexOf("\n") + 1);
    const singles = (lastLine.replace(/\$\$/g, "").match(/\$/g) || []).length;
    if (singles % 2 === 1 && /\$[^$]*[\\^_{=]/.test(lastLine)) body = `${body}$`;
  }
  return `${body}${value.slice(note)}`;
}

/**
 * Inline math opened with one delimiter and closed with the other -
 * "($x = 2^{-}\) m)", seen on MiniMax - made one inline formula. A pair with
 * a delimiter of the other kind inside ("$a$ and \(b\)") is left as it is.
 */
function matchMixedDelimiters(value: string) {
  return value
    .replace(/\$([^$\n]{1,160}?)\\\)/g, (match, inner: string) =>
      inner.includes("\\(") ? match : `$${inner}$`,
    )
    .replace(/\\\(([^$\n]{1,160}?)\$/g, (match, inner: string) =>
      inner.includes("\\)") ? match : `$${inner}$`,
    );
}

function normalizeMathMarkdown(value: string, options: RenderOptions) {
  return autoFormatPlainMath(
    normalizeProviderArtifacts(matchMixedDelimiters(closeCutOffMath(value)), options)
      .replace(/\s+(Step\s+\d+\s*(?:[–-]|:))/gi, "\n\n$1")
      .replace(
        /```(?:latex|tex|math)\s*([\s\S]*?)```/gi,
        (_match, expression: string) => `\n$$\n${expression.trim()}\n$$\n`,
      ),
  );
}

function translateCjkLabels(value: string) {
  return value
    .replace(/(^|\n)\s*代入[:：]\s*/g, "$1Substitute:\n")
    .replace(/(^|\n)\s*結果[:：]\s*/g, "$1Result:\n")
    .replace(/(^|\n)\s*已知[:：]\s*/g, "$1Given:\n")
    .replace(/(^|\n)\s*所求[:：]\s*/g, "$1Required:\n")
    .replace(/(^|\n)\s*公式[:：]\s*/g, "$1Formula:\n");
}

function normalizeProviderArtifacts(value: string, options: RenderOptions) {
  const stripped = value
    .replace(/^\s*\\\s*$/gm, "")
    .replace(/(^|\n)\s*\\\s*(?=\\)/g, "$1");
  return (options.chinese ? stripped : translateCjkLabels(stripped))
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

// Chinese prose. A line with any is a sentence, never a bare formula, and
// KaTeX cannot typeset it in math mode.
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;

function formatPlainMathLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || isDelimitedMathLine(trimmed)) return line;
  if (
    isMarkdownStructureLine(trimmed) ||
    CJK.test(trimmed) ||
    hasInlineMath(trimmed) ||
    trimmed.includes("**")
  ) {
    return typesetBareSymbols(line);
  }

  // A formula is wrapped in display math; a sentence that holds one is not.
  const isFormula = (text: string) => isMathHeavyText(text) && !isProse(text);

  const prefixMatch = trimmed.match(/^(.{1,90}:)\s+(.+)$/);
  if (prefixMatch && isFormula(prefixMatch[2])) {
    const split = splitMathTail(prefixMatch[2]);
    return `${prefixMatch[1]}\n\n$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
  }

  const labeledMath = splitLeadingPlainTextLabel(trimmed);
  if (labeledMath && isFormula(labeledMath.math)) {
    const split = splitMathTail(labeledMath.math);
    return `${labeledMath.label}\n\n$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
  }

  if (!isFormula(trimmed)) return typesetBareSymbols(line);

  const split = splitMathTail(trimmed);
  return `$$\n${toLatexishMath(split.math)}\n$$${split.tail ? `\n\n${split.tail}` : ""}`;
}

/**
 * Symbols a model left bare in a sentence - F_x, V_{in}, d_1, kg/m^3 -
 * typeset where they stand, in inline math. Text already in math, in code
 * or in a link is left alone, and so is anything longer than a symbol: a
 * base of one or two letters, a subscript of up to four characters, or one
 * of the units below with a power.
 */
function typesetBareSymbols(line: string) {
  if (!/[_^]/.test(line) || line.includes("`") || /\]\(/.test(line)) return line;
  // Split off what is already math, so only the text in between changes.
  const parts = line.split(/(\$\$[^$]*\$\$|\$[^$\n]*\$|\\\([^\n]*?\\\))/);
  // LaTeX commands in the text itself: raw LaTeX, not a sentence - cutting
  // symbols out of it would break it apart.
  if (parts.some((part, index) => index % 2 === 0 && /\\[A-Za-z]{2,}/.test(part))) return line;
  return parts
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(
              /(^|[^\\\w$])([A-Za-z]{1,2})_(\{[A-Za-z0-9,]{1,6}\}|[A-Za-z0-9]{1,4})(?![\w{])/g,
              (_match, prefix: string, base: string, sub: string) =>
                `${prefix}$${base}_{${sub.replace(/^\{|\}$/g, "")}}$`,
            )
            .replace(
              /(^|[^\\\w$])((?:kg|g|N|kN|mm|cm|km|m|s|Pa|kPa|MPa)(?:\/(?:mm|cm|m|s))?)\^(-?\d)(?![\w])/g,
              (_match, prefix: string, unit: string, power: string) =>
                `${prefix}$\\text{${unit}}^{${power}}$`,
            ),
    )
    .join("");
}

function hasInlineMath(value: string) {
  return (
    /(^|[^\\\w])\$[^\n$]+?\$(?!\w)/.test(value) ||
    /\\\([^\n]+?\\\)/.test(value) ||
    // A LaTeX span glued to a word, such as a unit's "mm$^2$" (see
    // replaceMathWithPlaceholders): the line already has its math.
    /(^|[^\\$])\$[^\n$]*?[\\^_{][^\n$]*?\$/.test(value)
  );
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

// Words a formula may hold that are math, not English: functions, Greek
// letters written out, units.
const MATH_WORDS = new Set([
  "sin", "cos", "tan", "sec", "csc", "cot", "log", "exp", "max", "min", "lim", "sum", "frac",
  "sqrt", "text", "mathrm", "left", "right", "cdot", "times", "approx", "rho", "theta", "alpha",
  "beta", "gamma", "delta", "sigma", "omega", "lambda", "tau", "phi", "psi", "eta", "kpa", "mpa",
  "gpa", "rad", "deg",
]);

function englishWords(value: string) {
  // Only the words at the top level count: what sits in braces or a
  // subscript (A_{inlet}, V_{jet}, \dfrac{...}) is part of a formula.
  let bare = value.replace(/[_^](?:\{[^{}]*\}|[A-Za-z0-9]+)/g, " ");
  for (let pass = 0; pass < 4 && /\{[^{}]*\}/.test(bare); pass += 1) {
    bare = bare.replace(/\{[^{}]*\}/g, " ");
  }
  return (bare.replace(/\\[A-Za-z]+/g, " ").match(/[A-Za-z]{3,}/g) || []).filter(
    (word) => !MATH_WORDS.has(word.toLowerCase()),
  );
}

/**
 * A sentence, not a formula: four or more English words. Such a line holds
 * an equation now and then ("Ethyl alcohol (S.G. = 0.79) enters a sphere
 * through a 60 mm pipe"), and wrapping it whole in math set every word in
 * italic math letters with the spaces gone - "Determinethereactionforces..."
 * (27 September 2026).
 */
function isProse(value: string) {
  return englishWords(value).length >= 4;
}

function toLatexishMath(value: string) {
  const { text, groups } = shieldTextGroups(normalizeMathExpression(value));
  const converted = text
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
    // English left in the formula ("(upward)", "to the left") as upright
    // text with its spaces, not italic letters run together.
    .replace(
      /(^|[^\\A-Za-z_^{@])([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})*)(?![A-Za-z{@])/g,
      (match, prefix: string, run: string) =>
        englishWords(run).length && run.split(/\s+/).every((word) => word.length >= 2 && !MATH_WORDS.has(word.toLowerCase()) && !/^(?:mm|cm|km|kg|kN|Pa|kPa|MPa|GPa|rad|s)$/.test(word))
          ? `${prefix}\\text{${run}}`
          : match,
    );
  return restoreTextGroups(converted, groups).replace(/\s+/g, " ").trim();
}

// Text inside math - \text{to the left}, \mathrm{kN} - is set aside while the
// repairs below run, so none of them reaches into it.
const TEXT_GROUP = /\\(?:text|textrm|textbf|textit|mathrm|mbox|operatorname)\s*\{[^{}]*\}/g;

function shieldTextGroups(value: string) {
  const groups: string[] = [];
  const text = value.replace(TEXT_GROUP, (group) => `@@TG${groups.push(group) - 1}@@`);
  return { text, groups };
}

function restoreTextGroups(value: string, groups: string[]) {
  return value.replace(/@@TG(\d+)@@/g, (_match, index: string) => groups[Number(index)]);
}

function normalizeMathExpression(value: string) {
  const { text, groups } = shieldTextGroups(
    value
      // Backslashes doubled by a JSON escape too many: \\circ, \\frac.
      .replace(/\\{2,},/g, "\\,")
      .replace(
        /\\{2,}(?=(?:left|right|frac|sqrt|gamma|text|mathrm|sum|pi|theta|sigma|Delta|Sigma|circ|cdot|times|approx|sin|cos|tan|mathbf|rho|alpha|beta|omega|hat|vec|quad|qquad|Rightarrow|rightarrow)\b)/g,
        "\\",
      )
      // "35,\text{mm}": a thin space that lost its backslash.
      .replace(/(\d),(?=\\text\{)/g, "$1\\,"),
  );
  const repaired = text
    // Thin spaces are kept: stripping them set every unit against its
    // number ("60mm") until 27 September 2026.
    .replace(/\\,\s+/g, "\\,")
    // A Markdown-escaped underscore. \% and \& stay: bare, % starts a comment
    // (the rest of the formula vanished) and & is an alignment tab.
    .replace(/\\_/g, "_")
    // Commands a model wrote without their backslash - only where the word
    // can be nothing else. \left and \right need a delimiter after them: the
    // English words ("to the left") used to become commands, and KaTeX
    // refused the formula.
    .replace(/(^|[^\\A-Za-z])(left|right)(?=\s*(?:[()[\]|.]|\\[{}|]))/g, "$1\\$2")
    .replace(/(^|[^\\A-Za-z])(frac|sqrt|text|mathrm)(?=\s*[{[])/g, "$1\\$2")
    .replace(/(^|[^\\A-Za-z])sum(?=\s*[_^])/g, "$1\\sum")
    .replace(/(^|[^\\A-Za-z])(gamma|pi|theta|sigma|Delta|Sigma)\b/g, "$1\\$2")
    .replace(/\\times\s+\\times/g, "\\times");
  return restoreTextGroups(repaired, groups)
    .replace(/\\text\{\s*\\mathrm\{([^{}]+)\}\s*\}/g, "\\text{$1}")
    .replace(/\\mathrm\{\s*\\mathrm\{([^{}]+)\}\s*\}/g, "\\mathrm{$1}")
    .replace(/\\text\{\s+([^{}]+?)\s+\}/g, "\\text{$1}")
    .replace(/\\mathrm\{\s*([^{}]+?)\s*\}/g, "\\mathrm{$1}")
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
  // A span glued to a word - a unit's exponent (mm$^2$, kg/m$^3$), a
  // product (kN$\cdot$m), a subscript (A$_1$), a number run into its unit
  // ($10^3$kg) - is math too when it reads as LaTeX: a backslash, ^, _ or {.
  // The rule above leaves it as text, to keep a price like "$5 and $10" out
  // of math mode, and the page showed "mm$^2$" as typed (the owner,
  // 27 September 2026).
  next = next.replace(
    /(^|[^\\$])\$([^\n$]*?[\\^_{][^\n$]*?)\$/g,
    (_match, prefix: string, expression: string) => `${prefix}${addMath(expression, false)}`,
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
export function renderMarkdown(value: string, options: RenderOptions = {}) {
  try {
    // Doubly escaped line breaks are fixed here as well as when a result is
    // parsed, for results stored before the parsers learnt to (24 hours).
    const { protectedText, protectedChunks } = protectCodeSpans(
      normalizeMathMarkdown(sanitizeText(fixEscapedNewlines(value)), options),
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
