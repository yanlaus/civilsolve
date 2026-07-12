const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const POE_RESPONSES_URL = "https://api.poe.com/v1/responses";
const REQUEST_TIMEOUT = 240000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

import { callZo } from "./zo-api";

export type ProviderKey = "codex" | "claude" | "gemini";

export type StructuredSolution = {
  title: string;
  interpreted_problem: string;
  assumptions: string;
  step_by_step: string;
  final_answer: string;
  latex_body: string;
};

const PROVIDER_LABELS: Record<ProviderKey, string> = {
  codex: "ChatGPT Codex",
  claude: "Claude Sonnet",
  gemini: "Gemini Pro",
};

const PROVIDER_MODELS: Record<ProviderKey, string> = {
  codex: process.env.OPENAI_MODEL || "gpt-5.2-codex",
  claude: process.env.POE_CLAUDE_MODEL || "Claude-Sonnet-4.6",
  gemini: process.env.POE_GEMINI_MODEL || "Gemini-3.1-Pro",
};

const DEFAULT_ZO_CODEX_MODEL = "byok:5cc41ec1-6b63-4f83-897a-2c15e958361d";

const solutionSchema = {
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number) {
  return RETRY_DELAY * 2 ** attempt;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      /aborted|timed out|timeout/i.test(error.message))
  );
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function normalizeEffort(effort: string) {
  switch (effort) {
    case "none":
      return "none";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
    default:
      return "medium";
  }
}

type ProviderHealth = {
  configured: boolean;
  source?: string;
  warning?: string;
  message?: string;
};

function getTrimmedEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function looksLikePoeKey(value: string) {
  return value.startsWith("sk-poe-");
}

function looksLikeJwt(value: string) {
  return value.split(".").length === 3;
}

function getCodexDirectKey() {
  const apiKey = getTrimmedEnv("CODEX_API_KEY") || getTrimmedEnv("OPENAI_API_KEY");
  if (!apiKey) return null;
  if (looksLikePoeKey(apiKey)) {
    return {
      usable: false as const,
      reason:
        "OPENAI_API_KEY currently contains a Poe key, so direct OpenAI Codex calls would fail.",
    };
  }
  if (looksLikeJwt(apiKey) && !apiKey.startsWith("sk-")) {
    return {
      usable: false as const,
      reason:
        "OPENAI_API_KEY currently contains a Zo identity token, not an OpenAI API key.",
    };
  }
  return { usable: true as const, apiKey };
}

function getPoeApiKey() {
  const apiKey = getTrimmedEnv("POE_API_KEY");
  if (!apiKey) return null;
  if (!looksLikePoeKey(apiKey)) {
    return {
      usable: false as const,
      reason:
        "POE_API_KEY is present but does not look like a Poe API key.",
    };
  }
  return { usable: true as const, apiKey };
}

export function getProviderHealth(): Record<ProviderKey, ProviderHealth> {
  const codexKey = getCodexDirectKey();
  const zoToken = getTrimmedEnv("ZO_CLIENT_IDENTITY_TOKEN");
  const poeKey = getPoeApiKey();

  return {
    codex:
      codexKey?.usable
        ? { configured: true, source: "openai" }
        : zoToken
          ? {
              configured: true,
              source: "zo",
              warning: codexKey?.reason,
            }
          : {
              configured: false,
              message:
                codexKey?.reason ||
                "Codex is unavailable because neither a valid OpenAI key nor ZO_CLIENT_IDENTITY_TOKEN is available.",
            },
    claude: poeKey?.usable
      ? { configured: true, source: "poe" }
      : {
          configured: false,
          message: poeKey?.reason || "POE_API_KEY is not configured on the server.",
        },
    gemini: poeKey?.usable
      ? { configured: true, source: "poe" }
      : {
          configured: false,
          message: poeKey?.reason || "POE_API_KEY is not configured on the server.",
        },
  };
}

function extractTextOutput(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as Record<string, unknown>;
      if (typeof piece.text === "string" && piece.text.trim()) {
        texts.push(piece.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function normalizeJsonCandidate(rawText: string) {
  const trimmed = stripUnsafeCharacters(rawText).trim();
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

function parseStructuredSolution(rawText: string, provider: ProviderKey): StructuredSolution {
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
  const bestEffort = normalizeStructuredSolution(record);
  if (bestEffort) {
    return bestEffort;
  }

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
  const text = stripUnsafeCharacters(rawText);
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
    final_answer: stripUnsafeCharacters(finalMatch?.[1] || text.split("\n").filter(Boolean).at(-1) || "See worked solution."),
    latex_body: "",
  };
}

function coerceStructuredSolution(value: unknown): StructuredSolution | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return normalizeStructuredSolution(value as Record<string, unknown>);
}

function stripUnsafeCharacters(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u0015/g, " x ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
      return stripUnsafeCharacters(value);
    }
  }
  return "";
}

