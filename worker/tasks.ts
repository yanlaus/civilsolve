// Request body -> RunTaskParams, for each model-calling endpoint.
//
// Shared by the Worker, which builds the task once to validate the request
// and answer a bad one with a 400 straight away, and by TaskJob (the Durable
// Object in jobs.ts), which builds it again to run it: a task carries
// functions (the prompt builder, `finalize`), so it cannot be sent to the
// Durable Object - the request body is, and both sides turn it into the same
// task here.

import {
  interpretationSchema,
  parseInterpretation,
  verifiedInterpretationSchema,
} from "../shared/interpretation";
import { judgementSchema, MAX_JUDGED_SOLUTIONS, parseJudgement } from "../shared/judgement";
import {
  buildInterpretPrompt,
  buildJudgePrompt,
  buildTutorPrompt,
  buildVerifyPrompt,
  INTERPRET_INSTRUCTIONS,
  isEffortKey,
  JUDGE_INSTRUCTIONS,
  SOLVE_INSTRUCTIONS,
  type EffortKey,
} from "../shared/prompt";
import {
  isProviderKey,
  isSolverKey,
  isVariantOf,
  PROVIDER_LABELS,
  PROVIDER_VARIANTS,
  type ModelVariant,
  type ProviderKey,
} from "../shared/providers";
import { finalizeProviderArtifact, solutionSchema } from "../shared/solution";
import {
  DATA_URL_PATTERN,
  MAX_IMAGES,
  MAX_INTERPRETATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_TEXT,
  MAX_SOLUTION_TEXT,
} from "../shared/stream-protocol";
import { interpretOverride, variantOverride, type WorkerEnv } from "./channels";
import type { RunTaskParams } from "./run";

export type TaskKind = "solve" | "interpret" | "judge";

export const TASK_KINDS: TaskKind[] = ["solve", "interpret", "judge"];

export function isTaskKind(value: string): value is TaskKind {
  return (TASK_KINDS as string[]).includes(value);
}

export type BuiltTask = { params: RunTaskParams } | { error: string; status: 400 | 404 };

type ImagesResult = { images: string[] } | { error: string };

function readImages(value: unknown, max: number, label: string): ImagesResult {
  const images = Array.isArray(value) ? value : [];
  if (images.length > max) {
    return { error: `Provide at most ${max} ${label}.` };
  }
  for (const image of images) {
    if (typeof image !== "string" || !DATA_URL_PATTERN.test(image)) {
      return { error: `${label} must be JPEG/PNG/WebP/GIF data URLs.` };
    }
  }
  return { images: images as string[] };
}

function readText(value: unknown, limit: number) {
  return typeof value === "string" ? value.slice(0, limit).trim() : "";
}

/** The assignment images every task needs: 1 to MAX_IMAGES data URLs. */
function readAssignment(body: Record<string, unknown>): ImagesResult {
  const assignment = readImages(body.images, MAX_IMAGES, "Images");
  if ("error" in assignment) return assignment;
  if (assignment.images.length < 1) {
    return { error: `Provide between 1 and ${MAX_IMAGES} images.` };
  }
  return assignment;
}

export function buildTask(
  kind: TaskKind,
  providerName: string,
  body: Record<string, unknown>,
  env: WorkerEnv,
): BuiltTask {
  if (!isProviderKey(providerName)) return { error: "Unknown provider.", status: 404 };
  if (kind === "solve" && !isSolverKey(providerName)) {
    return {
      error: `${PROVIDER_LABELS[providerName]} reads questions and judges answers, but does not solve.`,
      status: 400,
    };
  }
  // Which of the provider's models to run, when it offers several (Gemini:
  // "flash" or "pro"). Absent means its default.
  const variant = body.variant;
  if (variant !== undefined && !isVariantOf(providerName, variant)) {
    const offered = PROVIDER_VARIANTS[providerName]?.map((entry) => entry.key).join(", ");
    return {
      error: offered
        ? `${PROVIDER_LABELS[providerName]} offers these models: ${offered}.`
        : `${PROVIDER_LABELS[providerName]} offers only one model.`,
      status: 400,
    };
  }
  if (kind === "solve") return buildSolve(providerName, body, env, variant);
  if (kind === "interpret") return buildInterpret(providerName, body, env, variant);
  return buildJudge(providerName, body, env, variant);
}

function buildSolve(
  provider: ProviderKey,
  body: Record<string, unknown>,
  env: WorkerEnv,
  variant?: ModelVariant,
): BuiltTask {
  const assignment = readAssignment(body);
  if ("error" in assignment) return { error: assignment.error, status: 400 };

  const reference = readImages(body.referenceImages, MAX_REFERENCE_IMAGES, "Lecture-notes images");
  if ("error" in reference) return { error: reference.error, status: 400 };

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "medium";
  const interpretation = readText(body.interpretation, MAX_INTERPRETATION_LENGTH);
  const referenceText = readText(body.referenceText, MAX_REFERENCE_TEXT);

  return {
    params: {
      provider,
      env,
      effort,
      routeOverride: variantOverride(provider, variant, env),
      task: {
        session: crypto.randomUUID(),
        prompt: ({ enforceShape, effort: effective }) =>
          buildTutorPrompt(notes, effective, {
            enforceShape,
            interpretation: interpretation || undefined,
            referenceText: referenceText || undefined,
            hasReferenceImages: reference.images.length > 0,
          }),
        instructions: SOLVE_INSTRUCTIONS,
        schemaName: "civil_solution",
        schema: solutionSchema as unknown as Record<string, unknown>,
        images: assignment.images,
        referenceImages: reference.images,
      },
      finalize: (rawText, { lastAttempt }) => ({
        solution: finalizeProviderArtifact(provider, rawText, { allowIncomplete: lastAttempt }),
      }),
    },
  };
}

