// Visualize 圖解 (19 October 2026, the owner's request): a finished solution
// drawn as a short deck of interactive boards, the way Kimi's 可视题解
// (visual-solution.app.kimi.com) does it. Each board is a chunk of HTML a
// model wrote - SVG, canvas, KaTeX, an animation, a slider - which the page
// runs inside a sandboxed iframe (src/lib/board-document.ts) and nowhere else.
//
// Two models draw, both on the OpenCode Go subscription (the owner's calls):
// Muse Spark, the default since 21 October 2026, and DeepSeek V4.1 Flash,
// the only one from 19 October. Each route is pinned (VISUAL_ROUTES in
// worker/channels.ts), whatever the provider's own channel or model var says.
//
// The boards come back as plain text between markers, not as JSON. HTML and
// JavaScript inside a JSON string need a second layer of escaping that models
// get wrong now and then, and the repairs every other parser runs
// (cleanModelText: fixEscapedNewlines, restoreSwallowedCommands) would turn a
// script's "\n" into a real line break and a tab before "t" into a LaTeX
// command. The HTML here is kept exactly as written.
//
// Pure string logic shared by the Worker (parsing the response, merging a
// fixed board) and the client (rendering). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import { stripThinkTags } from "./solution";

export type VisualBoard = {
  /** A few words, shown above the board. */
  title: string;
  /** The title in Traditional Chinese. */
  title_zh: string;
  /** One line on what to look at or do. */
  note: string;
  note_zh: string;
  /** Everything on the board, run as it is inside the sandboxed frame. */
  html: string;
};

export type VisualResult = { boards: VisualBoard[] };

/** The models that draw, the default first. */
export const VISUAL_PROVIDERS = ["muse", "deepseek"] as const satisfies readonly ProviderKey[];

export type VisualProvider = (typeof VISUAL_PROVIDERS)[number];

export const DEFAULT_VISUAL_PROVIDER: VisualProvider = "muse";

export function isVisualProvider(value: unknown): value is VisualProvider {
  return (VISUAL_PROVIDERS as readonly unknown[]).includes(value);
}

/** Each model as its picker and the deck's byline name it. */
export const VISUAL_MODELS: Record<VisualProvider, { name: string; label: string }> = {
  muse: { name: "Muse Spark", label: "Muse Spark · OpenCode Go" },
  deepseek: { name: "DeepSeek", label: "DeepSeek V4.1 Flash · OpenCode Go" },
};

export const MAX_BOARDS = 4;
/** A board's HTML, in characters: the prompt asks for 4,000 to 10,000. */
export const MAX_BOARD_HTML = 40_000;
const MAX_LABEL = 200;

export const BOARD_MARK = "<<<BOARD>>>";
export const HTML_MARK = "<<<HTML>>>";
export const END_MARK = "<<<END>>>";

/** A request to redraw one board: which, why, and the deck it belongs to. */
export type VisualFix = {
  /** The board to redraw, counting from 0. */
  board: number;
  /** What to change: the student's words, or the errors the page caught. */
  instructions: string;
  /** The whole deck as it is, so the job can store it whole with the new board in. */
  boards: VisualBoard[];
};

export type VisualParseOptions = {
  /** The last attempt: deliver what can be salvaged rather than throw. */
  allowIncomplete?: boolean;
};

const LABEL_LINE = /^\s*[-*]?\s*\**\s*(title_zh|title|note_zh|note)\s*\**\s*[:：]\s*(.*)$/i;

function label(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

/** A board's HTML without the Markdown fence a model may put round it. */
function unfence(html: string) {
  return html
    .replace(/^\s*```[a-z]*[ \t]*\n/i, "")
    .replace(/\n```\s*$/, "")
    .trim();
}

function readHeader(header: string) {
  const out = { title: "", title_zh: "", note: "", note_zh: "" };
  for (const line of header.split("\n")) {
    const match = LABEL_LINE.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase() as keyof typeof out;
    if (!out[key]) out[key] = label(match[2]);
  }
  return out;
}

/**
 * The boards in a response, in order. A board with no end marker was cut
 * off with the response and is dropped - half a script does not run. So is
 * one with no HTML, or more HTML than MAX_BOARD_HTML.
 */
export function parseVisual(
  rawText: string,
  provider: ProviderKey,
  options: VisualParseOptions = {},
): VisualResult {
  const name = PROVIDER_LABELS[provider];
  const text = stripThinkTags(rawText.replace(/\r\n?/g, "\n"));
  const chunks = text.split(BOARD_MARK).slice(1);
  const boards: VisualBoard[] = [];
  let cut = false;
  for (const chunk of chunks) {
    const htmlAt = chunk.indexOf(HTML_MARK);
    const endAt = chunk.indexOf(END_MARK);
    if (htmlAt < 0 || endAt < 0 || endAt < htmlAt) {
      cut = true;
      continue;
    }
    const html = unfence(chunk.slice(htmlAt + HTML_MARK.length, endAt));
    if (!html || html.length > MAX_BOARD_HTML) continue;
    const header = readHeader(chunk.slice(0, htmlAt));
    boards.push({ ...header, title: header.title || `Board ${boards.length + 1}`, html });
    if (boards.length === MAX_BOARDS) break;
  }
  if (boards.length) return { boards };

  // The format ignored: one HTML document and nothing else. Worth retrying
  // while an attempt is left; on the last one it is better than nothing.
  const bare = unfence(text.replace(/<<<[A-Z]+>>>/g, ""));
  if (options.allowIncomplete && /<(svg|canvas|div|script|style)\b/i.test(bare) && bare.length <= MAX_BOARD_HTML) {
    return { boards: [{ title: "Board 1", title_zh: "", note: "", note_zh: "", html: bare }] };
  }
  if (cut) throw new Error(`${name} was cut off before it finished its first board.`);
  throw new Error(`${name} returned no boards.`);
}

/** The deck with board `index` replaced. */
export function mergeFixedBoard(boards: VisualBoard[], index: number, board: VisualBoard): VisualBoard[] {
  return boards.map((entry, at) => (at === index ? board : entry));
}

function isText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

/**
 * Boards as a browser sent them back (a fix's deck) or a store kept them,
 * checked field by field. Null when anything does not fit.
 */
export function readBoards(value: unknown): VisualBoard[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BOARDS) return null;
  const boards: VisualBoard[] = [];
  for (const entry of value) {
    const record = (entry ?? {}) as Record<string, unknown>;
    if (
      !isText(record.title, MAX_LABEL) ||
      !isText(record.title_zh, MAX_LABEL) ||
      !isText(record.note, MAX_LABEL) ||
      !isText(record.note_zh, MAX_LABEL) ||
      !isText(record.html, MAX_BOARD_HTML) ||
      !record.html.trim()
    ) {
      return null;
    }
    boards.push({
      title: record.title,
      title_zh: record.title_zh,
      note: record.note,
      note_zh: record.note_zh,
      html: record.html,
    });
  }
  return boards;
}
