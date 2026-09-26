// Provider-agnostic solution parsing, repair, and display normalization.
// Pure string logic shared by the Worker (finalizing streamed responses)
// and the client (flattening solutions for the cross-check judge).

import { PROVIDER_LABELS, type ProviderKey } from "./providers";

export type StructuredSolution = {
  title: string;
  interpreted_problem: string;
  assumptions: string;
  step_by_step: string;
  final_answer: string;
  latex_body: string;
};

export type ProviderArtifact = {
  title: string;
  interpretedProblem: string;
  assumptions: string;
  stepByStep: string;
  finalAnswer: string;
  latexBody: string;
};

export const solutionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    interpreted_problem: { type: "string" },
    assumptions: { type: "string" },
    step_by_step: { type: "string" },
    final_answer: { type: "string" },
    latex_body: { type: "string" },
  },
  required: [
    "title",
    "interpreted_problem",
    "assumptions",
    "step_by_step",
    "final_answer",
    "latex_body",
  ],
} as const;

/**
 * LaTeX commands that begin with "n": a backslash-n in front of one of these
 * is the command, not an escaped line break.
 */
const LATEX_N_COMMANDS = new Set([
  "nabla", "natural", "ncong", "ne", "nearrow", "neg", "neq", "newline", "newpage", "nexists",
  "ngeq", "ngeqslant", "ngtr", "ni", "nleftarrow", "nLeftarrow", "nleftrightarrow", "nleq",
  "nleqslant", "nless", "nmid", "nobreak", "noindent", "nolimits", "nonumber", "normalsize", "not",
  "notin", "nparallel", "nprec", "nrightarrow", "nRightarrow", "nsim", "nsubset", "nsubseteq",
  "nsucc", "nsupset", "nsupseteq", "nu", "nvdash", "nwarrow",
]);

/**
 * Line breaks a model escaped twice. Writing LaTeX inside JSON, a model
 * doubles every backslash - and now and then the newline's too, `\\n` for
 * `\n`, so the parsed text holds a literal backslash-n: the page showed
 * "\n" and ran the lines together into one paragraph. Seen on ChatGPT
 * (Luna), in 4 of 5 fields of one reconcile on 26 September 2026, next to
 * real line breaks in the same answer. Kept as they are: a LaTeX command that
 * starts with n (`\nu`, `\neq`...), and `\\` - a LaTeX line break - followed
 * by an n. A literal `\r\n` is a line break too.
 */
export function fixEscapedNewlines(value: string) {
  if (!value.includes("\\")) return value;
  return value.replace(/(\\+)(r\\n|n)([A-Za-z]*)/g, (match, slashes: string, escape: string, word: string) => {
    // An even run of backslashes is LaTeX's "\\" and the n is ordinary text.
    if (slashes.length % 2 === 0) return match;
    if (escape === "n" && LATEX_N_COMMANDS.has(`n${word}`)) return match;
    return `${slashes.slice(0, -1)}\n${word}`;
  });
}

/** A text field a model wrote, cleaned for display: escapes and stray characters. */
export function cleanModelText(value: string) {
  return sanitizeText(fixEscapedNewlines(value));
}

export function sanitizeText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u0015/g, " x ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Structured solution parsing (raw model text -> StructuredSolution)
// ---------------------------------------------------------------------------

/**
 * Removes `<think>...</think>` reasoning that a model put in its *content*
 * rather than in a reasoning field. MiniMax M3 on OpenCode Go does this, and
 * its thinking is long (60-76k characters on the B.8 fixture) and full of
 * braces, so leaving it in makes the first `{` of the candidate land inside
 * the reasoning and everything after it parse as garbage. An unclosed
 * `<think>` means the answer never arrived, so the rest is dropped too.
 */
export function stripThinkTags(value: string) {
  const closed = value.replace(/<think>[\s\S]*?<\/think>/gi, " ");
  const open = closed.search(/<think>/i);
  return (open >= 0 ? closed.slice(0, open) : closed).trim();
}

export function normalizeJsonCandidate(rawText: string) {
  const trimmed = stripThinkTags(sanitizeText(rawText));
  if (!trimmed) return trimmed;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    return withoutFence.slice(objectStart, objectEnd + 1);
  }

  return withoutFence;
}

const SCHEMA_FIELDS = [
  "title",
  "interpreted_problem",
  "assumptions",
  "step_by_step",
  "final_answer",
  "latex_body",
] as const;

const CUT_OFF_NOTE = "[The response was cut off here.]";
const CUT_OFF_BEFORE_ANSWER = "The response was cut off before reaching the final answer.";

