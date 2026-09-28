// Solutions as PDF files, made on the server (29 September 2026, the owner's
// call: "Generate PDF" replaced the browser's print dialog, which on an
// iPhone was a trip through the share sheet). GET /api/pdf/:jobId renders
// the answer a job stored - a solution, or the verdict's verified final
// answer - with the same Markdown + KaTeX pipeline as the page
// (shared/markdown.ts), then Cloudflare's headless Chrome (Browser
// Rendering, the BROWSER binding) prints it to A4.
//
// Nothing new is stored: the answer is the job's, kept 24 hours, and the PDF
// is made again for anyone who opens the link, unless the edge cache still
// has it (custom domains only - the Cache API does nothing on workers.dev).
//
// Model output is untrusted. The HTML is built here and handed to the
// browser with setContent, never loaded from a URL: it is sanitized with
// HTMLRewriter, the page runs with JavaScript off, and every request but the
// KaTeX stylesheet and its fonts is refused - so the worst a hostile answer
// can do is change how its own PDF looks.
//
// Cost: Workers Paid includes 10 browser hours a month and bills US$0.09
// an hour beyond. PdfBudget counts the browser time each month and refuses
// past PDF_MONTHLY_MS, below the included hours, so this never bills.

import puppeteer from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import katex from "katex";
import type { JudgementResult } from "../shared/judgement";
import { renderMarkdownWith } from "../shared/markdown";
import type { ProviderArtifact } from "../shared/solution";

/** Browser time allowed per calendar month (UTC): 9 of the 10 included hours. */
export const PDF_MONTHLY_MS = 9 * 60 * 60 * 1000;

/** KaTeX's stylesheet and fonts, the one thing the page may fetch. */
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/`;

/**
 * Browser time used this month, in one Durable Object for the account. Each
 * PDF asks before it launches a browser and reports what it took after.
 */
export class PdfBudget extends DurableObject {
  private async usage() {
    const month = new Date().toISOString().slice(0, 7);
    const stored = await this.ctx.storage.get<{ month: string; ms: number }>("usage");
    return { month, ms: stored?.month === month ? stored.ms : 0 };
  }

  /** Whether another PDF fits in this month's allowance. */
  async allowed(): Promise<boolean> {
    return (await this.usage()).ms < PDF_MONTHLY_MS;
  }

  /** Adds one PDF's browser time; returns the month's total. */
  async add(ms: number): Promise<number> {
    const { month, ms: used } = await this.usage();
    const total = used + Math.max(0, Math.round(ms));
    await this.ctx.storage.put("usage", { month, ms: total });
    return total;
  }
}

/** What a PDF is made of: a solver's solution, or the verdict's verified answer. */
export type PdfContent =
  | { kind: "solution"; solution: ProviderArtifact }
  | { kind: "verdict"; judgement: JudgementResult };

/** The PDF a job's stored final event makes, if any. */
export function pdfContentOf(terminal: unknown): PdfContent | null {
  if (!terminal || typeof terminal !== "object") return null;
  const event = terminal as Record<string, unknown>;
  if (event.type !== "done") return null;
  const solution = event.solution as ProviderArtifact | undefined;
  if (solution && typeof solution === "object" && typeof solution.stepByStep === "string") {
    return { kind: "solution", solution };
  }
  const judgement = event.judgement as JudgementResult | undefined;
  if (judgement && typeof judgement === "object" && judgement.final_answer) {
    return { kind: "verdict", judgement };
  }
  return null;
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The PDF's title, which is also its file name. */
export function pdfTitle(content: PdfContent) {
  return content.kind === "solution" ? content.solution.title || "Solution" : "Verified final answer";
}

export function pdfFileName(content: PdfContent) {
  const slug = pdfTitle(content)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "solution"}.pdf`;
}

/**
 * Model-written HTML with everything that could run, load or submit taken
 * out: scripts, styles, frames, embeds, forms, images, links' targets and
 * every on* handler. KaTeX's own markup (spans, SVG, MathML, inline styles)
 * passes untouched.
 */
