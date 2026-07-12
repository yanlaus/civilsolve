import { serveStatic } from "hono/bun";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";
import config from "./zosite.json";
import { Hono } from "hono";
import { mkdir, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getProviderLabel,
  getProviderHealth,
  type ProviderKey,
  type StructuredSolution,
  solveWithProvider,
} from "./backend-lib/providers";

type Mode = "development" | "production";

type ProviderArtifact = {
  title: string;
  interpretedProblem: string;
  assumptions: string;
  stepByStep: string;
  finalAnswer: string;
  downloads: {
    pdf: string;
    tex: string;
  };
};

function sanitizeText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u0015/g, " x ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeDownloadPath(value: string) {
  return /^\/api\/jobs\/[a-f0-9-]+\/(codex|claude|gemini)\/solution\.(pdf|tex)$/i.test(
    value,
  )
    ? value
    : "";
}

type ProviderResponse = ProviderArtifact | { error: string };

type StoredUpload = {
  originalName: string;
  mimeType: string;
  storedPath: string;
};

type ResultPayload = {
  id: string;
  extractedPreview: Array<{
    name: string;
    mimeType: string;
    excerpt: string;
  }>;
  providers: Partial<Record<ProviderKey, ProviderResponse>>;
};

type SolveJobStatus =
  | {
      id: string;
      status: "queued" | "running";
      message: string;
    }
  | {
      id: string;
      status: "complete";
      result: ResultPayload;
    }
  | {
      id: string;
      status: "error";
      error: string;
    };

const app = new Hono();
const JOBS_DIR = join(import.meta.dir, ".data", "jobs");
const MAX_FILES = 10;
const MAX_PDF_OCR_PAGES = 8;
const MAX_TEXT_PREVIEW = 12000;
const ALLOWED_EFFORTS = new Set(["none", "low", "medium", "high", "max"]);
const PROVIDERS: ProviderKey[] = ["codex", "claude", "gemini"];
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tif",
  ".tiff",
  ".gif",
  ".avif",
]);

const mode: Mode =
  process.env.NODE_ENV === "production" ? "production" : "development";

app.get("/api/hello-zo", (c) => c.json({ msg: "Hello from Zo" }));

app.get("/api/provider-health", (c) => c.json(getProviderHealth()));

app.post("/api/solve", async (c) => {
  try {
    await ensureJobsDir();

    const form = await c.req.formData();
    const files = form
      .getAll("files")
      .filter((value): value is File => value instanceof File && value.size > 0);
    const userNotes = String(form.get("notes") ?? "").trim();
    const requestedEffort = String(form.get("effort") ?? "low").toLowerCase();
    const effort = ALLOWED_EFFORTS.has(requestedEffort)
      ? requestedEffort
      : "low";
    const selectedProviders = parseRequestedProviders(form);

    if (files.length === 0) {
      return c.json({ error: "Upload at least one image or PDF." }, 400);
    }

    if (selectedProviders.length === 0) {
      return c.json({ error: "Choose at least one AI provider." }, 400);
    }

    if (files.length > MAX_FILES) {
      return c.json(
        { error: `You can upload up to ${MAX_FILES} files per attempt.` },
        400,
      );
    }

    const jobId = randomUUID();
    const jobDir = join(JOBS_DIR, jobId);
    const uploadDir = join(jobDir, "uploads");
    await mkdir(uploadDir, { recursive: true });

    const uploads: StoredUpload[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const extension = normalizeExtension(file.name, file.type);
      const mimeType = normalizeMimeType(file.name, file.type);
      const storedPath = join(uploadDir, `${index + 1}${extension}`);
      await Bun.write(storedPath, await file.arrayBuffer());
      uploads.push({
        originalName: file.name || `upload-${index + 1}${extension}`,
        mimeType,
        storedPath,
      });
    }

    await writeJobStatus(jobDir, {
      id: jobId,
      status: "queued",
      message: "Assignment uploaded. Preparing OCR and provider requests.",
    });

    void processSolveJob(jobId, jobDir, uploads, userNotes, effort, selectedProviders);

    return c.json(
      {
        id: jobId,
        status: "queued",
        message: `Assignment uploaded. ${formatProviderList(selectedProviders)} ${
          selectedProviders.length === 1 ? "is" : "are"
        } generating solutions.`,
      },
      202,
    );
  } catch (error) {
    console.error(error);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Unexpected server error.",
      },
      500,
    );
  }
});

