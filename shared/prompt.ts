// Prompts shared by the Worker. The assignment arrives as attached images
// (native vision input), so there are no OCR text sections.
//
// Three tasks live here: solving; the optional interpret/verify pass that
// reads the diagram first and pauses for the user to confirm; and the
// optional answer cross-check, where a judge grades two solvers' work.

export type EffortKey = "none" | "low" | "medium" | "high" | "max";

export const EFFORT_KEYS: EffortKey[] = ["none", "low", "medium", "high", "max"];

export function isEffortKey(value: string): value is EffortKey {
  return (EFFORT_KEYS as string[]).includes(value);
}

export const SOLVE_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Use English for every user-facing field unless the user explicitly requests another language.";

export const INTERPRET_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Do NOT solve the problem — only interpret it. Use English.";

export const JUDGE_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. You are grading two candidate solutions against the attached assignment; verify, do not trust. Use English.";

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

const JUDGEMENT_FIELDS = [
  "verdict",
  "final_answer",
  "assessment_a",
  "assessment_b",
  "comparison",
  "confidence",
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

export type JudgePromptExtras = {
  /** Human-confirmed problem statement from the interpretation pass. */
  interpretation?: string;
  enforceShape?: boolean;
};

/**
 * The answer cross-check. The two solutions are anonymised as A and B so the
 * judge grades the work, not the brand. It is told to re-derive the numbers
 * itself: every wrong answer seen on the fixtures came from a plausible
 * looking solution (a jet velocity assumed instead of derived, a pressure
 * force counted twice), and a judge that only reads for consistency would
 * pass both.
 */
export function buildJudgePrompt(
  userNotes: string,
  solutionA: string,
  solutionB: string,
  extras: JudgePromptExtras = {},
) {
  const sections = [
    "Two solvers independently answered the attached civil engineering assignment images. Your job is to decide which of the two solutions is correct - if either - and to state the correct final answer.",
    "Verify, do not trust. Re-derive every numerical result yourself from the images before grading, in enough depth to confirm or refute each solution's numbers. Check in particular:",
    "- Whether each solution read the diagram and the givens correctly (geometry, supports, loads, directions, units), and whether a quantity was assumed that should have been derived.",
    "- Continuity, equilibrium and compatibility conditions; sign conventions; unit conversions.",
    "- Double counting or omission of a term (a pressure force counted in both a momentum flux and separately, a weight left out, a reaction on the wrong body).",
    "- The arithmetic of the final substitution.",
    "Then fill the fields:",
    '- `verdict`: "a" if only Solution A is correct, "b" if only Solution B, "both" if both reach the correct final answers (presentation and rounding differences do not matter), "neither" if both are wrong or you could not verify either.',
    "- `final_answer`: the correct final answer(s) with units, as you verified them. If neither solution is correct, give your own corrected answer. If something could not be resolved from the images, say exactly what.",
    "- `assessment_a` and `assessment_b`: for each solution, what it got right and, precisely, where it went wrong - which step, what the error is, and what the value should be.",
    "- `comparison`: where the two solutions differ and the decisive reason for the verdict.",
    '- `confidence`: "high", "medium" or "low" in the verdict.',
    "Format formulas in `final_answer`, `assessment_a`, `assessment_b` and `comparison` with Markdown math delimiters: `$...$` inline, `$$...$$` displayed.",
    "Return JSON matching the required schema exactly.",
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  ];

  if (extras.interpretation) {
    sections.push(
      "",
      "Confirmed problem interpretation (cross-checked by two readers and reviewed by the user):",
      extras.interpretation,
      "Treat this interpretation as the authoritative reading of the problem. A solution that contradicts it has misread the question.",
    );
  }

  sections.push("", "Solution A:", solutionA, "", "Solution B:", solutionB);

  if (extras.enforceShape) {
    sections.push(
      ...shapeContract(JUDGEMENT_FIELDS),
      'Allowed values: `verdict` is one of "a", "b", "both", "neither"; `confidence` is one of "high", "medium", "low".',
    );
  }

  return sections.join("\n");
}