async function sanitizeHtml(html: string) {
  const removed =
    "script, style, link, meta, base, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, option, noscript, template, img, picture, source, video, audio, track, canvas";
  return new HTMLRewriter()
    .on(removed, {
      element: (element) => {
        element.remove();
      },
    })
    .on("*", {
      element: (element) => {
        for (const [name] of [...element.attributes]) {
          if (/^on/i.test(name) || /^(href|src|srcset|action|formaction|xlink:href|background|poster|ping)$/i.test(name)) {
            element.removeAttribute(name);
          }
        }
      },
    })
    .transform(new Response(html))
    .text();
}

// The printed look of the page's old Save as PDF (styles.css, @media print),
// written out: there is no Tailwind here.
const PDF_CSS = `
@page { size: A4; }
html, body { background: #fff; }
body { margin: 0; color: #000; font-family: "Helvetica Neue", Helvetica, Arial, "Noto Sans CJK TC", "Noto Sans TC", sans-serif; font-size: 11pt; line-height: 1.55; }
h1 { font-size: 16pt; line-height: 1.3; border-bottom: 1.5pt solid #000; padding-bottom: 4pt; margin: 0 0 10pt; }
h2 { font-size: 13pt; margin: 14pt 0 5pt; break-after: avoid; }
h3, h4, h5 { font-size: 11.5pt; margin: 10pt 0 4pt; break-after: avoid; }
p { margin: 5pt 0; }
ul, ol { margin: 5pt 0; padding-left: 18pt; }
li { margin: 2pt 0; break-inside: avoid; }
code, pre { font-family: Menlo, Consolas, "DejaVu Sans Mono", monospace; font-size: 0.92em; }
pre { white-space: pre-wrap; break-inside: avoid; }
table { border-collapse: collapse; margin: 6pt 0; break-inside: avoid; }
th, td { border: 0.5pt solid #999; padding: 3pt 6pt; text-align: left; }
hr { border: 0; border-top: 0.5pt solid #999; margin: 10pt 0; }
.katex { font-size: 1.05em; }
.katex-display { margin: 4pt 0; break-inside: avoid; }
/* Each displayed equation comes in a paragraph of its own: without this a
   run of them was spaced like paragraphs of text. */
p:has(> .katex-display) { margin: 2pt 0; }
`;

/** The whole document, sanitized, ready for the browser. */
export async function pdfDocument(content: PdfContent) {
  const render = (value: string) => renderMarkdownWith(value, {}, (html) => html);
  const sections =
    content.kind === "solution"
      ? [
          `<h1>${escapeHtml(pdfTitle(content))}</h1>`,
          "<h2>Interpreted Problem</h2>",
          render(content.solution.interpretedProblem),
          "<h2>Assumptions</h2>",
          render(content.solution.assumptions),
          "<h2>Solution</h2>",
          render(content.solution.stepByStep),
          "<h2>Final Answer</h2>",
          render(content.solution.finalAnswer),
        ]
      : ["<h1>Verified final answer</h1>", render(content.judgement.final_answer)];
  const body = await sanitizeHtml(sections.join("\n"));
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(pdfTitle(content))}</title>`,
    `<link rel="stylesheet" href="${KATEX_BASE}katex.min.css">`,
    `<style>${PDF_CSS}</style>`,
    `</head><body>${body}</body></html>`,
  ].join("\n");
}

/**
 * Prints `html` to an A4 PDF in a headless browser that runs no script and
 * fetches nothing but KaTeX. The browser is closed at once: its time is
 * what is billed.
 */
export async function printPdf(binding: Fetcher, html: string): Promise<Uint8Array> {
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(KATEX_BASE) || url.startsWith("data:")) void request.continue();
      else void request.abort();
    });
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 20_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: false,
      margin: { top: "16mm", right: "15mm", bottom: "18mm", left: "15mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#666;text-align:center;font-family:Helvetica,Arial,sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    return new Uint8Array(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}