app.get("/api/jobs/:jobId", async (c) => {
  const { jobId } = c.req.param();
  if (!isSafeJobId(jobId)) {
    return c.json({ error: "Invalid job id." }, 400);
  }

  const jobDir = join(JOBS_DIR, jobId);
  const resultFile = Bun.file(join(jobDir, "result.json"));
  if (await resultFile.exists()) {
    const result = (await resultFile.json()) as ResultPayload;
    return c.json({
      id: jobId,
      status: "complete",
      result: await enhanceResultPayload(jobDir, result),
    });
  }

  const statusFile = Bun.file(join(jobDir, "status.json"));
  if (await statusFile.exists()) {
    return c.json(await statusFile.json());
  }

  return c.json({ error: "Job not found." }, 404);
});

app.get("/api/jobs/:jobId/:provider/:filename", async (c) => {
  const { jobId, provider, filename } = c.req.param();
  if (!PROVIDERS.includes(provider as ProviderKey)) {
    return c.json({ error: "Unsupported provider." }, 404);
  }
  if (!["solution.pdf", "solution.tex"].includes(filename)) {
    return c.json({ error: "Unsupported file." }, 404);
  }

  const filePath = join(JOBS_DIR, jobId, provider, filename);
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return c.json({ error: "File not found." }, 404);
  }

  return new Response(file, {
    headers: {
      "Content-Type":
        filename.endsWith(".pdf") ? "application/pdf" : "application/x-tex",
      "Content-Disposition": `attachment; filename="${provider}-${filename}"`,
      "Cache-Control": "no-store",
    },
  });
});

if (mode === "production") {
  configureProduction(app);
} else {
  await configureDevelopment(app);
}

const port = process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : mode === "production"
    ? (config.publish?.published_port ?? config.local_port)
    : config.local_port;

console.info(
  `[startup] provider health ${JSON.stringify(getProviderHealth())}`,
);

export default { fetch: app.fetch, port, idleTimeout: 255 };

async function ensureJobsDir() {
  await mkdir(JOBS_DIR, { recursive: true });
}

function isSafeJobId(jobId: string) {
  return /^[a-f0-9-]{36}$/i.test(jobId);
}

function parseRequestedProviders(form: FormData): ProviderKey[] {
  const requested = form
    .getAll("providers")
    .map((value) => String(value).trim().toLowerCase())
    .filter((value): value is ProviderKey =>
      PROVIDERS.includes(value as ProviderKey),
    );

  const unique = [...new Set(requested)];
  return unique.length ? unique : PROVIDERS;
}

function formatProviderList(providers: ProviderKey[]) {
  return providers.map((provider) => getProviderLabel(provider)).join(", ");
}

async function writeJobStatus(jobDir: string, status: SolveJobStatus) {
  await Bun.write(join(jobDir, "status.json"), JSON.stringify(status, null, 2));
}

async function processSolveJob(
  jobId: string,
  jobDir: string,
  uploads: StoredUpload[],
  userNotes: string,
  effort: string,
  selectedProviders: ProviderKey[],
) {
  try {
    await writeJobStatus(jobDir, {
      id: jobId,
      status: "running",
      message: "Reading the uploaded assignment.",
    });

    const extractedDocuments: Array<{
      originalName: string;
      mimeType: string;
      extractedText: string;
    }> = [];

    for (const upload of uploads) {
      const extractedText = await extractProblemText(
        upload.storedPath,
        upload.mimeType,
        jobDir,
      );
      extractedDocuments.push({
        originalName: upload.originalName,
        mimeType: upload.mimeType,
        extractedText,
      });
    }

    await writeJobStatus(jobDir, {
      id: jobId,
      status: "running",
      message: `Asking ${formatProviderList(selectedProviders)}.`,
    });

    const prompt = buildTutorPrompt(extractedDocuments, userNotes, effort);
    const providerResults = await Promise.all(
      selectedProviders.map(async (provider) => {
        try {
          const solution = await solveWithProvider(provider, prompt, effort);
          const artifact = await materializeProviderResult(
            provider,
            solution,
            extractedDocuments,
            jobDir,
            jobId,
          );
          return [provider, artifact] as const;
        } catch (error) {
          return [
            provider,
            {
              error: sanitizeText(
                error instanceof Error ? error.message : "Unexpected provider error.",
              ),
            },
          ] as const;
        }
      }),
    );

    const providers = Object.fromEntries(providerResults) as Partial<Record<
      ProviderKey,
      ProviderResponse
    >>;

    const resultPayload: ResultPayload = {
      id: jobId,
      extractedPreview: extractedDocuments.map((document) => ({
        name: sanitizeText(document.originalName),
        mimeType: sanitizeText(document.mimeType),
        excerpt: sanitizeText(compactText(document.extractedText)).slice(0, MAX_TEXT_PREVIEW),
      })),
      providers,
    };

    await Bun.write(join(jobDir, "result.json"), JSON.stringify(resultPayload, null, 2));
    await writeJobStatus(jobDir, {
      id: jobId,
      status: "complete",
      result: resultPayload,
    });
  } catch (error) {
    const message = sanitizeText(
      error instanceof Error ? error.message : "Unexpected server error.",
    );
    console.error(`[solve-job:${jobId}]`, error);
    await writeJobStatus(jobDir, {
      id: jobId,
      status: "error",
      error: message,
    });
  }
}