/**
 * Salvages a JSON object that stopped mid-stream. Streams get cut (a gateway
 * closing the connection, a token cap landing inside a string), and what
 * arrives is a valid prefix of the object: every field before the cut is
 * complete, and the field being written is a partial string. Closing that
 * string and the object usually yields something JSON.parse accepts.
 *
 * Returns the parsed record plus the name of the field whose value was cut,
 * or null when the prefix is not salvageable. The caller decides what a
 * partial field is worth.
 */
function recoverTruncatedJson(
  rawText: string,
): { record: Record<string, unknown>; cutField: string | null } | null {
  const text = stripThinkTags(sanitizeText(rawText)).replace(/^```(?:json)?\s*/i, "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  // To the END, not to the last "}": a LaTeX body is full of braces.
  let body = text.slice(start);

  // Where did the cut land - inside a string, or between tokens?
  let inString = false;
  let escaped = false;
  for (const ch of body) {
    if (escaped) {
      escaped = false;
    } else if (ch === "\\" && inString) {
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
    }
  }

  if (inString) {
    // A dangling backslash or half a \uXXXX would make the closing quote an
    // escape instead of a terminator.
    body = body.replace(/\\u[0-9a-fA-F]{0,3}$/, "").replace(/\\$/, "");
    body += '"';
  }

  // Strip whatever cannot be closed into a value: a trailing comma, a key
  // with no value ("latex_body": ), or a key string cut before its colon.
  // A value is preceded by ":", a key by "," or "{" - only the latter go.
  const beforeKeyStrip = body.replace(/\s+$/, "");
  body = beforeKeyStrip.replace(/([,{])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, "$1").replace(/,\s*$/, "");

  // The cut landed inside a value only if it landed inside a string AND that
  // string survived the key strip (a cut key is removed, not kept partial).
  const cutInsideValue = inString && body === beforeKeyStrip;
  let record: unknown;
  try {
    record = JSON.parse(body + "}");
  } catch {
    return null;
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;

  const keys = Object.keys(record);
  return {
    record: record as Record<string, unknown>,
    cutField: cutInsideValue && keys.length ? keys[keys.length - 1] : null,
  };
}

export type ParseOptions = {
  /**
   * Accept a response that was cut off before the final answer, delivering
   * the working that arrived with a note in place of the answer. Off by
   * default: the caller retries instead, because a fresh attempt usually
   * yields a whole answer and a stub never does. Set on the last attempt.
   */
  allowIncomplete?: boolean;
};

export function parseStructuredSolution(
  rawText: string,
  provider: ProviderKey,
  options: ParseOptions = {},
): StructuredSolution {
  let parsed: unknown;
  const jsonCandidate = normalizeJsonCandidate(rawText);
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
    const recovered = recoverTruncatedJson(rawText);
    if (recovered) {
      const { record, cutField } = recovered;
      if (cutField === "latex_body") {
        // Half a LaTeX document is worse than none: finalizeProviderArtifact
        // rebuilds one from the other fields when this is empty.
        record.latex_body = "";
      } else if (cutField && typeof record[cutField] === "string") {
        record[cutField] = `${(record[cutField] as string).trimEnd()}\n\n${CUT_OFF_NOTE}`;
      }
      // Cut before the answer was written. With attempts left this is not
      // worth delivering - the caller retries. On the last attempt, say so
      // rather than fail, as long as there is working to show.
      const hasAnswer = typeof record.final_answer === "string" && record.final_answer.trim();
      const hasWorking = typeof record.step_by_step === "string" && record.step_by_step.trim();
      if (!hasAnswer && hasWorking && options.allowIncomplete) {
        record.final_answer = CUT_OFF_BEFORE_ANSWER;
      }
      if (hasAnswer || options.allowIncomplete) {
        const salvaged = coerceStructuredSolution(record);
        if (salvaged) return salvaged;
      }
    }

    const fallback = synthesizeStructuredSolutionFromText(rawText);
    if (fallback) {
      return fallback;
    }
    throw new Error(
      `${PROVIDER_LABELS[provider]} returned invalid JSON.${error instanceof Error ? ` ${error.message}` : ""}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${PROVIDER_LABELS[provider]} returned an invalid response shape.`);
  }

  const normalized = coerceStructuredSolution(parsed);
  if (normalized) {
    return normalized;
  }

  const record = parsed as Record<string, unknown>;
  const fields = [
    "title",
    "interpreted_problem",
    "assumptions",
    "step_by_step",
    "final_answer",
    "latex_body",
  ] as const;

  for (const field of fields) {
    if (typeof record[field] !== "string") {
      throw new Error(`${PROVIDER_LABELS[provider]} response is missing "${field}".`);
    }
  }

  return {
    title: record.title as string,
    interpreted_problem: record.interpreted_problem as string,
    assumptions: record.assumptions as string,
    step_by_step: record.step_by_step as string,
    final_answer: record.final_answer as string,
    latex_body: record.latex_body as string,
  };
}

function synthesizeStructuredSolutionFromText(rawText: string): StructuredSolution | null {
  const text = stripThinkTags(sanitizeText(rawText));
  if (text.length < 40) {
    return null;
  }

  // This is a prose fallback. Text that is plainly an attempt at our JSON
  // schema (it starts with "{" and names schema fields) is not prose, and
  // treating it as such produced a "solution" whose final answer was a
  // stray `"latex_body": …` fragment. Let the caller report invalid JSON.
  const unfenced = text.replace(/^```(?:json)?\s*/i, "");
  if (unfenced.startsWith("{") && SCHEMA_FIELDS.some((f) => unfenced.includes(`"${f}"`))) {
    return null;
  }

  const finalMatch =
    text.match(/(?:final answer|answer)\s*:?\s*([\s\S]{1,800})$/i) ||
    text.match(/(?:therefore|so,?)\s+([\s\S]{1,500})$/i);

  return {
    title: "Worked Solution",
    interpreted_problem: "See uploaded problem materials.",
    assumptions: "Assumptions were not explicitly stated.",
    step_by_step: text,
    final_answer: sanitizeText(
      finalMatch?.[1] || text.split("\n").filter(Boolean).at(-1) || "See worked solution.",
    ),
    latex_body: "",
  };
}

