// Tutor prompt shared by the Worker. The assignment arrives as attached
// images (native vision input), so there are no OCR text sections.

export type EffortKey = "none" | "low" | "medium" | "high" | "max";

export const EFFORT_KEYS: EffortKey[] = ["none", "low", "medium", "high", "max"];

export function isEffortKey(value: string): value is EffortKey {
  return (EFFORT_KEYS as string[]).includes(value);
}

export const SOLVE_INSTRUCTIONS =
  "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Use English for every user-facing field unless the user explicitly requests another language.";

export function buildTutorPrompt(userNotes: string, effort: EffortKey) {
  return [
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
  ].join("\n");
}
