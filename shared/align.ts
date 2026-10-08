// The answers compared with each other (9 October 2026, the owner's call):
// once every solver has answered, a model reads their final answers side by
// side and says how each lines up with the others - not whether any is
// right; that is the cross-check's job. It runs by itself, before any
// cross-check, as a task of its own (POST /api/align/:provider) that sends
// only the final answers as text, no images, so it is quick and light. It
// replaced a rule-based comparison of the numbers on the page, which kept
// going wrong on what a reader sees at once: working shown by one answer and
// not another, a resultant within 2% of a component, and directions written
// as a sign by one solver and in words by another.
//
// Pure string logic shared by the Worker (parsing the response) and the
// client (rendering the answer summary). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import { cleanModelText, normalizeJsonCandidate, stripThinkTags, type ParseOptions } from "./solution";

/** How one solution's final answers line up with the other solutions'. */
export type Alignment = "aligned" | "partial" | "not_aligned";

export const ALIGNMENTS: Alignment[] = ["aligned", "partial", "not_aligned"];

/** One per solution, in the order they were sent; null where the model left one out. */
export type AlignResult = {
  alignment: Array<Alignment | null>;
  /** In a few plain words, what differs from the others; "" for an aligned one. */
  notes: string[];
};

export const alignSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    alignment: { type: "array", items: { type: "string", enum: ALIGNMENTS } },
    alignment_notes: { type: "array", items: { type: "string" } },
  },
  required: ["alignment", "alignment_notes"],
} as const;

/** The answers are labelled A, B, C... in the order they are sent. */
export function alignLetter(index: number) {
  return String.fromCharCode(65 + index);
}

/** "A", "Solution b", "answer C", "1" -> its index, or null. */
function letterIndex(key: string, count: number): number | null {
  const text = key.trim().toLowerCase().replace(/_/g, " ");
  const letter = /(?:^|\b(?:solution|solver|answer)\s*)([a-z])\b/.exec(text)?.[1];
  if (letter) {
    const index = letter.charCodeAt(0) - 97;
    return index < count ? index : null;
  }
  const number = /^(?:solution|solver|answer)?\s*(\d+)$/.exec(text)?.[1];
  if (number) {
    const index = Number(number) - 1;
    return index >= 0 && index < count ? index : null;
  }
  return null;
}

/** An alignment as a model wrote it: the enum, or words on a schema-less rung ("partially aligned", "not aligned"). */
export function alignmentOf(value: unknown): Alignment | null {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return null;
  // "not aligned" before "aligned", "partially aligned" before "aligned".
  if (/\bnot\b|not_aligned|\bun-?aligned\b|\bmisaligned\b|\bdiffer|\bdisagree/.test(text)) return "not_aligned";
  if (/partial|partly|\bsome\b|\bmixed\b/.test(text)) return "partial";
  if (/aligned|\bagree|\bsame\b|\bmatch|\bconsistent/.test(text)) return "aligned";
  return null;
}

/** One entry per solution, from an array in order or an object keyed by letter. */
function readPerSolution<T>(value: unknown, count: number, read: (entry: unknown) => T, empty: T): T[] {
  const out: T[] = Array.from({ length: count }, () => empty);
  if (Array.isArray(value)) {
    value.slice(0, count).forEach((entry, index) => {
      out[index] = read(entry);
    });
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const index = letterIndex(key, count);
      if (index !== null) out[index] = read(entry);
    }
  }
  return out;
}

/**
 * @param count how many answers were sent, so each entry maps back to its
 *   solver. Prose, or JSON with no alignment in it, is retried while
 *   attempts are left; on the last one it gives an empty result rather than
 *   an error - the summary then simply shows no chips.
 */
export function parseAlign(
  rawText: string,
  provider: ProviderKey,
  count: number,
  options: ParseOptions = {},
): AlignResult {
  const empty: AlignResult = {
    alignment: Array.from({ length: count }, () => null),
    notes: Array.from({ length: count }, () => ""),
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(stripThinkTags(rawText)));
  } catch {
    if (!options.allowIncomplete) {
      throw new Error(`${PROVIDER_LABELS[provider]} did not return its comparison as JSON.`);
    }
    return empty;
  }
  let record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  // A wrapper: {"comparison": {...}}.
  if (!("alignment" in record) && !("alignments" in record)) {
    const inner = Object.values(record).find(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value) && "alignment" in (value as object),
    );
    if (inner) record = inner;
  }
  const alignment = readPerSolution(record.alignment ?? record.alignments, count, alignmentOf, null);
  const notes = readPerSolution(
    record.alignment_notes ?? record.notes ?? record.reasons,
    count,
    (entry) => (typeof entry === "string" ? cleanModelText(entry) : ""),
    "",
  );
  if (!alignment.some(Boolean) && !options.allowIncomplete) {
    throw new Error(`${PROVIDER_LABELS[provider]} did not say how the answers line up.`);
  }
  return { alignment, notes };
}
