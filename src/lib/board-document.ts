// The document a Visualize board runs in (shared/visual.ts): the model's HTML
// wrapped in a page of ours, loaded as the srcdoc of an iframe sandboxed with
// "allow-scripts" only (components/solve/board-viewer.tsx).
//
// Board HTML is model output, and model output is untrusted (AGENTS.md): it
// may follow instructions planted in an uploaded image. So it runs here and
// nowhere else, and the wrapper decides what it may do before a line of it
// runs:
//
// - The sandbox, without allow-same-origin, gives the frame an opaque origin:
//   it cannot read the page's localStorage (the job ids), its IndexedDB (the
//   history and the uploads) or its cookies, and it may not open windows,
//   submit forms, show dialogs or navigate the page.
// - The Content-Security-Policy, the first thing in <head>, lets scripts,
//   styles and fonts come from cdn.jsdelivr.net (and Google Fonts) alone and
//   lets nothing else out: no fetch, XHR or WebSocket, no image from a URL, no
//   nested frame. A policy can only be tightened after it is set, never
//   loosened, so the board cannot undo it.
// - The bridge, the next thing in <head>, runs before the board does and
//   reports back what the student cannot see and the model never could: script
//   errors with the line in the board's own HTML, resources that did not load,
//   what the policy blocked, content wider than the frame, a board left empty.
//   Kimi's 可视题解 does the same (its board.js); the reports are what "Fix
//   this board" sends back to the model.
//
// Pure string building, apart from readPalette.

/** The page's colours a board draws with, as CSS variables on its :root. */
export type BoardPalette = Record<"ink" | "ink-2" | "line" | "surface" | "accent", string>;

/** Classic's colours, for when the page's cannot be read. */
export const DEFAULT_PALETTE: BoardPalette = {
  ink: "#1b1610",
  "ink-2": "#5c5347",
  line: "#d4cdc3",
  surface: "#ffffff",
  accent: "#b35c1e",
};

/** The page's current theme colours (the cs-* tokens in styles.css). */
export function readPalette(): BoardPalette {
  if (typeof document === "undefined") return DEFAULT_PALETTE;
  const style = getComputedStyle(document.documentElement);
  const read = (name: keyof BoardPalette) => style.getPropertyValue(`--cs-${name}`).trim() || DEFAULT_PALETTE[name];
  return { ink: read("ink"), "ink-2": read("ink-2"), line: read("line"), surface: read("surface"), accent: read("accent") };
}

export const BOARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src https://cdn.jsdelivr.net https://fonts.gstatic.com data:",
  "img-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Messages from a board carry this, so nothing else posting to the page is read as one. */
export const BOARD_MESSAGE = "civilsolve-board";

export type BoardReport =
  | { type: "error"; text: string }
  | { type: "resource"; text: string }
  | { type: "blocked"; text: string }
  | { type: "size"; ready: boolean; height: number; width: number; overflowX: number; empty: boolean };

/** A report as it arrives: from a board, of a given load. */
export type BoardMessage = BoardReport & { from: typeof BOARD_MESSAGE; generation: number };

export function isBoardMessage(value: unknown): value is BoardMessage {
  const record = value as Record<string, unknown> | null;
  return Boolean(record) && record?.from === BOARD_MESSAGE && typeof record?.generation === "number" && typeof record?.type === "string";
}

