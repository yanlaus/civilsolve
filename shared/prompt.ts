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

/**
 * How a line break and a LaTeX backslash go into a JSON string. Models
 * writing LaTeX double every backslash, and now and then the newline's too
 * (`\\n`), which shows up on the page as a literal "\n" with the lines run
 * together (fixEscapedNewlines in solution.ts repairs what still gets through).
 */
const JSON_ESCAPES =
  "In the JSON strings, write a line break as \\n (one backslash) and each LaTeX backslash as \\\\ (two).";

export const SOLVE_INSTRUCTIONS = `Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. ${JSON_ESCAPES} Use English for every user-facing field unless the user explicitly requests another language.`;

export const INTERPRET_INSTRUCTIONS = `Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. ${JSON_ESCAPES} Do NOT solve the problem — only interpret it. Use English, except in a \`traditional_chinese\` field where one is asked for.`;

export const JUDGE_INSTRUCTIONS = `Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. ${JSON_ESCAPES} You are grading candidate solutions against the attached assignment; verify, do not trust. Use English, except in the \`traditional_chinese\` field.`;

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

const VERIFIED_INTERPRETATION_FIELDS = [...INTERPRETATION_FIELDS, "traditional_chinese"] as const;

/**
 * Units go inside the math with their number and exponent. Models also wrote
 * them half outside it - mm$^2$, kg/m$^3$, kN$\cdot$m - which the page
 * showed as typed (27 September 2026; math-markdown.ts now typesets those
 * too).
 */
const UNIT_RULE =
  "Keep every unit inside the math, together with its number and exponent: `$A = 2827\\,\\text{mm}^2$`, `$\\rho = 790\\,\\text{kg/m}^3$`, `$M = 45\\,\\text{kN}\\cdot\\text{m}$` - never half outside it, as in mm$^2$, m^3 or kN$\\cdot$m.";

/**
 * How a reading is written: Markdown with LaTeX, like a solution, because the
 * page renders it the same way - in the review step and above the solutions
 * (26 September 2026; it was plain text in a text box before, formulas and
 * all).
 */
const READING_FORMAT = [
  "Write every field as Markdown, the way the page renders it:",
  "- Put each given quantity, and each thing required, on a `- ` bullet line of its own.",
  "- Format every symbol, formula and value with its unit as LaTeX in Markdown math delimiters: `$...$` inline (for example `$d_1 = 60\\,\\text{mm}$`, `$\\theta = 30^\\circ$`, `$P_A$`), `$$...$$` for a displayed equation. Never leave a formula or a subscripted symbol as plain text such as d_1 = 60 mm.",
  `- ${UNIT_RULE}`,
  "- No headings, no backticks, no code blocks.",
];

/** What a re-generation adds to a prompt: the last version and the user's instructions. */
export type RevisionExtras = { previous: string; instructions: string };

/**
 * The user reviewed `what` and asked for changes. Their instructions lead;
 * the previous version is there to build on, not to copy - the point of a
 * re-generation is usually that something in it was wrong.
 */
function revisionSection(what: string, explainIn: string, revision: RevisionExtras) {
  return [
    "",
    `This is a re-generation. You already wrote the ${what} below; the user reviewed it and asks for changes. Follow the user's instructions. If one contradicts the attached images or the engineering, do what the images and the engineering require and explain why in ${explainIn}.`,
    "Re-check against the images whatever the instructions question - do not copy the previous version where it may be wrong - and keep what was right.",
    `Return the complete revised ${what} in every field, not only the changes.`,
    "",
    "User's instructions:",
    revision.instructions,
    "",
    `Previous ${what}:`,
    revision.previous,
  ];
}