function normalizeExtension(name: string, mimeType: string) {
  const byName = extname(name).toLowerCase();
  if (byName) return byName;
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/heic") return ".heic";
  if (mimeType === "image/heif") return ".heif";
  if (mimeType === "image/tiff") return ".tiff";
  if (mimeType === "image/avif") return ".avif";
  if (mimeType === "image/bmp") return ".bmp";
  if (mimeType === "image/gif") return ".gif";
  return ".bin";
}

function normalizeMimeType(name: string, mimeType: string) {
  if (mimeType) return mimeType;
  const extension = extname(name).toLowerCase();
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".heic") return "image/heic";
  if (extension === ".heif") return "image/heif";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  if (extension === ".avif") return "image/avif";
  if (extension === ".bmp") return "image/bmp";
  if (extension === ".gif") return "image/gif";
  return "application/octet-stream";
}

function compactText(value: string) {
  return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

async function extractProblemText(
  filePath: string,
  mimeType: string,
  jobDir: string,
) {
  if (mimeType === "application/pdf" || filePath.toLowerCase().endsWith(".pdf")) {
    return extractPdfText(filePath, jobDir);
  }
  if (isImageUpload(filePath, mimeType)) {
    return extractImageText(filePath, jobDir);
  }
  throw new Error("Only images and PDFs are supported.");
}

function isImageUpload(filePath: string, mimeType: string) {
  return mimeType.startsWith("image/") || IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function extractImageText(filePath: string, jobDir: string) {
  const normalizedPath = join(jobDir, `ocr-image-${randomUUID()}.png`);
  const normalized = await runCommand([
    "convert",
    filePath,
    "-auto-orient",
    "-strip",
    "-colorspace",
    "Gray",
    normalizedPath,
  ]);

  if (!normalized.ok) {
    throw new Error(
      `Could not process the uploaded image. Please use a clear photo or export it as JPG, PNG, HEIC, or PDF. ${normalized.stderr || normalized.stdout}`.trim(),
    );
  }

  const result = await runCommand([
    "tesseract",
    normalizedPath,
    "stdout",
    "-l",
    "eng",
    "--psm",
    "6",
  ]);
  if (!result.ok) {
    throw new Error(`OCR failed for image: ${result.stderr || result.stdout}`);
  }
  const text = compactText(result.stdout);
  if (!text) {
    throw new Error("The uploaded image did not produce readable text.");
  }
  return text;
}

async function extractPdfText(filePath: string, jobDir: string) {
  const direct = await runCommand(["pdftotext", "-layout", filePath, "-"]);
  const directText = compactText(direct.stdout);
  if (direct.ok && directText.length >= 80) {
    return directText;
  }

  const ocrDir = join(jobDir, `ocr-${randomUUID()}`);
  await mkdir(ocrDir, { recursive: true });
  const prefix = join(ocrDir, "page");
  const rasterized = await runCommand(["pdftoppm", "-png", filePath, prefix]);
  if (!rasterized.ok) {
    throw new Error(`Could not process PDF: ${rasterized.stderr || rasterized.stdout}`);
  }

  const pageFiles = (await readdir(ocrDir))
    .filter((name) => name.endsWith(".png"))
    .sort()
    .slice(0, MAX_PDF_OCR_PAGES);

  if (pageFiles.length === 0) {
    throw new Error("The PDF did not contain extractable pages.");
  }

  const pageTexts: string[] = [];
  for (const pageFile of pageFiles) {
    const pageText = await extractImageText(join(ocrDir, pageFile), jobDir);
    pageTexts.push(pageText);
  }

  const combined = compactText(pageTexts.join("\n\n"));
  if (!combined) {
    throw new Error("The PDF did not produce readable text.");
  }

  return combined;
}

function buildTutorPrompt(
  documents: Array<{ originalName: string; mimeType: string; extractedText: string }>,
  userNotes: string,
  effort: string,
) {
  const documentSections = documents
    .map((document, index) => {
      return [
        `Document ${index + 1}: ${document.originalName}`,
        `Mime type: ${document.mimeType}`,
        "Extracted text:",
        document.extractedText || "[No text extracted]",
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return [
    "Analyze the uploaded civil engineering assignment materials and solve every identifiable problem.",
    "Use a student-facing tone and keep the work clean and direct.",
    "Default response language: English. Return all user-facing fields in English unless the user explicitly asks for another language in the notes.",
    "Translate any non-English OCR text into English before writing the solution.",
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
    "",
    "Uploaded material:",
    documentSections,
  ].join("\n");
}

async function materializeProviderResult(
  provider: ProviderKey,
  solution: StructuredSolution,
  extractedDocuments: Array<{
    originalName: string;
    mimeType: string;
    extractedText: string;
  }>,
  jobDir: string,
  jobId: string,
): Promise<ProviderArtifact> {
  const providerDir = join(jobDir, provider);
  await mkdir(providerDir, { recursive: true });

  let latexBody = stripCodeFence(solution.latex_body).trim();
  if (latexBody.length < 24) {
    latexBody = buildLatexFallback(solution);
  }
  const texPath = join(providerDir, "solution.tex");
  const pdfPath = join(providerDir, "solution.pdf");
  let pdfDownloadPath = `/api/jobs/${jobId}/${provider}/solution.pdf`;

  const firstAttempt = await compileLatexDocument(providerDir, texPath, pdfPath, latexBody);
  if (!firstAttempt.ok) {
    latexBody = buildLatexFallback(solution);
    const secondAttempt = await compileLatexDocument(
      providerDir,
      texPath,
      pdfPath,
      latexBody,
    );
    if (!secondAttempt.ok) {
      pdfDownloadPath = "";
      console.error(
        `[pdf-export:${jobId}:${provider}] PDF export failed after fallback: ${
          secondAttempt.stderr || secondAttempt.stdout
        }`,
      );
    }
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

  const interpretedProblem = hasMeaningfulContent(
    solution.interpreted_problem,
    30,
  )
    ? sanitizeText(solution.interpreted_problem)
    : sanitizeText(compactText(extractedDocuments.map((document) => document.extractedText).join("\n\n")))
        .slice(0, 1200);

  return normalizeProviderArtifact({
    title: sanitizeText(solution.title || `${getProviderLabel(provider)} solution`),
    interpretedProblem,
    assumptions: sanitizeText(solution.assumptions),
    stepByStep: sanitizeText(solution.step_by_step),
    finalAnswer: sanitizeText(solution.final_answer),
    downloads: {
      pdf: sanitizeDownloadPath(pdfDownloadPath),
      tex: sanitizeDownloadPath(`/api/jobs/${jobId}/${provider}/solution.tex`),
    },
  });
}

async function enhanceResultPayload(jobDir: string, result: ResultPayload) {
  const providers = { ...result.providers };

  for (const provider of PROVIDERS) {
    const providerResult = providers[provider];
    if (!providerResult || "error" in providerResult) continue;
    providers[provider] = normalizeProviderArtifact(
      repairCodexJsonBlob(providerResult) || providerResult,
    );

    const repairedProviderResult = providers[provider];
    if (!repairedProviderResult || "error" in repairedProviderResult) continue;
    if (!needsLatexRepair(repairedProviderResult)) continue;

    const texFile = Bun.file(join(jobDir, provider, "solution.tex"));
    if (!(await texFile.exists())) continue;

    const display = latexBodyToDisplayMarkdown(await texFile.text());
    if (!display) continue;

    providers[provider] = {
      ...repairedProviderResult,
      interpretedProblem:
        extractInterpretedProblemFromLatexDisplay(display) ||
        repairedProviderResult.interpretedProblem,
      stepByStep: display,
      finalAnswer:
        extractFinalAnswerFromLatexDisplay(display) ||
        repairedProviderResult.finalAnswer,
    };
  }

  return { ...result, providers };
}

function normalizeProviderArtifact(result: ProviderArtifact): ProviderArtifact {
  return {
    ...result,
    title: normalizeDisplayText(result.title),
    interpretedProblem: normalizeDisplayText(result.interpretedProblem),
    assumptions: normalizeDisplayText(result.assumptions),
    stepByStep: normalizeDisplayText(result.stepByStep),
    finalAnswer: normalizeDisplayText(result.finalAnswer),
    downloads: {
      pdf: sanitizeDownloadPath(result.downloads.pdf),
      tex: sanitizeDownloadPath(result.downloads.tex),
    },
  };
}

function normalizeDisplayText(value: string) {
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

function repairCodexJsonBlob(result: ProviderArtifact): ProviderArtifact | null {
  const candidate = [result.stepByStep, result.assumptions, result.finalAnswer]
    .find((value) => /(^|[^{])\{[\s\S]*"problems"\s*:/.test(value));
  if (!candidate) return null;

  const parsed = parseJsonObjectFromText(candidate);
  if (!parsed || typeof parsed !== "object") {
    const repairedFromFragments = repairCodexJsonFragments(result, candidate);
    return repairedFromFragments;
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
    key.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase(),
    value,
  ] as const);

  for (const key of keys) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const value =
      typeof record[key] === "string"
        ? record[key]
        : entries.find(([entryKey]) => entryKey === normalizedKey)?.[1];
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

function stripLatexDocument(value: string) {
  return value
    .replace(/\\documentclass[\s\S]*?\\begin\{document\}/, "")
    .replace(/\\end\{document\}\s*$/, "")
    .trim();
}

function latexBodyToDisplayMarkdown(latexBody: string) {
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

function stripCodeFence(value: string) {
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

function buildLatexFallback(solution: StructuredSolution) {
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

function buildLatexDocument(latexBody: string) {
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

async function compileLatexDocument(
  jobDir: string,
  texPath: string,
  pdfPath: string,
  latexBody: string,
) {
  await Bun.write(texPath, buildLatexDocument(latexBody));
  const result = await runCommand(
    [
      "pdflatex",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-output-directory",
      jobDir,
      texPath,
    ],
    jobDir,
  );

  const pdfExists = await Bun.file(pdfPath).exists();
  return { ...result, ok: result.ok && pdfExists };
}

function hasMeaningfulContent(value: string, minimumLength = 10) {
  return (
    value.trim().length >= minimumLength &&
    !/unavailable/i.test(value) &&
    !/not available/i.test(value)
  );
}

async function runCommand(args: string[], cwd?: string) {
  const command = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);

  return {
    ok: exitCode === 0,
    stdout,
    stderr,
    exitCode,
  };
}

function configureProduction(app: Hono) {
  app.use("/assets/*", serveStatic({ root: "./dist" }));
  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 302));
  app.use(async (c, next) => {
    if (c.req.method !== "GET") return next();

    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/assets/")) return next();

    const file = Bun.file(`./dist${path}`);
    if (await file.exists()) {
      const stat = await file.stat();
      if (stat && !stat.isDirectory()) {
        return new Response(file);
      }
    }

    return serveStatic({ path: "./dist/index.html" })(c, next);
  });
}

async function configureDevelopment(app: Hono): Promise<ViteDevServer> {
  const vite = await createViteServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
  });

  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    if (c.req.path === "/favicon.ico") return c.redirect("/favicon.svg", 302);

    const url = c.req.path;
    try {
      if (url === "/" || url === "/index.html") {
        let template = await Bun.file("./index.html").text();
        template = await vite.transformIndexHtml(url, template);
        return c.html(template, {
          headers: { "Cache-Control": "no-store, must-revalidate" },
        });
      }

      const publicFile = Bun.file(`./public${url}`);
      if (await publicFile.exists()) {
        const stat = await publicFile.stat();
        if (stat && !stat.isDirectory()) {
          return new Response(publicFile, {
            headers: { "Cache-Control": "no-store, must-revalidate" },
          });
        }
      }

      let result;
      try {
        result = await vite.transformRequest(url);
      } catch {
        result = null;
      }

      if (result) {
        return new Response(result.code, {
          headers: {
            "Content-Type": "application/javascript",
            "Cache-Control": "no-store, must-revalidate",
          },
        });
      }

      let template = await Bun.file("./index.html").text();
      template = await vite.transformIndexHtml("/", template);
      return c.html(template, {
        headers: { "Cache-Control": "no-store, must-revalidate" },
      });
    } catch (error) {
      vite.ssrFixStacktrace(error as Error);
      console.error(error);
      return c.text("Internal Server Error", 500);
    }
  });

  return vite;
}
