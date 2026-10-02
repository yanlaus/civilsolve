// Prompts shared by the Worker. The assignment arrives as attached images
// (native vision input), so there are no OCR text sections.
//
// Four tasks live here: solving; the optional interpret/verify pass that
// reads the diagram first and pauses for the user to confirm; the optional
// answer cross-check, where a judge grades two solvers' work; and the
// optional study notes written from the solutions (shared/study.ts).

import { ASK_FIELDS } from "./ask";
import { STUDY_FIELDS, STUDY_PARTS, type StudyKind } from "./study";

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

export const ASK_INSTRUCTIONS = `Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. ${JSON_ESCAPES} You are a patient civil engineering tutor answering a student's question about a worked solution. Answer in the language the student asked in.`;

export const STUDY_INSTRUCTIONS = `Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. ${JSON_ESCAPES} You are a patient civil engineering tutor writing study notes on an assignment that has already been solved. Use English, except in the \`traditional_chinese\` field.`;

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

const VERIFIED_INTERPRETATION_FIELDS = [
  ...INTERPRETATION_FIELDS,
  "discrepancies_chinese",
  "traditional_chinese",
] as const;

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
    // The page's "Try it yourself" hints show the steps' titles as a plan,
    // then one step at a time (shared/steps.ts reads these lines).
    "Lay out `step_by_step` in steps a student can follow one at a time:",
    "- Open every step with a bold line of its own that says what the step finds, numbered from 1 within each problem - for example `**Step 1 - Velocity of the jet**` - with the step's working on the lines below it.",
    "- When the assignment has several problems or parts, put a `### ` heading with its label before each one's steps (for example `### Q1(a)`).",
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

/** The discrepancies again, in Chinese, for the review step. */
const CHINESE_DISCREPANCIES =
  "In the `discrepancies_chinese` field, write the `discrepancies` again in Traditional Chinese as written in Hong Kong, in the same Markdown and the same `$...$` math: translate every ordinary word; keep numbers, units, symbols and formulas exactly as in English.";

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
    CHINESE_DISCREPANCIES,
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
    CHINESE_DISCREPANCIES,
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
    `- \`assessments\`: exactly ${count} entries, one per solution in order (${letterList}), each as \`- \` bullet points, one point per line: what it got right, and precisely where it went wrong - which step, what the error is, and what the value should be.`,
    `- \`assessments_chinese\`: the same ${count} assessments, in the same order and the same bullet points, in Traditional Chinese as written in Hong Kong. Translate every ordinary word; keep numbers, units, symbols, variable names and formulas exactly as in English.`,
    "- `comparison`: where the solutions differ and the decisive reason for the verdict.",
    '- `confidence`: "high", "medium" or "low" in the verdict.',
    "- `traditional_chinese`: the verdict explained again in Traditional Chinese as written in Hong Kong - which solutions are correct, the verified final answer and the decisive reason (each solution's own assessment is in `assessments_chinese`) - referring to the solutions by their letters. Translate every ordinary word; keep numbers, units, symbols, variable names and formulas exactly as in English. Every other field stays in English.",
    "Write `final_answer`, `assessments`, `assessments_chinese`, `comparison` and `traditional_chinese` as Markdown, the way the page renders a worked solution: every symbol, formula and value with its unit as LaTeX in Markdown math delimiters - `$...$` inline (for example `$F_x = -142.8\\,\\text{N}$`), `$$...$$` for a displayed equation - never as plain text such as F_x = -142.8 N; several answers or points as `- ` bullet lines; no headings, backticks or code blocks.",
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
    const skeleton = `{"correct_solutions": [${letters.map((l) => `"${l}"`).join(", ")}], "final_answer": "", "assessments": [${letters.map(() => '""').join(", ")}], "assessments_chinese": [${letters.map(() => '""').join(", ")}], "comparison": "", "confidence": "high", "traditional_chinese": ""}`;
    sections.push(
      "",
      "Return exactly one JSON object with these 7 fields:",
      skeleton,
      `\`correct_solutions\` lists only the correct letters (it may be empty); \`assessments\` and \`assessments_chinese\` have exactly ${count} strings each, in order; \`confidence\` is one of "high", "medium", "low".`,
      "Do not add other fields. Do not nest this object inside another object or array.",
    );
  }

  return sections.join("\n");
}