export type TutorPromptExtras = {
  /** Human-confirmed problem statement from the interpretation pipeline. */
  interpretation?: string;
  /** Text extracted from uploaded lecture notes. */
  referenceText?: string;
  /** Whether lecture-notes images are attached after the assignment images. */
  hasReferenceImages?: boolean;
  /** Append the literal field list, for channels that cannot enforce a schema. */
  enforceShape?: boolean;
  /** A re-generation of an earlier solution, with the user's instructions. */
  revision?: RevisionExtras;
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
    "- In `final_answer`, each answer on a line of its own, as a `- ` bullet (one per part or quantity), never run together in one paragraph",
    "",
    "Break `interpreted_problem` and `assumptions` into lines, so they are easy to read - never one long paragraph:",
    "- `interpreted_problem`: one or two short sentences on what the problem is, then the given data and what is asked as `- ` bullet lines, one item per line (a multi-part question gets a line per part).",
    "- `assumptions`: a `- ` bullet line per assumption.",
    "",
    "For web-facing text fields (`interpreted_problem`, `assumptions`, `step_by_step`, and `final_answer`), format formulas with Markdown math delimiters:",
    "- Use `$...$` for short inline symbols and equations.",
    "- Use `$$...$$` for displayed equations, substitutions, and final calculated expressions.",
    "- Do not leave formulas as plain text when they contain symbols, subscripts, superscripts, fractions, or unit calculations.",
    `- ${UNIT_RULE}`,
    "- Do not use CJK prose such as 代入, 結果, 已知, or 所求 unless the user explicitly requests a Chinese answer.",
  );

  if (extras.revision) {
    sections.push(...revisionSection("solution", "`assumptions`", extras.revision));
  }

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
    ...READING_FORMAT,
    "Return JSON matching the required schema exactly.",
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  ];

  if (options?.enforceShape) {
    sections.push(...shapeContract(INTERPRETATION_FIELDS));
  }

  return sections.join("\n");
}

/** The reconciler's Traditional Chinese version of the whole reading. */
const CHINESE_READING =
  "In the `traditional_chinese` field, write your whole corrected interpretation again - problem, diagram, given quantities and what is required, in that order, not the discrepancies - in Traditional Chinese as written in Hong Kong, each part opening with a bold label on a line of its own (**題目：**, **圖示：**, **已知：**, **所求：**). Translate every ordinary word (pipe, jet, beam, support, ethyl alcohol...); keep the figure's own labels (such as Fig. B.8b) as they are, and write every number with its unit, symbol, variable name and formula exactly as in the English fields, in the same `$...$` math, for example `$W = 0.5\\,\\text{kN}$`, `$P_A$`, `$30^\\circ$`. Every other field stays in English.";

/**
 * A reading re-generated after review: the reading as the user left it (with
 * their edits), what they want changed, and - when there were two - the
 * readings it was reconciled from. Same output as the reconciler's.
 */
export function buildReviseReadingPrompt(
  userNotes: string,
  current: string,
  instructions: string,
  readings: [string, string] | null,
  options?: { enforceShape?: boolean },
) {
  const sections = [
    "The attached civil engineering assignment images were read, and the reading below came out of it. The user reviewed it - and may have edited it - and asks for changes. Your job is to produce ONE corrected, authoritative reading that follows the user's instructions - do NOT solve the problem.",
    "Re-inspect the images yourself. Follow the user's instructions; where one contradicts what the images show, keep what the images show and say so. Keep everything in the current reading that is right.",
    "In the `discrepancies` field, list what you changed from the current reading and why (or state that nothing needed to change).",
    CHINESE_READING,
    ...READING_FORMAT,
    "Return JSON matching the required schema exactly.",
    "",
    "User's instructions:",
    instructions,
    "",
    "Current reading:",
    current,
  ];
  if (readings) {
    sections.push(
      "",
      "The two independent readings it was reconciled from, for reference:",
      "Reading A:",
      readings[0],
      "",
      "Reading B:",
      readings[1],
    );
  }
  sections.push("", userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]");
  if (options?.enforceShape) {
    sections.push(...shapeContract(VERIFIED_INTERPRETATION_FIELDS));
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
    CHINESE_READING,
    ...READING_FORMAT,
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
    sections.push(...shapeContract(VERIFIED_INTERPRETATION_FIELDS));
  }

  return sections.join("\n");
}