function buildInterpret(
  provider: ProviderKey,
  body: Record<string, unknown>,
  env: WorkerEnv,
  variant?: ModelVariant,
): BuiltTask {
  const assignment = readAssignment(body);
  if ("error" in assignment) return { error: assignment.error, status: 400 };

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const mode = body.mode === "verify" ? "verify" : "interpret";
  const requestedEffort: EffortKey | null =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : null;

  let buildPrompt: (options: { enforceShape: boolean }) => string;
  if (mode === "verify") {
    const interpretations = Array.isArray(body.interpretations) ? body.interpretations : [];
    const [a, b] = interpretations;
    if (typeof a !== "string" || typeof b !== "string" || !a.trim() || !b.trim()) {
      return { error: "Verify mode needs two interpretations.", status: 400 };
    }
    buildPrompt = (options) =>
      buildVerifyPrompt(
        notes,
        a.slice(0, MAX_INTERPRETATION_LENGTH),
        b.slice(0, MAX_INTERPRETATION_LENGTH),
        options,
      );
  } else {
    buildPrompt = (options) => buildInterpretPrompt(notes, options);
  }

  return {
    params: {
      provider,
      env,
      // The interpretation pass pins some providers to routes chosen for it
      // (see interpretOverride) - unless the user picked a model themselves.
      routeOverride: variantOverride(provider, variant, env) ?? interpretOverride(provider, env),
      // Readers default to "medium" - they transcribe rather than derive, but
      // a whole exam paper is a lot of diagram to read carefully - and the
      // user can change it. The reconciler defaults to "high": at "max" the
      // ChatGPT reconciler thought for 204-324 s on B.8 and timed out the
      // owner's pass, while "high" took 69-75 s and kept every key fact of
      // the diagram in both runs (26 September 2026). The form sends each
      // model's level explicitly; these defaults are for callers that do not.
      effort: requestedEffort ?? (mode === "verify" ? "high" : "medium"),
      task: {
        session: crypto.randomUUID(),
        prompt: buildPrompt,
        instructions: INTERPRET_INSTRUCTIONS,
        // The reconciler also writes the reading in Traditional Chinese, for
        // the review step; the readers only need English.
        schemaName: mode === "verify" ? "civil_verified_interpretation" : "civil_interpretation",
        schema: (mode === "verify"
          ? verifiedInterpretationSchema
          : interpretationSchema) as unknown as Record<string, unknown>,
        images: assignment.images,
      },
      finalize: (rawText, { lastAttempt }) => ({
        interpretation: parseInterpretation(rawText, provider, { allowIncomplete: lastAttempt }),
      }),
    },
  };
}

// The answer cross-check: grades the selected solvers' solutions against the
// images. Runs on the provider's normal solve route - no override - so the
// judge is whatever the user picked, at the effort the most reliable solves
// used.
function buildJudge(
  provider: ProviderKey,
  body: Record<string, unknown>,
  env: WorkerEnv,
  variant?: ModelVariant,
): BuiltTask {
  const assignment = readAssignment(body);
  if ("error" in assignment) return { error: assignment.error, status: 400 };

  const candidates = Array.isArray(body.solutions) ? body.solutions : [];
  if (
    candidates.length < 2 ||
    candidates.length > MAX_JUDGED_SOLUTIONS ||
    candidates.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return {
      error: `The cross-check needs between 2 and ${MAX_JUDGED_SOLUTIONS} solutions.`,
      status: 400,
    };
  }
  const solutions = (candidates as string[]).map((entry) => entry.slice(0, MAX_SOLUTION_TEXT));

  const notes = readText(body.notes, MAX_NOTES_LENGTH);
  const interpretation = readText(body.interpretation, MAX_INTERPRETATION_LENGTH);
  const effort: EffortKey =
    typeof body.effort === "string" && isEffortKey(body.effort) ? body.effort : "high";

  return {
    params: {
      provider,
      env,
      effort,
      routeOverride: variantOverride(provider, variant, env),
      task: {
        session: crypto.randomUUID(),
        prompt: ({ enforceShape }) =>
          buildJudgePrompt(notes, solutions, {
            enforceShape,
            interpretation: interpretation || undefined,
          }),
        instructions: JUDGE_INSTRUCTIONS,
        schemaName: "civil_judgement",
        schema: judgementSchema as unknown as Record<string, unknown>,
        images: assignment.images,
      },
      finalize: (rawText, { lastAttempt }) => ({
        judgement: parseJudgement(rawText, provider, solutions.length, {
          allowIncomplete: lastAttempt,
        }),
      }),
    },
  };
}
