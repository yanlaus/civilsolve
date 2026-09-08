// Prompts shared by the Worker. The assignment arrives as attached images
// (native vision input), so there are no OCR text sections.
//
// Two tasks live here: solving, and the optional interpret/verify pass that
// reads the diagram first and pauses for the user to confirm.

export type EffortKey = "none" | "low" | "medium" | "high" | "max";

export const EFFORT_KEYS: EffortKey[] = ["none", "low", "medium", "high", "max"];

export function isEffortKey(value: string): value is EffortKey {
  return (EFFORT_KEYS as string[]).includes(value);
}

export const SOLVE_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Use English for every user-facing field unless the user explicitly requests another language.";

export const INTERPRET_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Do NOT solve the problem — only interpret it. Use English.";

/**
 * Spelled-out shape contract, appended only when the channel cannot enforce a
 * schema itself. Without it a model is free to invent its own envelope, and
 * they do: `{problems:[...]}`, `{assignment_title, problems}`, and a bare
 * object all show up across runs of the same prompt.
 */
function shapeContract(fields: readonly string[]) {
  const skeleton = `{${fields.map((field) => `"${field}": ""`).join(", ")}}`;
  return [
    "",
    `Return exactly one JSON object with these ${fields.length} fields, all strings:`,
    skeleton,
    "Do not add other fields. Do not nest this object inside another object or array.",
  ];
}

const SOLUTION_FIELDS = [
  "title",
  "interpreted_problem",
  "assumptions",
  "step_by_step",
  "final_answer",
  "latex_body",
] as const;

const INTERPRETATION_FIELDS = [
  "interpreted_problem",
  "diagram_description",
  "given",
  "required",
  "discrepancies",
] as const;

export type TutorPromptExtras = {
  /** Human-confirmed problem statement from the interpretation pipeline. */
  interpretation?: string;
  /** Text extracted from uploaded lecture notes. */
  referenceText?: string;
  /** Whether lecture-notes images are attached after the assignment images. */
  hasReferenceImages?: boolean;
  /** Append the literal field list, for channels that cannot enforce a schema. */
  enforceShape?: boolean;
};

export function buildTutorPrompt(
  userNotes: string,
  effort: EffortKey,
  extras: TutorPromptExtras = {},
) {
  const sections = [
    "Analyze the attached civil engineering assignment images and solve every identifiable problem.",
    "The assignment is provided as attached images. Read them directly, including diagrams, tables, and handwriting.",
    "Use a student-facing tone and keep the work clean and direct.",
    "Default response language: English. Return all user-facing fields in English unless the user explicitly asks for another language in the notes.",
    "Translate any non-English text in the images into English before writing the solution.",
    `Requested thinking effort: ${effort}.`,
    "Return JSON that matches the required schema exactly.",
    "For `latex_body`, return only LaTeX content that belongs inside the document body.",
    "Do not include markdown fences or commentary outside the JSON fields.",
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  ];

  if (extras.interpretation) {
    sections.push(
      "",
      "Confirmed problem interpretation (cross-checked by two readers and reviewed by the user):",
      extras.interpretation,
      "Treat this interpretation as the authoritative reading of the problem — especially the diagram geometry, support conditions, load magnitudes and positions, and units. If the images appear to conflict with it, follow the interpretation.",
    );
  }

  if (extras.referenceText || extras.hasReferenceImages) {
    sections.push(
      "",
      "Lecture notes are provided for method reference. Follow the solution methods, notation, sign conventions, formulas, and presentation style taught in these notes wherever they apply. When multiple valid methods exist, prefer the taught method over alternatives, and mirror how the worked examples in the notes structure their solutions.",
    );
    if (extras.referenceText) {
      sections.push("", "Lecture notes (extracted text):", extras.referenceText);
    }
    if (extras.hasReferenceImages) {
      sections.push(
        "",
        "Additional lecture-notes pages are attached as images AFTER the assignment images, introduced by a marker. They are reference material only — do not solve anything that appears in them.",
      );
    }
  }

  sections.push(
    "",
    "For each problem, make sure the solution includes:",
    "- Given information with symbols and units",
    "- Required quantity",
    "- Formula -> substitution -> result",
    "- Final answer with units",
    "",
    "For web-facing text fields (`interpreted_problem`, `assumptions`, `step_by_step`, and `final_answer`), format formulas with Markdown math delimiters:",
    "- Use `$...$` for short inline symbols and equations.",
    "- Use `$$...$$` for displayed equations, substitutions, and final calculated expressions.",
    "- Do not leave formulas as plain text when they contain symbols, subscripts, superscripts, fractions, or unit calculations.",
    "- Do not use CJK prose such as 代入, 結果, 已知, or 所求 unless the user explicitly requests a Chinese answer.",
  );

  if (extras.enforceShape) {
    sections.push(
      ...shapeContract(SOLUTION_FIELDS),
      "If the assignment contains several problems, cover all of them inside these same six fields.",
    );
  }

  return sections.join("\n");
}

export function buildInterpretPrompt(
  userNotes: string,
  options?: { enforceShape?: boolean },
) {
  const sections = [
    "You are reading a civil engineering assignment provided as attached images. Your ONLY job is to interpret the question precisely — do NOT solve it.",
    "Diagrams are where automated readers make mistakes, so describe every diagram element explicitly and carefully:",
    "- Overall geometry: member lengths, spans, angles, cross-section dimensions, coordinates — with units.",
    "- Supports and connections: type (pin, roller, fixed, hinge...), location, and orientation.",
    "- Loads: every point load, distributed load, moment, and pressure — magnitude, direction, position, and extent.",
    "- Axes, labeled points, symbols, and any values given in tables or text.",
    "- Material or section properties if stated (E, I, A, dimensions...).",
    "State the problem in your own words, list all given quantities with symbols and units, and state exactly what is being asked.",
    "If any part of the image is ambiguous or unreadable, say so explicitly in the relevant field rather than guessing silently.",
    "Set the `discrepancies` field to an empty string.",
    "Return JSON matching the required schema exactly.",
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  ];

  if (options?.enforceShape) {
    sections.push(...shapeContract(INTERPRETATION_FIELDS));
  }

  return sections.join("\n");
}

export function buildVerifyPrompt(
  userNotes: string,
  interpretationA: string,
  interpretationB: string,
  options?: { enforceShape?: boolean },
) {
  const sections = [
    "Two independent readers interpreted the attached civil engineering assignment images. Your job is to produce ONE corrected, authoritative interpretation — do NOT solve the problem.",
    "Compare the two interpretations below against each other AND against the attached images:",
    "- Where they agree, keep the shared reading.",
    "- Where they disagree, re-inspect the images yourself and adjudicate. Diagram geometry, support types, load magnitudes/positions, and units deserve the closest scrutiny.",
    "- If both interpretations missed or misread something visible in the images, correct it.",
    "In the `discrepancies` field, list every disagreement you found and how you resolved it (or state that the interpretations agreed).",
    "Return JSON matching the required schema exactly.",
    "",
    "Interpretation A:",
    interpretationA,
    "",
    "Interpretation B:",
    interpretationB,
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  ];

  if (options?.enforceShape) {
    sections.push(...shapeContract(INTERPRETATION_FIELDS));
  }

  return sections.join("\n");
}
