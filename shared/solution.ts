// Provider-agnostic solution parsing, repair, and display normalization.
// Pure string logic shared by the Worker (finalizing streamed responses)
// and the client (building .tex downloads).

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

function normalizeJsonCandidate(rawText: string) {
  const trimmed = sanitizeText(rawText);
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

export function parseStructuredSolution(
  rawText: string,
  provider: ProviderKey,
): StructuredSolution {
  let parsed: unknown;
  const jsonCandidate = normalizeJsonCandidate(rawText);
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch (error) {
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
  const text = sanitizeText(rawText);
  if (text.length < 40) {
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

function normalizeProblemsShape(record: Record<string, unknown>): StructuredSolution | null {
  const problems = record.problems;
  if (!Array.isArray(problems) || !problems.length) {
    return null;
  }

  const first = problems[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  const problem = first as Record<string, unknown>;
  const interpretedProblem =
    readStringField(problem, [
      "interpreted_problem",
      "interpretedProblem",
      "statement",
      "problem",
      "question",
      "problem_text",
    ]) || "";
  const finalAnswer =
    readStringField(problem, [
      "final_answer",
      "finalAnswer",
      "finalanswer",
      "answer",
      "result",
    ]) || "";

  const directStepByStep = readStringField(problem, [
    "step_by_step",
    "stepByStep",
    "stepbystep",
    "worked_solution",
    "solution_text",
  ]);

  const stepParts = [
    readNestedString(problem, ["solution", "formula"]),
    readNestedString(problem, ["solution", "substitution"]),
    readNestedString(problem, ["solution", "result"]),
    ...readStringArray(problem, "formula_substitution_result"),
  ].filter(Boolean);

  const given =
    formatStringArray(problem.given) ||
    formatStringArray(problem.given_information);
  const required = readStringField(problem, ["required", "required_quantity"]);
  const assumptions = [given ? `Given:\n${given}` : "", required ? `Required:\n${required}` : ""]
    .filter(Boolean)
    .join("\n\n") ||
    readStringField(problem, ["assumptions", "notes", "missing_data"]) ||
    "Assumptions were not explicitly stated.";

  if (!interpretedProblem || !finalAnswer || (!directStepByStep && !stepParts.length)) {
    return null;
  }

  const problemNumberLabel = readStringField(problem, ["problem_number"]) ||
    (typeof problem.problem_number === "number" ? String(problem.problem_number) : "");

  return {
    title: `Worked Solution${problemNumberLabel ? ` ${problemNumberLabel}` : ""}`.trim(),
    interpreted_problem: interpretedProblem,
    assumptions,
    step_by_step: directStepByStep || stepParts.map((part, index) => `${index + 1}. ${part}`).join("\n"),
    final_answer: finalAnswer,
    latex_body: readStringField(record, ["latex_body"]),
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

export function buildLatexDocument(latexBody: string) {
  return String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{textcomp}
\setlength{\parskip}{0.75em}
\setlength{\parindent}{0pt}
\begin{document}
` + latexBody + "\n\\end{document}\n";
}

function hasMeaningfulContent(value: string, minimumLength = 10) {
  return (
    value.trim().length >= minimumLength &&
    !/unavailable/i.test(value) &&
    !/not available/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// Finalization: raw model text -> normalized ProviderArtifact
// ---------------------------------------------------------------------------

export function finalizeProviderArtifact(
  provider: ProviderKey,
  rawText: string,
): ProviderArtifact {
  let solution = parseStructuredSolution(rawText, provider);

  let latexBody = stripCodeFence(solution.latex_body).trim();
  if (latexBody.length < 24) {
    latexBody = buildLatexFallback(solution);
  }

  const displayFromLatex = latexBodyToDisplayMarkdown(latexBody);
  if (displayFromLatex && shouldPreferLatexDisplay(solution)) {
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
