// Diagram-interpretation pipeline types and parsing.
// Pure string logic shared by the Worker (parsing interpret/verify responses)
// and the client (rendering the review step). No DOM, no Workers APIs.

import { PROVIDER_LABELS, type ProviderKey } from "./providers";
import {
  normalizeJsonCandidate,
  sanitizeText,
  stripThinkTags,
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
  options: ParseOptions = {},
): InterpretationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonCandidate(rawText));
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
      throw new Error(`${PROVIDER_LABELS[provider]} returned an empty interpretation.`);
    }
    if (!options.allowIncomplete) {
      throw new Error(`${PROVIDER_LABELS[provider]} did not return a JSON interpretation.`);
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

  // A reading with neither the givens nor the ask is a reader that skipped
  // its job (seen once on gemini-3.8-flash: statement and diagram filled,
  // `given` and `required` empty). With attempts left, ask again.
  if (!options.allowIncomplete && !result.given && !result.required) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} returned an interpretation with no given quantities and nothing required.`,
    );
  }

  return result;
}