export type StudyPromptExtras = {
  /** Human-confirmed problem statement from the interpretation pass. */
  interpretation?: string;
  /** The cross-check verdict as text, when the notes start from its verified answer. */
  verdict?: string;
  enforceShape?: boolean;
  /** A re-generation of earlier notes, with the user's instructions. */
  revision?: RevisionExtras;
};

/**
 * What each kind of study notes is (shared/study.ts), what goes in each of
 * its parts - in the order of STUDY_PARTS, which holds their labels - and how
 * its Chinese is written, given its Chinese labels.
 */
const STUDY_BRIEFS: Record<
  StudyKind,
  { what: string; audience: string; parts: string[]; chinese: (labels: string) => string[] }
> = {
  approach: {
    what: "the type of problem this is and how problems of this type are solved (題型解題思路), with the key formulas",
    audience:
      "Write it for a student preparing for the next question of the same type: general enough to reuse, and tied to this question by its numbers.",
    parts: [
      "what type of problem this is - the topic and the sub-type (for example, linear momentum applied to a pipe bend) - and the cues in a question that tell you it is this type.",
      "the general method for this type of problem as numbered steps (`1.`, `2.`, ...): what each step finds and why it comes at that point, and in a few words how it plays out in this question.",
      "each formula the method needs, as a displayed equation `$$...$$`, followed by what every symbol in it means, with its unit, and when the formula applies (its assumptions and sign convention).",
      "the traps in this type of problem, as `- ` bullet lines (with a verdict, including the mistakes it found in the solutions).",
    ],
    chinese: (labels) => [
      `\`traditional_chinese\`: the whole \`guide\` again in Traditional Chinese as written in Hong Kong - the same parts in the same order, each opening with its bold label on a line of its own (${labels}), with the same Markdown and the same \`$...$\` math. Translate every ordinary word; keep numbers, units, symbols, variable names and formulas exactly as in English. The student is taught in English, so give the English term in brackets after a technical term the first time it appears, for example 動量方程 (momentum equation).`,
    ],
  },
  // The owner's example of what this should read like (28 September 2026):
  // a Hong Kong tutor talking a student through a bolted tension splice -
  // the cover plates "like a sandwich", the bolt's three "ways to die" and
  // the fastest one being its real strength, a line after every number on
  // what it means, and "that's all there is to it" at the end - in spoken
  // Cantonese with the English terms kept. The first version read like a
  // textbook chapter (7,000 characters for a beam).
  explain: {
    what: "the question and its solution explained simply, the way a friendly tutor talks a student through it",
    audience: [
      "Pitch it at a secondary-school student who has not understood much of this subject yet. Talk to the student as \"you\", in plain words and short sentences, like a patient tutor sitting beside them - not like a textbook.",
      "Give the problem an everyday picture that fits it (two plates clamped between two cover plates are \"a sandwich\"; the ways a part can fail are its \"ways to break\", and the one that comes first is its real strength). A comparison of size must be right: 700 kN is the weight of about 70 tonnes, not of hundreds of cars.",
      "Name each technical term in English with a plain explanation the first time. After every number you work out, say in one line what it means physically (\"so at 183.8 kN the bolt snaps in two places\").",
      "Keep it short: say each thing once and leave out what the student does not need - about 300 to 450 words for one question, and a short run through each for a paper with several.",
    ].join(" "),
    parts: [
      "the situation in two or three sentences of everyday words, with the everyday picture, and what the question wants you to find.",
      "the one idea the whole solution hangs on, in a sentence or two (for example: a bolt can fail in several ways, and whichever comes first is its real strength).",
      "the working as a few numbered points (`1.`, `2.`, ...), one per idea rather than one per line of the solution - checks of the same kind share a point (the three plate-bearing checks are one). Each point: a plain name for what it checks (\"Way 1: the bolt snaps\"), the formula with the numbers put in, the result with its unit, then one line on what that number means. Checks that do not change the answer - spacing, edge distances and other detailing - get one line at the end of this part, not a point each.",
      "the results side by side as `- ` bullet lines, which one governs and why, the final answer with its unit, and one closing line the student can remember (\"That's all there is to it: work out every way it can fail - the smallest one wins.\").",
    ],
    chinese: (labels) => [
      `\`traditional_chinese\`: the same explanation told again for a Hong Kong student, the way a Hong Kong tutor talks - in spoken Cantonese written in Traditional Chinese characters (係、嘅、咗、咁、佢、呢個、即係話), not formal written Chinese, and not a word-for-word translation of the English. The student is taught in English, so keep each engineering term in English with its Chinese in brackets the first time, for example Double Shear (雙剪), Bearing Capacity (承壓力); everything else - the everyday pictures and words included (三文治, 死法, 頂唔頂得住) - is in Cantonese. The same parts in the same order, each opening with its bold label on a line of its own (${labels}), with the same Markdown and the same \`$...$\` math; keep numbers, units, symbols, variable names and formulas exactly as in English.`,
      "The tone to aim for, from another question - do not copy its content: 「一粒螺絲有3種死法，邊種死得最快，嗰個就係佢嘅真正實力。三文治夾住，所以螺絲會斷2個位，叫 Double Shear (雙剪)。一個位頂到 $91.8\\,\\text{kN}$，兩個位就係 $2 \\times 91.8 = 183.8\\,\\text{kN}$。即係話，拉到 $183.8\\,\\text{kN}$，粒螺絲就會斷兩截。」",
    ],
  },
};