function coerceStructuredSolution(value: unknown): StructuredSolution | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = normalizeStructuredSolution(record);
  if (direct) {
    return direct;
  }

  // Some providers return the answer wrapped in a single envelope key, usually
  // the json_schema name they were handed: {"civil_solution": {...}}.
  const keys = Object.keys(record);
  if (keys.length === 1) {
    const inner = record[keys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return normalizeStructuredSolution(inner as Record<string, unknown>);
    }
  }

  return null;
}

function normalizeStructuredSolution(
  record: Record<string, unknown>,
): StructuredSolution | null {
  const fromProblems = normalizeProblemsShape(record);
  if (fromProblems) {
    return fromProblems;
  }

  const title =
    readStringField(record, ["title", "problem_title", "question_title"]) ||
    (readStringField(record, ["equation", "problem"]) ? "Worked Solution" : "");

  const interpretedProblem =
    readStringField(record, [
      "interpreted_problem",
      "problem",
      "question",
      "equation",
      "prompt",
    ]) || "";

  const assumptions =
    readStringField(record, ["assumptions", "notes", "missing_data"]) ||
    "Assumptions were not explicitly stated.";

  const stepByStep =
    readStringField(record, ["step_by_step", "working", "solution_steps"]) ||
    formatSteps(record.steps) ||
    formatObject(record.solution) ||
    "";

  const finalAnswer =
    readStringField(record, ["final_answer", "answer", "result"]) ||
    formatObject(record.solution) ||
    "";

  const latexBody = readStringField(record, ["latex_body"]) || "";

  if (!interpretedProblem || !stepByStep || !finalAnswer) {
    return null;
  }

  return {
    title: title || "Worked Solution",
    interpreted_problem: interpretedProblem,
    assumptions,
    step_by_step: stepByStep,
    final_answer: finalAnswer,
    latex_body: latexBody,
  };
}

/**
 * Any value a model put where text belongs, as text: a string as-is, a list
 * as one entry per line (numbered unless the entries already carry their
 * own "Step 3 -" / "3." labels), an object as "key = value" lines.
 */
/** Any JSON value as readable text: arrays numbered, objects as `key = value` lines. */
export function textOf(value: unknown): string {
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((entry) => textOf(entry)).filter(Boolean);
    if (!items.length) return "";
    const labelled = items.every((item) => /^(step\s*\d+|\d+[.)]|\(\w\))/i.test(item));
    return labelled
      ? items.join("\n\n")
      : items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A step or formula object: {name, latex, substitution} and the like.
    const parts = Object.entries(record)
      .map(([key, entry]) => {
        const text = textOf(entry);
        if (!text) return "";
        return typeof entry === "string" && /^(name|title|label|description|text)$/i.test(key)
          ? text
          : `${key} = ${text}`;
      })
      .filter(Boolean);
    return parts.join("\n");
  }
  return "";
}

