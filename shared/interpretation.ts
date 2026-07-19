// Diagram-interpretation pipeline types and parsing.
// Pure string logic shared by the Worker (parsing interpret/verify responses)
// and the client (rendering the review step). No DOM, no Workers APIs.

import {
  normalizeJsonCandidate,
  PROVIDER_LABELS,
  sanitizeText,
  type ProviderKey,
} from "./solution";

export type InterpretationResult = {
  interpreted_problem: string;
  diagram_description: string;
  given: string;
  required: string;
  // Verify stage only: differences between the two interpretations and how
  // they were resolved. Empty for the interpret stage.
  discrepancies: string;
};

export const interpretationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    interpreted_problem: { type: "string" },
    diagram_description: { type: "string" },
    given: { type: "string" },
    required: { type: "string" },
    discrepancies: { type: "string" },
  },
  required: [
    "interpreted_problem",
    "diagram_description",
    "given",
    "required",
    "discrepancies",
  ],
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

export function parseInterpretation(
  rawText: string,
  provider: ProviderKey,
): InterpretationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(rawText));
  } catch {
    // Non-JSON output still carries the interpretation as prose.
    const text = sanitizeText(rawText);
    if (text.length < 20) {
      throw new Error(`${PROVIDER_LABELS[provider]} returned an empty interpretation.`);
    }
    return {
      interpreted_problem: text,
      diagram_description: "",
      given: "",
      required: "",
      discrepancies: "",
    };
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${PROVIDER_LABELS[provider]} returned an invalid interpretation shape.`);
  }

  const record = parsed as Record<string, unknown>;
  const read = (key: string) =>
    typeof record[key] === "string" ? sanitizeText(record[key] as string) : "";

  const result: InterpretationResult = {
    interpreted_problem: read("interpreted_problem") || read("problem") || read("statement"),
    diagram_description: read("diagram_description") || read("diagram"),
    given: read("given"),
    required: read("required"),
    discrepancies: read("discrepancies"),
  };

  if (!result.interpreted_problem && !result.diagram_description) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} did not produce a usable interpretation.`,
    );
  }

  return result;
}