function normalizeFieldKey(value: string) {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function readNestedString(record: Record<string, unknown>, path: string[]) {
  let value: unknown = record;
  for (const key of path) {
    if (!value || typeof value !== "object") return "";
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.trim()
    ? stripUnsafeCharacters(value)
    : "";
}

function formatSteps(value: unknown) {
  if (!Array.isArray(value)) return "";
  const items = value
    .map((entry) => (typeof entry === "string" ? stripUnsafeCharacters(entry) : ""))
    .filter(Boolean);
  if (!items.length) return "";
  return items.map((entry, index) => `${index + 1}. ${entry}`).join("\n");
}

function formatStringArray(value: unknown) {
  if (!Array.isArray(value)) return "";
  const items = value
    .map((entry) => (typeof entry === "string" ? stripUnsafeCharacters(entry) : ""))
    .filter(Boolean);
  if (!items.length) return "";
  return items.map((entry) => `- ${entry}`).join("\n");
}

function readStringArray(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? stripUnsafeCharacters(entry) : ""))
    .filter(Boolean);
}

function formatObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        return stripUnsafeCharacters(`${key} = ${String(entry)}`);
      }
      return "";
    })
    .filter(Boolean);
  return entries.join("\n");
}

async function callResponsesApi(
  provider: ProviderKey,
  input: string,
  options?: {
    effort?: string;
    instructions?: string;
  },
) {
  if (provider === "codex") {
    return callCodex(provider, input, options);
  }

  const poeKey = getPoeApiKey();
  if (!poeKey?.usable) {
    throw new Error(poeKey?.reason || "POE_API_KEY is not configured on the server.");
  }

  const url = POE_RESPONSES_URL;
  const apiKey = poeKey.apiKey;
  const model = PROVIDER_MODELS[provider];
  const body: Record<string, unknown> = {
    model,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "civil_solution",
        strict: true,
        schema: solutionSchema,
      },
    },
  };

  if (options?.instructions) {
    body.instructions = options.instructions;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => {
        controller.abort(
          new Error(
            `${PROVIDER_LABELS[provider]} timed out after ${Math.round(REQUEST_TIMEOUT / 1000)} seconds.`,
          ),
        );
      }, REQUEST_TIMEOUT);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }

      const errorText = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${errorText}`);
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isAbortError(lastError) && attempt === MAX_RETRIES - 1) break;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(getRetryDelay(attempt));
    }
  }

  throw new Error(
    `All ${MAX_RETRIES} retry attempts failed. Last error: ${lastError?.message || "Unknown error"}`,
  );
}

async function callCodex(
  provider: ProviderKey,
  input: string,
  options?: {
    effort?: string;
    instructions?: string;
  },
) {
  const codexKey = getCodexDirectKey();
  if (codexKey?.usable) {
    return callOpenAiResponsesApi(provider, codexKey.apiKey, input, options);
  }

  const zoToken = getTrimmedEnv("ZO_CLIENT_IDENTITY_TOKEN");
  if (zoToken) {
    if (codexKey?.reason) {
      console.warn(`[providers] ${codexKey.reason} Falling back to Zo's Codex channel.`);
    }
    const payload = await callZo(
      [
        options?.instructions || "Return JSON only. Follow the schema exactly.",
        `Requested reasoning effort: ${normalizeEffort(options?.effort || "medium")}.`,
        "",
        input,
      ].join("\n"),
      {
        token: zoToken,
        modelName: process.env.ZO_CODEX_MODEL || DEFAULT_ZO_CODEX_MODEL,
        outputFormat: solutionSchema as unknown as Record<string, unknown>,
      },
    );

    const normalizedOutput = normalizeZoCodexOutput(payload.output, input);
    if (normalizedOutput) {
      return {
        output_text: JSON.stringify(normalizedOutput),
      } as Record<string, unknown>;
    }

    if (payload.output && typeof payload.output === "object") {
      return {
        output_text: JSON.stringify(payload.output),
      } as Record<string, unknown>;
    }
    if (typeof payload.output === "string") {
      return { output_text: payload.output } as Record<string, unknown>;
    }
    return { output_text: JSON.stringify(payload.output ?? {}) } as Record<string, unknown>;
  }

  throw new Error(
    codexKey?.reason ||
      "OPENAI_API_KEY is not configured on the server, and Zo Codex fallback is unavailable.",
  );
}

function normalizeZoCodexOutput(output: unknown, prompt: string) {
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(normalizeJsonCandidate(output));
      return (
        coerceStructuredSolution(parsed) ||
        synthesizeStructuredSolutionFromLatex(parsed, prompt)
      );
    } catch {
      return null;
    }
  }
  return (
    coerceStructuredSolution(output) ||
    synthesizeStructuredSolutionFromLatex(output, prompt)
  );
}