function readTextField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const text = textOf(record[key]);
    if (text) return text;
  }
  return "";
}

/**
 * `{"problems": [...]}`: the shape a model invents when it is handed several
 * problems and not held to the schema. Every problem is kept, each under its
 * own heading, in all five text fields - the app shows one solution per
 * provider, and an exam paper is many problems. (Until 23 September 2026
 * this read problems[0] only, so a 16-question paper showed question 1.)
 *
 * Field shapes vary by model: MiniMax M3 sent `step_by_step` as a list of
 * "Step N -" strings, `given` as an object and `formulas` as a list of
 * {name, latex, substitution} objects; older runs sent strings or a nested
 * `solution` object. textOf takes whichever arrives.
 */
function normalizeProblemsShape(record: Record<string, unknown>): StructuredSolution | null {
  const problems = record.problems;
  if (!Array.isArray(problems) || !problems.length) {
    return null;
  }

  const parts = problems
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((problem, index) => {
      const label =
        readTextField(problem, ["problem_id", "problem_number", "id", "number", "label", "title"]) ||
        `Problem ${index + 1}`;
      const interpreted = readTextField(problem, [
        "interpreted_problem",
        "interpretedProblem",
        "statement",
        "problem",
        "question",
        "problem_text",
      ]);
      const given = readTextField(problem, ["given", "given_information"]);
      const required = readTextField(problem, ["required", "required_quantity"]);
      const assumptions = readTextField(problem, ["assumptions", "notes", "missing_data"]);
      const formulas = readTextField(problem, ["formulas", "equations"]);
      const legacySteps = [
        readNestedString(problem, ["solution", "formula"]),
        readNestedString(problem, ["solution", "substitution"]),
        readNestedString(problem, ["solution", "result"]),
        ...readStringArray(problem, "formula_substitution_result"),
      ].filter(Boolean);
      const steps =
        readTextField(problem, [
          "step_by_step",
          "stepByStep",
          "stepbystep",
          "steps",
          "worked_solution",
          "solution_text",
          "working",
        ]) ||
        (legacySteps.length ? legacySteps.map((part, i) => `${i + 1}. ${part}`).join("\n") : "");
      const answer = readTextField(problem, [
        "final_answer",
        "finalAnswer",
        "finalanswer",
        "answer",
        "result",
      ]);
      const latex = readTextField(problem, ["latex_body", "latex"]);
      return { label, interpreted, given, required, assumptions, formulas, steps, answer, latex };
    })
    // A problem with neither working nor an answer contributes nothing.
    .filter((part) => part.steps || part.answer);

  if (!parts.length || !parts.some((part) => part.answer)) {
    return null;
  }

  const many = parts.length > 1;
  const section = (label: string, body: string, heading: "###" | "bold") =>
    !many ? body : heading === "###" ? `### ${label}\n\n${body}` : `**${label}.** ${body}`;
  const join = (pick: (part: (typeof parts)[number]) => string, heading: "###" | "bold") =>
    parts
      .map((part) => (pick(part) ? section(part.label, pick(part), heading) : ""))
      .filter(Boolean)
      .join("\n\n");

  const assumptions = join(
    (part) =>
      [
        part.given ? `Given:\n${part.given}` : "",
        part.required ? `Required:\n${part.required}` : "",
        part.assumptions,
      ]
        .filter(Boolean)
        .join("\n\n"),
    "###",
  );
  const steps = join(
    (part) => [part.formulas ? `Formulas:\n${part.formulas}` : "", part.steps].filter(Boolean).join("\n\n"),
    "###",
  );
  // LaTeX per problem is kept only when every problem has some; a partial
  // document is worse than the one finalizeProviderArtifact rebuilds.
  const latex = parts.every((part) => part.latex)
    ? parts
        .map((part) => (many ? `\\section*{${part.label}}\n${part.latex}` : part.latex))
        .join("\n\n")
    : readStringField(record, ["latex_body"]);

  return {
    title:
      readStringField(record, ["title", "assignment_title"]) ||
      (many ? `Worked Solutions (${parts.length} problems)` : `Worked Solution ${parts[0].label}`.trim()),
    interpreted_problem: join((part) => part.interpreted, "bold"),
    assumptions: assumptions || "Assumptions were not explicitly stated.",
    step_by_step: steps,
    final_answer: join((part) => part.answer, "bold"),
    latex_body: latex,
  };
}

