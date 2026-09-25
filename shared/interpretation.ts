// Diagram-interpretation pipeline types and parsing.
// Pure string logic shared by the Worker (parsing interpret/verify responses)
// and the client (rendering the review step). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import {
  normalizeJsonCandidate,
  sanitizeText,
  stripThinkTags,
  textOf,
  type ParseOptions,
} from "./solution";

export type InterpretationResult = {
  interpreted_problem: string;
  diagram_description: string;
  given: string;
  required: string;
  // Verify stage only: differences between the two interpretations and how
  // they were resolved. Empty for the interpret stage.
  discrepancies: string;
  /**
   * Verify stage only: the whole reconciled reading in Traditional Chinese,
   * shown beside the English for the user to check against. Display only -
   * the solvers are given the English. Empty for the interpret stage.
   */
  traditional_chinese: string;
};

const READING_PROPERTIES = {
  interpreted_problem: { type: "string" },
  diagram_description: { type: "string" },
  given: { type: "string" },
  required: { type: "string" },
  discrepancies: { type: "string" },
} as const;

/** What a reader returns. */
export const interpretationSchema = {
  type: "object",
  additionalProperties: false,
  properties: READING_PROPERTIES,
  required: Object.keys(READING_PROPERTIES),
} as const;

/** What the reconciler returns: a reading plus its Traditional Chinese version. */
export const verifiedInterpretationSchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...READING_PROPERTIES, traditional_chinese: { type: "string" } },
  required: [...Object.keys(READING_PROPERTIES), "traditional_chinese"],
} as const;

/**
 * Flattens an InterpretationResult into the single problem-statement text
 * that is shown for review and later attached to solve requests.
 */
export function interpretationToText(result: InterpretationResult) {
  return [
    result.interpreted_problem,
    result.diagram_description ? `Diagram: ${result.diagram_description}` : "",
    result.given ? `Given: ${result.given}` : "",
    result.required ? `Required: ${result.required}` : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/**
 * Where each field may turn up. Readers held to a strict schema use the first
 * name; the ones that are not - Kimi (`structured: false`) and DeepSeek,
 * whose gateway refuses strict schemas - write the same content under names
 * of their own, and as arrays or objects rather than strings.
 */
const FIELD_KEYS: Record<keyof InterpretationResult, string[]> = {
  interpreted_problem: [
    "interpreted_problem",
    "interpretedProblem",
    "problem_statement",
    "problem",
    "statement",
    "question",
    "restated_problem",
    "summary",
  ],
  diagram_description: [
    "diagram_description",
    "diagramDescription",
    "diagram",
    "figure",
    "figure_description",
    "diagram_details",
  ],
  given: ["given", "given_quantities", "givens", "given_data", "given_information", "known", "knowns", "data"],
  required: ["required", "required_quantities", "find", "to_find", "asked", "unknowns", "requirements"],
  discrepancies: ["discrepancies", "disagreements", "differences", "resolution"],
  traditional_chinese: ["traditional_chinese", "chinese", "zh_hant", "zh", "translation"],
};

const PART_KEYS = ["problems", "parts", "questions", "sub_questions"];

function readField(record: Record<string, unknown>, field: keyof InterpretationResult) {
  for (const key of FIELD_KEYS[field]) {
    const text = textOf(record[key]);
    if (text) return text;
  }
  return "";
}

function hasAnyField(record: Record<string, unknown>) {
  return Object.values(FIELD_KEYS).some((keys) => keys.some((key) => key in record));
}

/**
 * The object that holds the reading: the top level, or what a model wrapped
 * it in - `{"interpretation": {...}}`, `{"civil_interpretation": {...}}`.
 */
function unwrap(record: Record<string, unknown>): Record<string, unknown> {
  if (hasAnyField(record) || PART_KEYS.some((key) => Array.isArray(record[key]))) return record;
  const objects = Object.values(record).filter(
    (value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
  );
  return objects.length === 1 ? unwrap(objects[0]) : record;
}

/** Reads the fields, merging a per-part array (`problems: [...]`) part by part. */
function readReading(record: Record<string, unknown>): InterpretationResult {
  const parts = PART_KEYS.map((key) => record[key]).find(
    (value): value is unknown[] => Array.isArray(value) && value.length > 0,
  );
  const result = {} as InterpretationResult;
  for (const field of Object.keys(FIELD_KEYS) as Array<keyof InterpretationResult>) {
    const top = readField(record, field);
    const perPart = parts
      ? parts
          .map((part, index) => {
            if (!part || typeof part !== "object") return "";
            const text = readField(part as Record<string, unknown>, field);
            return text ? `Part ${index + 1}: ${text}` : "";
          })
          .filter(Boolean)
          .join("\n\n")
      : "";
    result[field] = sanitizeText([top, perPart].filter(Boolean).join("\n\n"));
  }
  return result;
}

export function parseInterpretation(
  rawText: string,
  provider: ProviderKey,
  options: ParseOptions = {},
): InterpretationResult {
  const label = PROVIDER_LABELS[provider];
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(stripThinkTags(rawText)));
  } catch {
    // Non-JSON output. The readers are told to return JSON and, on Google
    // and Poe, are held to a schema - so prose here means the response was
    // cut off or the model ignored its instructions, and a retry (or the
    // next model in the chain) is the better outcome. Only on the last
    // attempt is the text worth delivering as the reading. Measured on
    // gemini-3.8-flash: a 313-character JSON fragment landed here whole,
    // in interpreted_problem, with every other field empty.
    const text = stripThinkTags(sanitizeText(rawText));
    if (text.length < 20) {
      throw new Error(`${label} returned an empty reading.`);
    }
    if (!options.allowIncomplete) {
      throw new Error(`${label} did not return its reading as JSON.`);
    }
    return {
      interpreted_problem: text,
      diagram_description: "",
      given: "",
      required: "",
      discrepancies: "",
      traditional_chinese: "",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${label} returned an invalid interpretation shape.`);
  }

  const record = unwrap(parsed as Record<string, unknown>);
  const result = readReading(record);

  if (!result.interpreted_problem && !result.diagram_description) {
    // Something came back, just not under any name above. On the last
    // attempt that is still worth reading - all of it, as the statement -
    // rather than an error in its place.
    const everything = sanitizeText(textOf(record));
    if (options.allowIncomplete && everything.length >= 40) {
      return { ...result, interpreted_problem: everything };
    }
    // Every field there and every one empty: a blank template, seen on
    // DeepSeek and Kimi under a strict schema (25 September 2026).
    if (hasAnyField(record) && !everything) {
      throw new Error(`${label} returned a blank reading - every field empty.`);
    }
    const keys = Object.keys(record).slice(0, 6).join(", ") || "nothing";
    throw new Error(
      `${label} returned a reading with no problem statement or diagram description (fields: ${keys}).`,
    );
  }

  // A reading with neither the givens nor the ask is a reader that skipped
  // its job (seen once on gemini-3.8-flash: statement and diagram filled,
  // `given` and `required` empty). With attempts left, ask again.
  if (!options.allowIncomplete && !result.given && !result.required) {
    throw new Error(`${label} listed no given quantities and nothing required.`);
  }

  return result;
}