/**
 * Study notes on a solved assignment, from what the user picked: one solver's
 * solution, or the cross-check's verified answer - the verdict, with the
 * solutions it graded as Solution A, B, ... in its order, for their working.
 */
export function buildStudyPrompt(
  kind: StudyKind,
  userNotes: string,
  solutions: string[],
  extras: StudyPromptExtras = {},
) {
  const brief = STUDY_BRIEFS[kind];
  const labels = STUDY_PARTS[kind];
  const count = solutions.length;
  const letters = solutions.map((_, index) => String.fromCharCode(65 + index));
  const sections = extras.verdict
    ? [
        `The attached civil engineering assignment images have been solved by ${count === 1 ? "a solver" : `${count} solvers`}, and a cross-check graded ${count === 1 ? "the solution" : "their solutions"}: the solutions and the verdict are below. Your job is to write study notes on it: ${brief.what}.`,
        "Build the notes on the verdict's verified final answer - it is authoritative - and on the method of the solutions it found correct; where a solution it found wrong went astray, use that for the mistakes to avoid.",
      ]
    : [
        `The attached civil engineering assignment images have been solved; the solution is below. Your job is to write study notes on it: ${brief.what}.`,
        // Not "point out any error": told that, DeepSeek and ChatGPT both
        // "corrected" a textbook's sqrt(275/345) for a 20 mm S355 plate to
        // 355 - wrong, p_y is 345 above 16 mm - and ChatGPT changed the
        // answer with it (28 September 2026). Checking is the cross-check's
        // job; the user picked this solution to learn from.
        "Build the notes on this solution as it stands. Checking it is the cross-check's job, not yours: do not re-derive its numbers or correct its code values - one that looks off may well be right (a steel's design strength drops for thicker plates, for instance), and a wrong correction misleads the student.",
      ];

  sections.push(
    "",
    `\`guide\`: ${brief.what}. ${brief.audience} Explain the method and the reasoning rather than copying a solution's working. Write it in ${labels.length} parts, in this order:`,
    ...labels.map((part, index) => `- ${part.label}: ${brief.parts[index]}`),
    `Open each part with its label in bold on a line of its own - \`**${labels[0].label}**\` - and start the part's content on the next line, never on the label's line.`,
    "",
    ...brief.chinese(labels.map((part) => `**${part.chinese}**`).join(", ")),
    "",
    "Write `guide` and `traditional_chinese` as Markdown, the way the page renders a worked solution: every symbol, formula and value with its unit as LaTeX in Markdown math delimiters - `$...$` inline (for example `$Q = A_1 V_1$`), `$$...$$` for a displayed equation - never as plain text such as Q = A1 V1; lists as `- ` bullet lines or numbered `1.` lines; no headings, backticks or code blocks.",
    UNIT_RULE,
    "Return JSON matching the required schema exactly.",
    "",
    userNotes ? `User notes:\n${userNotes}` : "User notes:\n[None provided]",
  );

  if (extras.interpretation) {
    sections.push(
      "",
      "Confirmed problem interpretation (cross-checked by two readers and reviewed by the user):",
      extras.interpretation,
      "Treat this interpretation as the authoritative reading of the problem.",
    );
  }

  if (extras.verdict) {
    solutions.forEach((solution, index) => {
      sections.push("", `Solution ${letters[index]}:`, solution);
    });
    sections.push("", "Cross-check verdict (the letters are the solutions above):", extras.verdict);
  } else {
    sections.push("", "Solution:", solutions[0]);
  }

  if (extras.revision) {
    sections.push(...revisionSection("study notes", "`guide`", extras.revision));
  }

  if (extras.enforceShape) {
    sections.push(...shapeContract(STUDY_FIELDS));
  }

  return sections.join("\n");
}