function readStringField(record: Record<string, unknown>, keys: string[]) {
  const normalizedEntries = Object.entries(record).map(([key, value]) => [
    normalizeFieldKey(key),
    value,
  ] as const);

  for (const key of keys) {
    const directValue = record[key];
    const value =
      typeof directValue === "string"
        ? directValue
        : normalizedEntries.find(([normalizedKey]) => normalizedKey === normalizeFieldKey(key))?.[1];
    if (typeof value === "string" && value.trim()) {
      return sanitizeText(value);
    }
  }
  return "";
}

function normalizeFieldKey(value: string) {
  return value
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function readNestedString(record: Record<string, unknown>, path: string[]) {
  let value: unknown = record;
  for (const key of path) {
    if (!value || typeof value !== "object") return "";
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.trim() ? sanitizeText(value) : "";
}

function formatSteps(value: unknown) {
  if (!Array.isArray(value)) return "";
  const items = value
    .map((entry) => (typeof entry === "string" ? sanitizeText(entry) : ""))
    .filter(Boolean);
  if (!items.length) return "";
  return items.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
}

function formatStringArray(value: unknown) {
  if (!Array.isArray(value)) return "";
  const items = value
    .map((entry) => (typeof entry === "string" ? sanitizeText(entry) : ""))
    .filter(Boolean);
  if (!items.length) return "";
  return items.map((entry) => `- ${entry}`).join("\n");
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? sanitizeText(entry) : ""))
    .filter(Boolean);
}

function formatObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        return sanitizeText(`${key} = ${String(entry)}`);
      }
      return "";
    })
    .filter(Boolean);
  return entries.join("\n");
}

// ---------------------------------------------------------------------------
// Display normalization and repair (StructuredSolution -> ProviderArtifact)
// ---------------------------------------------------------------------------