function synthesizeStructuredSolutionFromLatex(
  value: unknown,
  prompt: string,
): StructuredSolution | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const latexBody = readStringField(record, ["latex_body"]);
  if (!latexBody) return null;

  return {
    title: "Worked Solution",
    interpreted_problem: extractProblemStatementFromPrompt(prompt),
    assumptions: "Assumptions were not explicitly stated.",
    step_by_step: latexToPlainText(latexBody),
    final_answer: extractFinalAnswerFromLatex(latexBody),
    latex_body: latexBody,
  };
}

function extractProblemStatementFromPrompt(prompt: string) {
  const match = prompt.match(/Extracted text:\n([\s\S]+)$/);
  return match?.[1]?.trim() || "See uploaded problem materials.";
}

function latexToPlainText(latex: string) {
  return latex
    .replace(/\\section\*\{([^}]*)\}/g, "\n## $1\n")
    .replace(/\\subsection\*\{([^}]*)\}/g, "\n### $1\n")
    .replace(/\\textbf\{([^}]*)\}/g, "**$1**")
    .replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/g, (_match, content: string) =>
      `\n$$\n\\begin{aligned}\n${content.trim()}\n\\end{aligned}\n$$\n`,
    )
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) => `\n$$\n${content.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `$${content.trim()}$`)
    .replace(/\\item/g, "-")
    .replace(/\\begin\{itemize\}|\\end\{itemize\}/g, "")
    .replace(/\\mathrm\{([^}]*)\}/g, "\\text{$1}")
    .replace(/\\,/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractFinalAnswerFromLatex(latex: string) {
  const boxed = latex.match(/\\boxed\{([^}]*)\}/);
  if (boxed?.[1]?.trim()) {
    return boxed[1].trim();
  }
  const text = latexToPlainText(latex);
  const finalMatch = text.match(/\*\*Final answers?:\*\*([\s\S]*)$/i);
  if (finalMatch?.[1]?.trim()) {
    return finalMatch[1].trim();
  }
  const mathBlocks = Array.from(text.matchAll(/\$\$([\s\S]*?)\$\$/g))
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
  const sigmaBlock = mathBlocks.find((block) => /sigma/i.test(block));
  if (sigmaBlock) {
    return `$$\n${sigmaBlock}\n$$`;
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || "See worked solution.";
}

async function callOpenAiResponsesApi(
  provider: ProviderKey,
  apiKey: string,
  input: string,
  options?: {
    effort?: string;
    instructions?: string;
  },
) {
  const url = OPENAI_RESPONSES_URL;
  const model = PROVIDER_MODELS[provider];
  const body: Record<string, unknown> = {
    model,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "civil_solution",
        strict: true,
        schema: solutionSchema,
      },
    },
  };

  if (options?.instructions) {
    body.instructions = options.instructions;
  }

  body.reasoning = {
    effort: normalizeEffort(options?.effort || "medium"),
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => {
        controller.abort(
          new Error(
            `${PROVIDER_LABELS[provider]} timed out after ${Math.round(REQUEST_TIMEOUT / 1000)} seconds.`,
          ),
        );
      }, REQUEST_TIMEOUT);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }

      const errorText = await response.text();
      lastError = new Error(`HTTP ${response.status}: ${errorText}`);
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isAbortError(lastError) && attempt === MAX_RETRIES - 1) break;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(getRetryDelay(attempt));
    }
  }

  throw new Error(
    `All ${MAX_RETRIES} retry attempts failed. Last error: ${lastError?.message || "Unknown error"}`,
  );
}

export async function solveWithProvider(
  provider: ProviderKey,
  prompt: string,
  effort: string,
) {
  const response = await callResponsesApi(provider, prompt, {
    effort,
    instructions:
      "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Use English for every user-facing field unless the user explicitly requests another language.",
  });
  const rawText = extractTextOutput(response);
  if (!rawText) {
    throw new Error(`${PROVIDER_LABELS[provider]} returned an empty response.`);
  }
  const parsed = parseStructuredSolution(rawText, provider);
  return {
    title: stripUnsafeCharacters(parsed.title || "Worked Solution"),
    interpreted_problem: stripUnsafeCharacters(parsed.interpreted_problem),
    assumptions: stripUnsafeCharacters(parsed.assumptions),
    step_by_step: stripUnsafeCharacters(parsed.step_by_step),
    final_answer: stripUnsafeCharacters(parsed.final_answer),
    latex_body: parsed.latex_body,
  };
}

export async function repairLatexWithProvider(
  provider: ProviderKey,
  prompt: string,
) {
  const response = await callResponsesApi(provider, prompt, {
    instructions:
      "Return JSON only. Do not wrap it in markdown fences. Follow the provided schema exactly. Use English for every user-facing field unless the user explicitly requests another language.",
  });
  const rawText = extractTextOutput(response);
  if (!rawText) {
    throw new Error(`${PROVIDER_LABELS[provider]} returned an empty repair response.`);
  }
  return parseStructuredSolution(rawText, provider);
}

export function getProviderLabel(provider: ProviderKey) {
  return PROVIDER_LABELS[provider];
}