export type AskPromptExtras = {
  /** Human-confirmed problem statement from the interpretation pass. */
  interpretation?: string;
  /** The step of the working the question is about. */
  step?: string;
  /** Earlier questions about the same solution, oldest first. */
  history?: Array<{ question: string; answer: string }>;
  enforceShape?: boolean;
};

/**
 * A student's question about one finished solution (shared/ask.ts). The
 * model explains what was asked, at the student's level, in the student's
 * language - Cantonese the way a Hong Kong tutor talks when the question is
 * in Chinese, like the simple explanation notes. It does not write the
 * solution again, and it says so plainly if the question exposes a mistake.
 */
export function buildAskPrompt(
  userNotes: string,
  solution: string,
  question: string,
  extras: AskPromptExtras = {},
) {
  const sections = [
    "A student is working through the worked solution below to the attached civil engineering assignment images, and has a question about it. Answer the question.",
    "- Answer what was asked, directly, as a patient tutor would: the idea behind the step, why the term or sign is there, where a number comes from. Use the solution's own numbers and symbols.",
    "- Do not write the whole solution again. Show a short calculation only when it is what the student asked about.",
    "- If the question shows that the solution has a mistake, say so plainly, explain what it should be and why, and give the corrected value. Do not invent a mistake to agree with the student.",
    "- Keep it short: a few short paragraphs or a short list. No headings.",
    "",
    "`answer`: in the language of the student's question. If the student wrote in Chinese, answer for a Hong Kong student the way a Hong Kong tutor talks - spoken Cantonese written in Traditional Chinese characters (係、嘅、咗、咁、佢、即係話), not formal written Chinese; keep each engineering term in English with its Chinese in brackets the first time, for example Continuity (連續方程). Otherwise answer in English.",
    "Write `answer` as Markdown, the way the page renders a worked solution: every symbol, formula and value with its unit as LaTeX in Markdown math delimiters - `$...$` inline, `$$...$$` for a displayed equation - never as plain text; lists as `- ` lines; no headings, backticks or code blocks.",
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
    );
  }

  sections.push("", "The worked solution:", solution);

  if (extras.history?.length) {
    sections.push("", "The student's earlier questions about this solution, and the answers given:");
    extras.history.forEach((turn, index) => {
      sections.push("", `Question ${index + 1}:`, turn.question, `Answer ${index + 1}:`, turn.answer);
    });
  }

  if (extras.step) {
    sections.push("", "The step of the solution the question is about:", extras.step);
  }

  sections.push("", "The student's question:", question);

  if (extras.enforceShape) {
    sections.push(...shapeContract(ASK_FIELDS));
  }

  return sections.join("\n");
}