export type JudgePromptExtras = {
  /** Human-confirmed problem statement from the interpretation pass. */
  interpretation?: string;
  enforceShape?: boolean;
  /** A re-generation of an earlier verdict, with the user's instructions. */
  revision?: RevisionExtras;
};

/**
 * The answer cross-check. The solutions are anonymised as A, B, C... so the
 * judge grades the work, not the brand. It is told to re-derive the numbers
 * itself: every wrong answer seen on the fixtures came from a plausible
 * looking solution (a jet velocity assumed instead of derived, a pressure
 * force counted twice), and a judge that only reads for consistency would
 * pass them all.
 */
export function buildJudgePrompt(
  userNotes: string,
  solutions: string[],
  extras: JudgePromptExtras = {},
) {
  const count = solutions.length;
  const letters = solutions.map((_, index) => String.fromCharCode(65 + index));
  const letterList = letters.join(", ");
  const sections = [
    `${count} solvers independently answered the attached civil engineering assignment images. Your job is to decide which of the ${count} solutions are correct - if any - and to state the correct final answer.`,
    "Verify, do not trust. Re-derive every numerical result yourself from the images before grading, in enough depth to confirm or refute each solution's numbers. Check in particular:",
    "- Whether each solution read the diagram and the givens correctly (geometry, supports, loads, directions, units), and whether a quantity was assumed that should have been derived.",
    "- Continuity, equilibrium and compatibility conditions; sign conventions; unit conversions.",
    "- Double counting or omission of a term (a pressure force counted in both a momentum flux and separately, a weight left out, a reaction on the wrong body).",
    "- The arithmetic of the final substitution.",
    "Then fill the fields:",
    `- \`correct_solutions\`: the letters of the solutions that reach the correct final answers (presentation and rounding differences do not matter), from ${letterList}. An empty list means none is correct or none could be verified.`,
    "- `final_answer`: the correct final answer(s) with units, as you verified them. If no solution is correct, give your own corrected answer. If something could not be resolved from the images, say exactly what.",
    `- \`assessments\`: exactly ${count} entries, one per solution in order (${letterList}): what it got right and, precisely, where it went wrong - which step, what the error is, and what the value should be.`,
    "- `comparison`: where the solutions differ and the decisive reason for the verdict.",
    '- `confidence`: "high", "medium" or "low" in the verdict.',
    "- `traditional_chinese`: the verdict explained again in Traditional Chinese as written in Hong Kong - which solutions are correct, the verified final answer, what each solution got right or wrong, and the decisive reason - referring to the solutions by their letters. Translate every ordinary word; keep numbers, units, symbols, variable names and formulas exactly as in English. Every other field stays in English.",
    "Write `final_answer`, `assessments`, `comparison` and `traditional_chinese` as Markdown, the way the page renders a worked solution: every symbol, formula and value with its unit as LaTeX in Markdown math delimiters - `$...$` inline (for example `$F_x = -142.8\\,\\text{N}$`), `$$...$$` for a displayed equation - never as plain text such as F_x = -142.8 N; several answers or points as `- ` bullet lines; no headings, backticks or code blocks.",
    UNIT_RULE,
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

  solutions.forEach((solution, index) => {
    sections.push("", `Solution ${letters[index]}:`, solution);
  });

  if (extras.revision) {
    sections.push(...revisionSection("verdict", "`comparison`", extras.revision));
  }

  if (extras.enforceShape) {
    // Bespoke contract: two of the fields are arrays, which the generic
    // all-strings skeleton cannot express.
    const skeleton = `{"correct_solutions": [${letters.map((l) => `"${l}"`).join(", ")}], "final_answer": "", "assessments": [${letters.map(() => '""').join(", ")}], "comparison": "", "confidence": "high", "traditional_chinese": ""}`;
    sections.push(
      "",
      "Return exactly one JSON object with these 6 fields:",
      skeleton,
      `\`correct_solutions\` lists only the correct letters (it may be empty); \`assessments\` has exactly ${count} strings, in order; \`confidence\` is one of "high", "medium", "low".`,
      "Do not add other fields. Do not nest this object inside another object or array.",
    );
  }

  return sections.join("\n");
}