export function normalizeDisplayText(value: string) {
  return sanitizeText(value)
    .replace(/^\s*\\\s*$/gm, "")
    .replace(/(^|\n)\s*\\\s*(?=\\)/g, "$1")
    .replace(/(^|\n)\s*代入[:：]\s*/g, "$1Substitute:\n")
    .replace(/(^|\n)\s*結果[:：]\s*/g, "$1Result:\n")
    .replace(/(^|\n)\s*已知[:：]\s*/g, "$1Given:\n")
    .replace(/(^|\n)\s*所求[:：]\s*/g, "$1Required:\n")
    .replace(/(^|\n)\s*公式[:：]\s*/g, "$1Formula:\n")
    .replace(/\\times\s*\\times\s*([^\n]*?)\s*\\times\s*\\times/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/\\times\s+([A-Za-z][^\\\n]{1,80}?)\s*\\times/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/×\s*×\s*([^\n]*?)\s*×\s*×/g, (_match, label: string) =>
      `**${label.trim()}**`,
    )
    .replace(/\\begin\{align\\times\s*\}/g, "\\begin{align*}")
    .replace(/\\end\{align\\times\s*\}/g, "\\end{align*}")
    .replace(/\\section\\times\s*\{/g, "\\section*{")
    .replace(/\\text\{\s*\\mathrm\{([^{}]+)\}\s*\}/g, "\\text{$1}")
    .replace(/\\text\{\s+([^{}]+)\s+\}/g, "\\text{$1}")
    .replace(/\b(Formula|Substitute|Substitution|Result|Given|Required|Total|So):/g, "\n\n$1:")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeProviderArtifact(result: ProviderArtifact): ProviderArtifact {
  return {
    ...result,
    title: normalizeDisplayText(result.title),
    interpretedProblem: normalizeDisplayText(result.interpretedProblem),
    assumptions: normalizeDisplayText(result.assumptions),
    stepByStep: normalizeDisplayText(result.stepByStep),
    finalAnswer: normalizeDisplayText(result.finalAnswer),
  };
}

export function repairCodexJsonBlob(result: ProviderArtifact): ProviderArtifact | null {
  const candidate = [result.stepByStep, result.assumptions, result.finalAnswer]
    .find((value) => /(^|[^{])\{[\s\S]*"problems"\s*:/.test(value));
  if (!candidate) return null;

  const parsed = parseJsonObjectFromText(candidate);
  if (!parsed || typeof parsed !== "object") {
    return repairCodexJsonFragments(result, candidate);
  }
  const record = parsed as Record<string, unknown>;
  const problems = Array.isArray(record.problems) ? record.problems : [];
  const first = problems[0];
  if (!first || typeof first !== "object") return null;

  const problem = first as Record<string, unknown>;
  const interpretedProblem = readLooseString(problem, [
    "interpreted_problem",
    "interpretedProblem",
    "problem",
    "statement",
    "question",
  ]);
  const assumptions = readLooseString(problem, ["assumptions", "notes"]);
  const stepByStep = readLooseString(problem, [
    "step_by_step",
    "stepByStep",
    "stepbystep",
    "worked_solution",
  ]);
  const finalAnswer = readLooseString(problem, [
    "final_answer",
    "finalAnswer",
    "finalanswer",
    "answer",
    "result",
  ]);

  if (!stepByStep && !finalAnswer) return null;

  const problemNumber = readLooseString(problem, ["problem_number", "problemNumber"]);
  return {
    ...result,
    title: problemNumber ? `Worked Solution ${problemNumber}` : result.title || "Worked Solution",
    interpretedProblem: interpretedProblem || result.interpretedProblem,
    assumptions: assumptions || result.assumptions,
    stepByStep: stepByStep || result.stepByStep,
    finalAnswer: finalAnswer || result.finalAnswer,
  };
}

function repairCodexJsonFragments(
  result: ProviderArtifact,
  candidate: string,
): ProviderArtifact | null {
  const interpretedProblem = extractJsonStringField(candidate, [
    "interpreted_problem",
    "interpretedProblem",
  ]);
  const assumptions = extractJsonStringField(candidate, ["assumptions"]);
  const stepByStep =
    extractJsonStringField(candidate, [
      "step_by_step",
      "stepByStep",
      "stepbystep",
    ]) ||
    extractMarkdownTailFromCodexBlob(candidate);
  const finalAnswer = extractJsonStringField(candidate, [
    "final_answer",
    "finalAnswer",
    "finalanswer",
  ]);

  if (!stepByStep && !finalAnswer) return null;

  const problemNumber = extractJsonStringField(candidate, [
    "problem_number",
    "problemNumber",
  ]);

  return {
    ...result,
    title: problemNumber ? `Worked Solution ${problemNumber}` : result.title || "Worked Solution",
    interpretedProblem: interpretedProblem || result.interpretedProblem,
    assumptions: assumptions || result.assumptions,
    stepByStep: stepByStep || result.stepByStep,
    finalAnswer: finalAnswer || result.finalAnswer,
  };
}

function extractJsonStringField(value: string, keys: string[]) {
  for (const key of keys) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"|[}\\]])`);
    const match = value.match(pattern);
    if (!match?.[1]) continue;
    const decoded = decodeJsonStringFragment(match[1]);
    if (decoded.trim()) return decoded;
  }
  return "";
}

function decodeJsonStringFragment(value: string) {
  try {
    return sanitizeText(JSON.parse(`"${value.replace(/"/g, '\\"')}"`));
  } catch {
    return sanitizeText(
      value
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\"),
    );
  }
}

function extractMarkdownTailFromCodexBlob(value: string) {
  const starts = ["**1.", "## ", "### ", "$$"];
  const first = starts
    .map((marker) => value.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (first === undefined) return "";

  return decodeJsonStringFragment(value.slice(first))
    .replace(/If you upload the remaining pages[\s\S]*$/i, "")
    .replace(/Need the next page[\s\S]*$/i, "")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonObjectFromText(value: string) {
  const cleaned = sanitizeText(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readLooseString(record: Record<string, unknown>, keys: string[]) {
  const entries = Object.entries(record).map(([key, value]) => [
    normalizeFieldKey(key),
    value,
  ] as const);

  for (const key of keys) {
    const value =
      typeof record[key] === "string"
        ? record[key]
        : entries.find(([entryKey]) => entryKey === normalizeFieldKey(key))?.[1];
    if (typeof value === "string" && value.trim()) {
      return sanitizeText(value);
    }
  }

  return "";
}

function needsLatexRepair(result: ProviderArtifact) {
  return (
    result.finalAnswer.trim() === "align*" ||
    /(?:^|\n)align\*\s*(?:\n|$)/.test(result.stepByStep) ||
    /M_xxyI_x|M_yyxI_yy|_\s*&=/.test(result.stepByStep)
  );
}

function shouldPreferLatexDisplay(solution: StructuredSolution) {
  return (
    solution.final_answer.trim() === "align*" ||
    /(?:^|\n)align\*\s*(?:\n|$)/.test(solution.step_by_step) ||
    /M_xxyI_x|M_yyxI_yy|_\s*&=/.test(solution.step_by_step)
  );
}

// ---------------------------------------------------------------------------
// LaTeX helpers
// ---------------------------------------------------------------------------

function stripLatexDocument(value: string) {
  return value
    .replace(/\\documentclass[\s\S]*?\\begin\{document\}/, "")
    .replace(/\\end\{document\}\s*$/, "")
    .trim();
}

export function latexBodyToDisplayMarkdown(latexBody: string) {
  const body = stripCodeFence(stripLatexDocument(latexBody));
  if (!body.trim()) return "";

  return body
    .replace(/\\section\*\{([^}]*)\}/g, "\n## $1\n")
    .replace(/\\subsection\*\{([^}]*)\}/g, "\n### $1\n")
    .replace(/\\textbf\{([^}]*)\}/g, "**$1**")
    .replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, content: string) =>
      `\n$$\n\\begin{aligned}\n${normalizeLatexMathBlock(content)}\n\\end{aligned}\n$$\n`,
    )
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) =>
      `\n$$\n${normalizeLatexMathBlock(content)}\n$$\n`,
    )
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `$${content.trim()}$`)
    .replace(/\\begin\{itemize\}/g, "\n")
    .replace(/\\end\{itemize\}/g, "\n")
    .replace(/\\item\s+/g, "- ")
    .replace(/\\mathrm\{([^}]*)\}/g, "\\text{$1}")
    .replace(/\\,/g, " ")
    .replace(/~+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLatexMathBlock(value: string) {
  return value
    .replace(/\\\\\s*/g, "\\\\\n")
    .replace(/\\,/g, " ")
    .trim();
}

function extractFinalAnswerFromLatexDisplay(display: string) {
  const finalMatch = display.match(/\*\*Final answers?:\*\*([\s\S]*)$/i);
  const source = finalMatch?.[1]?.trim() || display;
  const mathBlocks = Array.from(source.matchAll(/\$\$([\s\S]*?)\$\$/g))
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
  const sigmaBlock = mathBlocks.find((block) => /sigma/i.test(block));
  if (sigmaBlock) {
    return `$$\n${sigmaBlock}\n$$`;
  }
  const lastBlock = mathBlocks.at(-1);
  if (lastBlock) {
    return `$$\n${lastBlock}\n$$`;
  }
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join("\n");
}

function extractInterpretedProblemFromLatexDisplay(display: string) {
  const firstHeading = display.search(/^### /m);
  const intro = firstHeading >= 0 ? display.slice(0, firstHeading) : display;
  return intro.replace(/^## .+\n/, "").trim();
}

export function stripCodeFence(value: string) {
  return value
    .replace(/^```(?:latex)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\\begin\{document\}/g, "")
    .replace(/\\end\{document\}/g, "")
    .replace(/\\documentclass[\s\S]*?\\begin\{document\}/g, "")
    .replace(/\\n/g, "\n")
    .trim();
}

function escapeLatex(value: string) {
  return value
    .replace(/Σ/g, "sum")
    .replace(/Δ/g, "Delta")
    .replace(/θ/g, "theta")
    .replace(/π/g, "pi")
    .replace(/×/g, "x")
    .replace(/−/g, "-")
    .replace(/·/g, ".")
    .replace(/✓/g, "check")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

function markdownToLatex(text: string) {
  return escapeLatex(text)
    .replace(/^### (.+)$/gm, "\\subsection*{$1}")
    .replace(/^## (.+)$/gm, "\\section*{$1}")
    .replace(/^\- (.+)$/gm, "\\begin{itemize}\n\\item $1\n\\end{itemize}")
    .replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
}

export function buildLatexFallback(solution: StructuredSolution) {
  return [
    `\\section*{${escapeLatex(solution.title || "Civil engineering solution")}}`,
    "\\subsection*{Interpreted Problem}",
    markdownToLatex(solution.interpreted_problem || "Unavailable."),
    "\\subsection*{Assumptions}",
    markdownToLatex(solution.assumptions || "None."),
    "\\subsection*{Solution}",
    markdownToLatex(solution.step_by_step || "Unavailable."),
    "\\subsection*{Final Answer}",
    markdownToLatex(solution.final_answer || "Unavailable."),
  ].join("\n\n");
}

function hasMeaningfulContent(value: string, minimumLength = 10) {
  return (
    value.trim().length >= minimumLength &&
    !/unavailable/i.test(value) &&
    !/not available/i.test(value)
  );
}

/**
 * A field the model left as a template slot instead of filling it:
 * "PLACEHOLDER_ASSUMPTIONS", "[TODO]", "<step_by_step>", "...". Seen on MiMo
 * on 25 September 2026: the problem statement written out, and assumptions,
 * working and answer returned as PLACEHOLDER_* tokens - valid JSON, every
 * field a string, so nothing downstream noticed.
 */
export function isPlaceholderText(value: string) {
  const text = value.trim();
  if (!text) return false;
  return (
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(text) ||
    /^[[<{(]?\s*(?:placeholder|todo|tbd|to be (?:filled|completed|added)(?: in)?|fill(?:ed)? in(?: later)?)\s*[\]>})]?\.?$/i.test(text) ||
    /^<[a-z_ ]+>$/i.test(text) ||
    /^(?:\.{3}|…)$/.test(text)
  );
}

// ---------------------------------------------------------------------------
// Finalization: raw model text -> normalized ProviderArtifact
// ---------------------------------------------------------------------------

/**
 * Flattens a solution into the text a judge reads (see /api/judge). The
 * LaTeX body is left out - it duplicates the working - and the whole thing
 * is capped at `limit` characters with the working kept ahead of the tail,
 * so a runaway solution still hands the judge its reading and its answer.
 */
export function artifactToText(artifact: ProviderArtifact, limit = Infinity) {
  const head = [
    `Interpreted problem:\n${artifact.interpretedProblem}`,
    artifact.assumptions ? `Assumptions:\n${artifact.assumptions}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const answer = `Final answer:\n${artifact.finalAnswer}`;
  const budget = limit - head.length - answer.length - 24;
  let working = `Solution:\n${artifact.stepByStep}`;
  if (working.length > budget) {
    working = budget > 80 ? `${working.slice(0, budget - 16)}\n[... cut ...]` : "";
  }
  return [head, working, answer].filter(Boolean).join("\n\n").trim();
}

export function finalizeProviderArtifact(
  provider: ProviderKey,
  rawText: string,
  options: ParseOptions = {},
): ProviderArtifact {
  let solution = parseStructuredSolution(rawText, provider, options);
  // Every field, latex_body included: a doubly escaped line break is no more
  // use to LaTeX than to Markdown.
  solution = Object.fromEntries(
    Object.entries(solution).map(([field, text]) => [field, fixEscapedNewlines(text)]),
  ) as StructuredSolution;

  // Template slots left unfilled. If the working went into latex_body
  // instead, it is rebuilt from there below; if it went nowhere, this is not
  // a solution, and no amount of leniency on a last attempt makes it one.
  const unfilled = (["step_by_step", "final_answer"] as const).filter((field) =>
    isPlaceholderText(solution[field]),
  );
  const latexHasWorking =
    stripCodeFence(solution.latex_body).trim().length >= 200 && !isPlaceholderText(solution.latex_body);
  if (unfilled.length && !latexHasWorking) {
    throw new Error(
      `${PROVIDER_LABELS[provider]} returned a blank template (${solution[unfilled[0]].trim().slice(0, 40)}) instead of a solution.`,
    );
  }
  for (const field of Object.keys(solution) as Array<keyof StructuredSolution>) {
    if (isPlaceholderText(solution[field])) solution = { ...solution, [field]: "" };
  }

  let latexBody = stripCodeFence(solution.latex_body).trim();
  if (latexBody.length < 24) {
    latexBody = buildLatexFallback(solution);
  }

  const displayFromLatex = latexBodyToDisplayMarkdown(latexBody);
  if (displayFromLatex && (unfilled.length || shouldPreferLatexDisplay(solution))) {
    solution = {
      ...solution,
      interpreted_problem:
        extractInterpretedProblemFromLatexDisplay(displayFromLatex) ||
        solution.interpreted_problem,
      step_by_step: displayFromLatex,
      final_answer:
        extractFinalAnswerFromLatexDisplay(displayFromLatex) ||
        solution.final_answer,
    };
  }

  const interpretedProblem = hasMeaningfulContent(solution.interpreted_problem, 30)
    ? sanitizeText(solution.interpreted_problem)
    : "See the uploaded problem materials.";

  let artifact: ProviderArtifact = {
    title: sanitizeText(solution.title || `${PROVIDER_LABELS[provider]} solution`),
    interpretedProblem,
    assumptions: sanitizeText(solution.assumptions),
    stepByStep: sanitizeText(solution.step_by_step),
    finalAnswer: sanitizeText(solution.final_answer),
    latexBody,
  };

  artifact = normalizeProviderArtifact(repairCodexJsonBlob(artifact) || artifact);

  if (needsLatexRepair(artifact) && displayFromLatex) {
    artifact = normalizeProviderArtifact({
      ...artifact,
      interpretedProblem:
        extractInterpretedProblemFromLatexDisplay(displayFromLatex) ||
        artifact.interpretedProblem,
      stepByStep: displayFromLatex,
      finalAnswer:
        extractFinalAnswerFromLatexDisplay(displayFromLatex) ||
        artifact.finalAnswer,
    });
  }

  return artifact;
}
