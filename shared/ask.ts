// "Ask about this step · 問呢一步" (3 October 2026): a student's question
// about one finished solution - a step they did not follow, why a term is
// there - answered by a model that has the question, the solution and the
// earlier questions about it. It explains; it does not write the solution
// again. The answer is in the language of the question.
//
// Pure string logic shared by the Worker (parsing the response) and the
// client (rendering it). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import {
  cleanModelText,
  normalizeJsonCandidate,
  sanitizeText,
  stripThinkTags,
  textOf,
  type ParseOptions,
} from "./solution";

export type AskResult = {
  /** The answer: Markdown with `$...$` LaTeX, in the language of the question. */
  answer: string;
};

export const askSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
} as const;

export const ASK_FIELDS = ["answer"] as const;

const ANSWER_KEYS = ["answer", "response", "reply", "explanation", "content", "text"];

/** The object holding the answer, or the one a model wrapped it in. */
function unwrap(record: Record<string, unknown>): Record<string, unknown> {
  if (ANSWER_KEYS.some((key) => key in record)) return record;
  const objects = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  return objects.length === 1 ? unwrap(objects[0]) : record;
}

export function parseAsk(rawText: string, provider: ProviderKey, options: ParseOptions = {}): AskResult {
  const label = PROVIDER_LABELS[provider];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(rawText));
  } catch {
    // Same policy as the other parsers: prose is retried while an attempt is
    // left, and delivered as the answer on the last one.
    const text = stripThinkTags(sanitizeText(rawText));
    if (text.length < 2) throw new Error(`${label} returned an empty answer.`);
    if (!options.allowIncomplete) throw new Error(`${label} did not return its answer as JSON.`);
    return { answer: cleanModelText(text) };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (typeof parsed === "string" && parsed.trim()) return { answer: cleanModelText(parsed) };
    throw new Error(`${label} returned an answer in an invalid shape.`);
  }
  const record = unwrap(parsed as Record<string, unknown>);
  for (const key of ANSWER_KEYS) {
    const answer = cleanModelText(textOf(record[key]));
    if (answer) return { answer };
  }
  throw new Error(`${label} returned no answer.`);
}
