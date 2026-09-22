// Answer cross-check types and parsing: the selected solvers answer
// independently and a judge grades every solution against the images. Pure
// string logic shared by the Worker (parsing the judge's response) and the
// client (rendering the verdict). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import { normalizeJsonCandidate, sanitizeText, type ParseOptions } from "./solution";

/** The judge sees solutions as letters, in the order they were sent. */
export const SOLUTION_LETTERS = ["A", "B", "C", "D"] as const;
export type SolutionLetter = (typeof SOLUTION_LETTERS)[number];

/** How many solutions one judge call compares. Bounded by the letters. */
export const MAX_JUDGED_SOLUTIONS = SOLUTION_LETTERS.length;

export type Confidence = "high" | "medium" | "low";

export type JudgementResult = {
  /** Zero-based indices of the solutions the judge found correct; empty for none. */
  correct: number[];
  /** The judge's own verified final answer, with units - not a copy of any solution's. */
  final_answer: string;
  /** One per solution, in order: what it got right and, precisely, where it went wrong. */
  assessments: string[];
  /** Where the solutions differ and the decisive reason for the verdict. */
  comparison: string;
  confidence: Confidence;
};

export const CONFIDENCES: Confidence[] = ["high", "medium", "low"];

export const judgementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    correct_solutions: {
      type: "array",
      items: { type: "string", enum: SOLUTION_LETTERS },
    },
    final_answer: { type: "string" },
    assessments: { type: "array", items: { type: "string" } },
    comparison: { type: "string" },
    confidence: { type: "string", enum: CONFIDENCES },
  },
  required: ["correct_solutions", "final_answer", "assessments", "comparison", "confidence"],
} as const;

/** Letter -> index, accepting "A", "a", "Solution A", "solver b", "1". */
function letterIndex(token: string, count: number): number | null {
  const text = token.trim().toLowerCase();
  const letter = /(?:^|\b(?:solution|solver|answer)\s*)([a-d])\b/.exec(text)?.[1];
  if (letter) {
    const index = letter.charCodeAt(0) - "a".charCodeAt(0);
    return index < count ? index : null;
  }
  const number = /^(?:solution|solver|answer)?\s*(\d)$/.exec(text)?.[1];
  if (number) {
    const index = Number(number) - 1;
    return index >= 0 && index < count ? index : null;
  }
  return null;
}

/**
 * Maps whatever the judge put in `correct_solutions` onto indices. Schema
 * routes send an array of letters; schema-less rungs send prose - "A",
 * "A and C", "both", "all", "none", "neither". Returns null when nothing
 * can be read, so the caller can retry rather than record a wrong verdict.
 */
export function readCorrect(value: unknown, count: number): number[] | null {
  // An empty array is a schema route saying "none", not a missing answer.
  if (Array.isArray(value) && value.length === 0) return [];
  const tokens: string[] = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : typeof value === "string"
      ? [value]
      : [];
  if (!tokens.length) return null;

  const joined = tokens.join(", ").toLowerCase();
  if (/\b(none|neither|no solution|nothing)\b/.test(joined)) return [];
  if (/\b(both|all|every)\b/.test(joined)) return Array.from({ length: count }, (_, i) => i);

  const found = new Set<number>();
  for (const token of tokens) {
    for (const part of token.split(/[,;&/]|\band\b/)) {
      const index = letterIndex(part, count);
      if (index !== null) found.add(index);
    }
  }
  if (!found.size && !/^[\s[\]"']*$/.test(joined)) return null;
  return [...found].sort((a, b) => a - b);
}

function readAssessments(value: unknown, count: number): string[] {
  const out: string[] = Array.from({ length: count }, () => "");
  if (Array.isArray(value)) {
    value.slice(0, count).forEach((entry, index) => {
      if (typeof entry === "string") out[index] = sanitizeText(entry);
    });
  } else if (value && typeof value === "object") {
    // {A: "...", B: "..."} or {solution_a: "..."} from a schema-less rung.
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const index = letterIndex(key.replace(/_/g, " "), count);
      if (index !== null && typeof entry === "string") out[index] = sanitizeText(entry);
    }
  }
  return out;
}

function readConfidence(value: string): Confidence {
  const text = value.trim().toLowerCase();
  if (text.startsWith("high")) return "high";
  if (text.startsWith("low")) return "low";
  return "medium";
}

/**
 * @param count how many solutions the judge was sent, so letters map back
 *   to the right solvers and the assessment list has one slot each.
 */
export function parseJudgement(
  rawText: string,
  provider: ProviderKey,
  count: number,
  options: ParseOptions = {},
): JudgementResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(rawText));
  } catch {
    // Same policy as the interpretation parser: prose means a cut-off or an
    // ignored instruction, and a retry is the better outcome while one is
    // left. On the last attempt the text is delivered as an undecided
    // verdict rather than thrown away.
    const text = sanitizeText(rawText);
    if (text.length < 20) {
      throw new Error(`${PROVIDER_LABELS[provider]} returned an empty verdict.`);
    }
    if (!options.allowIncomplete) {
      throw new Error(`${PROVIDER_LABELS[provider]} did not return a JSON verdict.`);
    }
    return {
      correct: [],
      final_answer: "",
      assessments: Array.from({ length: count }, () => ""),
      comparison: text,
      confidence: "low",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${PROVIDER_LABELS[provider]} returned an invalid verdict shape.`);
  }

  const record = parsed as Record<string, unknown>;
  const read = (key: string) =>
    typeof record[key] === "string" ? sanitizeText(record[key] as string) : "";

  const correct = readCorrect(record.correct_solutions ?? record.correct ?? record.verdict, count);
  const result: JudgementResult = {
    correct: correct ?? [],
    final_answer: read("final_answer") || read("answer"),
    assessments: readAssessments(record.assessments, count),
    comparison: read("comparison") || read("discrepancies") || read("reasoning"),
    confidence: readConfidence(read("confidence")),
  };

  // A verdict with no reasoning behind it is a judge that skipped its job;
  // with attempts left, ask again.
  if (!correct && !options.allowIncomplete) {
    throw new Error(`${PROVIDER_LABELS[provider]} did not say which solutions are correct.`);
  }
  if (!result.final_answer && !result.comparison && !result.assessments.some(Boolean)) {
    throw new Error(`${PROVIDER_LABELS[provider]} returned a verdict with no assessment.`);
  }

  return result;
}
