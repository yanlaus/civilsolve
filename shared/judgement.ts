// Answer cross-check types and parsing: two solvers answer independently and
// a third model judges both against the images. Pure string logic shared by
// the Worker (parsing the judge's response) and the client (rendering the
// verdict). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import { normalizeJsonCandidate, sanitizeText, type ParseOptions } from "./solution";

/** Which of the two solutions the judge found correct. */
export type Verdict = "a" | "b" | "both" | "neither";

export type Confidence = "high" | "medium" | "low";

export type JudgementResult = {
  verdict: Verdict;
  /** The judge's own verified final answer, with units - not a copy of either solution's. */
  final_answer: string;
  /** What solution A got right and, precisely, where it went wrong. */
  assessment_a: string;
  assessment_b: string;
  /** Where the two solutions differ and the decisive reason for the verdict. */
  comparison: string;
  confidence: Confidence;
};

export const VERDICTS: Verdict[] = ["a", "b", "both", "neither"];
export const CONFIDENCES: Confidence[] = ["high", "medium", "low"];

export const judgementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    final_answer: { type: "string" },
    assessment_a: { type: "string" },
    assessment_b: { type: "string" },
    comparison: { type: "string" },
    confidence: { type: "string", enum: CONFIDENCES },
  },
  required: ["verdict", "final_answer", "assessment_a", "assessment_b", "comparison", "confidence"],
} as const;

/**
 * Maps whatever the judge wrote in `verdict` onto the enum. Routes without a
 * schema (`structured: false`) send prose here: "Solution A", "A is correct",
 * "both correct", "neither / none". Returns null when nothing matches.
 */
export function readVerdict(value: string): Verdict | null {
  const text = value.trim().toLowerCase().replace(/[."'`]+$/, "");
  if ((VERDICTS as string[]).includes(text)) return text as Verdict;
  if (/\bneither\b|\bnone\b|\bboth (are |solutions are )?(wrong|incorrect)\b/.test(text)) return "neither";
  if (/\bboth\b/.test(text)) return "both";
  const a = /(^|\b(?:solution|solver|answer|only))\s*a\b/.test(text);
  const b = /(^|\b(?:solution|solver|answer|only))\s*b\b/.test(text);
  if (a !== b) return a ? "a" : "b";
  return null;
}

function readConfidence(value: string): Confidence {
  const text = value.trim().toLowerCase();
  if (text.startsWith("high")) return "high";
  if (text.startsWith("low")) return "low";
  return "medium";
}

export function parseJudgement(
  rawText: string,
  provider: ProviderKey,
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
      verdict: "neither",
      final_answer: "",
      assessment_a: "",
      assessment_b: "",
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

  const verdict = readVerdict(read("verdict"));
  const result: JudgementResult = {
    verdict: verdict ?? "neither",
    final_answer: read("final_answer") || read("answer"),
    assessment_a: read("assessment_a") || read("solution_a"),
    assessment_b: read("assessment_b") || read("solution_b"),
    comparison: read("comparison") || read("discrepancies") || read("reasoning"),
    confidence: readConfidence(read("confidence")),
  };

  // A verdict with no reasoning behind it is a judge that skipped its job;
  // with attempts left, ask again.
  if (!verdict && !options.allowIncomplete) {
    throw new Error(`${PROVIDER_LABELS[provider]} did not return a verdict.`);
  }
  if (!result.final_answer && !result.comparison && !result.assessment_a && !result.assessment_b) {
    throw new Error(`${PROVIDER_LABELS[provider]} returned a verdict with no assessment.`);
  }

  return result;
}