// Runs in the frame's <head>, before anything the board wrote: a script that
// throws on its first line does so before a listener further down would
// exist. GENERATION tells this load's reports from a replaced one's;
// HEAD_LINES turns a line of the document into a line of the board's HTML.
const BRIDGE = `
var post = function (m) { m.from = "${BOARD_MESSAGE}"; m.generation = GENERATION; try { parent.postMessage(m, "*"); } catch (e) {} };
addEventListener("error", function (e) {
  var el = e.target;
  if (el && el !== window && el.tagName) {
    post({ type: "resource", text: el.tagName.toLowerCase() + " did not load: " + (el.src || el.href || "") });
    return;
  }
  post({ type: "error", text: (e.message || "Script error") + (e.lineno > HEAD_LINES ? " (line " + (e.lineno - HEAD_LINES) + " of the board's HTML)" : "") });
}, true);
addEventListener("unhandledrejection", function (e) {
  var r = e.reason;
  post({ type: "error", text: "Unhandled promise rejection: " + ((r && r.message) || r) });
});
document.addEventListener("securitypolicyviolation", function (e) {
  post({ type: "blocked", text: (e.effectiveDirective || e.violatedDirective) + " blocked " + (e.blockedURI || "an inline resource") });
});
var consoleError = console.error;
console.error = function () {
  post({ type: "error", text: Array.prototype.map.call(arguments, String).join(" ") });
  return consoleError.apply(console, arguments);
};
// A drawing is never shown larger than its viewBox: at most one pixel per
// unit, centred, smaller where the column is narrower (24 October 2026, the
// owner: its labels came out too large - a 520-unit diagram with 16-unit
// labels filled a 700 px column at 1.35 times, its labels over its arrows).
// Not an SVG nested in another, which follows its parent, nor an icon.
var fit = function () {
  var svgs = document.querySelectorAll("svg[viewBox]");
  for (var i = 0; i < svgs.length; i++) {
    var svg = svgs[i];
    if (svg.ownerSVGElement || svg.getAttribute("data-fitted")) continue;
    var box = svg.viewBox && svg.viewBox.baseVal;
    if (!box || box.width < 160) continue;
    svg.setAttribute("data-fitted", "1");
    if (!svg.style.maxWidth) svg.style.maxWidth = box.width + "px";
    if (getComputedStyle(svg).display === "block" && !svg.style.marginLeft && !svg.style.marginRight) {
      svg.style.marginLeft = "auto";
      svg.style.marginRight = "auto";
    }
  }
};
var measure = function (ready) {
  var body = document.body;
  if (!body) return;
  fit();
  var d = document.documentElement;
  // Measured as the board lays out with no scrollbar: a drawing that scales
  // with its width is taller at full width, so a height measured beside a
  // scrollbar is a few pixels short, and the scrollbar it was measured
  // beside never goes away (a 10 kN beam board on 19 October 2026: 579 px
  // beside one, more without).
  var overflowY = d.style.overflowY;
  d.style.overflowY = "hidden";
  var bottom = 0, drew = false;
  var nodes = body.querySelectorAll("*");
  for (var i = 0; i < nodes.length; i++) {
    var r = nodes[i].getBoundingClientRect();
    if (r.width > 2 && r.height > 2) drew = true;
    if (nodes[i].parentElement === body && getComputedStyle(nodes[i]).position !== "fixed") bottom = Math.max(bottom, r.bottom + scrollY);
  }
  // Overflowing the frame: grow to all of it. Otherwise the content's own
  // height, so a board that got shorter lets the frame shrink.
  var height = d.scrollHeight - d.clientHeight > 1 ? d.scrollHeight : Math.ceil(bottom);
  var size = { type: "size", ready: !!ready, height: height, width: d.clientWidth,
    overflowX: Math.max(d.scrollWidth - d.clientWidth, body.scrollWidth - body.clientWidth),
    empty: !drew && !body.textContent.trim() };
  d.style.overflowY = overflowY;
  post(size);
};
addEventListener("DOMContentLoaded", function () {
  measure(false);
  var watch = new ResizeObserver(function () { measure(document.readyState === "complete"); });
  watch.observe(document.body);
  watch.observe(document.documentElement);
});
addEventListener("load", function () { measure(true); });
setTimeout(function () { measure(true); }, 2500);
`;

/**
 * The frame's whole document: policy, colours, bridge, then the board's HTML
 * as the model wrote it.
 */
export function boardDocument(html: string, { generation, palette = DEFAULT_PALETTE }: { generation: number; palette?: BoardPalette }) {
  const colours = (Object.keys(palette) as Array<keyof BoardPalette>)
    .map((name) => `--${name}:${palette[name].replace(/[;<>{}]/g, "")}`)
    .join(";");
  // SVG text gets a halo of the background (24 October 2026), so a label that
  // crosses a line or an arrow still reads; at no specificity, so a board's
  // own styles win.
  const before = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${BOARD_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root{${colours};color-scheme:light}html,body{margin:0;background:transparent}body{color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:break-word}:where(svg text){paint-order:stroke;stroke:var(--surface);stroke-width:3px;stroke-linejoin:round}</style>`,
    `<script>var GENERATION = ${Math.floor(generation)}; var HEAD_LINES = __HEAD_LINES__;${BRIDGE}</script>`,
    "</head>",
    "<body>",
    "",
  ].join("\n");
  // Counted, not guessed: the board's first line has to report as line 1.
  const headLines = before.split("\n").length - 1;
  return `${before.replace("__HEAD_LINES__", String(headLines))}${html}\n</body>\n</html>`;
}

/**
 * A board's reports, in words, without repeats: what the page shows under it
 * and what "Fix this board" sends back. Facts only - whether the picture is
 * any good is the student's call. A frame not yet measured is not reported as
 * empty: the first measurement arrives mid-layout.
 */
export function readBoardReports(reports: BoardReport[]): string[] {
  const out: string[] = [];
  for (const report of reports) {
    if (report.type === "error") out.push(`Script error: ${report.text}`);
    if (report.type === "resource") out.push(`A resource did not load: ${report.text.replace(/^\w+ did not load: /, "")}`);
    if (report.type === "blocked") out.push(`The sandbox blocked it: ${report.text}`);
    if (report.type === "size" && report.width > 60) {
      if (report.empty && report.ready) out.push("The board came out empty - nothing on it has a size.");
      else if (report.overflowX > 12) out.push(`The board is ${Math.round(report.overflowX)} px wider than its frame - its right edge is cut off.`);
    }
  }
  return [...new Set(out)];
}
