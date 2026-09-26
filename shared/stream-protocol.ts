// App-level SSE protocol for POST /api/solve, /api/interpret and /api/judge.
// The Worker translates upstream provider streams into these events so the
// client is agnostic to whether the upstream call streamed or not.

import type { InterpretationResult } from "./interpretation";
import type { JudgementResult } from "./judgement";
import type { EffortKey } from "./prompt";
import type { ModelVariant } from "./providers";
import type { ProviderArtifact } from "./solution";

export type SolveRequestBody = {
  images: string[]; // data:image/...;base64,... (uploads + rasterized PDF pages)
  notes: string;
  effort: EffortKey;
  /** Human-confirmed problem statement from the optional interpretation pass. */
  interpretation?: string;
  /** Lecture notes, sent for method reference only — never solved. */
  referenceText?: string;
  referenceImages?: string[];
  /** Which of the provider's models, when it offers several (Gemini: flash or pro). */
  variant?: ModelVariant;
};

export type InterpretRequestBody = {
  mode: "interpret" | "verify";
  images: string[];
  notes: string;
  /** Verify mode: the two candidate interpretations to reconcile. */
  interpretations?: [string, string];
  /** Reasoning level. Defaults to "medium" for readers and "max" for the judge. */
  effort?: EffortKey;
  /** Which of the provider's models, when it offers several. */
  variant?: ModelVariant;
};

/**
 * Answer cross-check: the selected solvers' solutions for a judge to grade
 * against the same images. The solutions are anonymised as A, B, C, D in
 * order - the judge never learns which provider wrote which.
 */
export type JudgeRequestBody = {
  images: string[];
  notes: string;
  /** Human-confirmed problem statement from the optional interpretation pass. */
  interpretation?: string;
  /** Two to MAX_JUDGED_SOLUTIONS candidate solutions, as text (see `artifactToText`). */
  solutions: string[];
  /** Reasoning level. Defaults to "high" - the most reliable level measured. */
  effort?: EffortKey;
  /** Which of the provider's models, when it offers several. */
  variant?: ModelVariant;
};

/**
 * The first event of every job's stream (worker/jobs.ts), on the first
 * connection and on every re-attach. Times are the server's clock, in ms;
 * `now` lets the page correct for its own clock being off, so the elapsed
 * time it shows is the job's, not the phone's.
 */
export type JobEvent = {
  type: "job";
  id: string;
  /** When the job started. */
  startedAt?: number;
  /** When the job gives up: startedAt plus its timeout (see taskTimeoutMs). */
  deadlineAt?: number;
  /** The server's clock when this event was sent. */
  now?: number;
};

// Through a job, `status`, `done` and `error` carry `at`, the server time
// they happened, so a page that re-attaches can place replayed statuses on
// the same timeline. An error carries `timedOut` when the task ran out of
// time rather than failing.
export type SolveEvent =
  | { type: "status"; message: string; at?: number }
  | { type: "delta"; text: string }
  | { type: "done"; solution: ProviderArtifact; at?: number; model?: string }
  | { type: "error"; message: string; at?: number; timedOut?: boolean };

export type InterpretEvent =
  | { type: "status"; message: string; at?: number }
  | { type: "delta"; text: string }
  | { type: "done"; interpretation: InterpretationResult; at?: number }
  | { type: "error"; message: string; at?: number; timedOut?: boolean };

export type JudgeEvent =
  | { type: "status"; message: string; at?: number }
  | { type: "delta"; text: string }
  | { type: "done"; judgement: JudgementResult; at?: number }
  | { type: "error"; message: string; at?: number; timedOut?: boolean };

/** "45 s", "4 min 40 s", "20 min" - a length of time as a person reads it. */
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds} s`;
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export const MAX_IMAGES = 16;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const MAX_REFERENCE_IMAGES = 8;
export const MAX_REFERENCE_TEXT = 20_000;
export const MAX_INTERPRETATION_LENGTH = 8_000;
/** Per candidate solution sent to the judge; longer ones are cut, working first. */
export const MAX_SOLUTION_TEXT = 24_000;

export const DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * Upper bound on the encoded request body, without building it.
 *
 * The browser sends one copy of this payload per selected provider, and the
 * Worker parses the whole thing before it can validate anything, so it is
 * worth refusing an oversized upload client-side rather than firing several
 * doomed requests.
 *
 * Data URLs are ASCII, so one character is one byte. Notes may be any script;
 * three bytes per character covers UTF-8 plus JSON escaping.
 */
export function estimateBodyBytes(body: {
  images: string[];
  notes: string;
  interpretation?: string;
  referenceText?: string;
  referenceImages?: string[];
  solutions?: string[];
}) {
  let total = 128; // envelope and field names
  for (const image of [...body.images, ...(body.referenceImages || [])]) {
    total += image.length + 3; // quotes + separator
  }
  const text =
    body.notes +
    (body.interpretation || "") +
    (body.referenceText || "") +
    (body.solutions ? body.solutions.join("") : "");
  return total + text.length * 3;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Added to the timeout for each assignment page after the first. */
export const PER_EXTRA_PAGE_MS = 120_000;
/**
 * Ceiling on a scaled timeout, whatever the page count. Long enough for a
 * full paper, short enough that a wedged upstream cannot hold a tab open
 * all day - the heartbeats would keep it alive indefinitely otherwise.
 */
export const MAX_TIMEOUT_MS = 2_700_000;

/**
 * How long one task may run, given how much was uploaded.
 *
 * A single question is the case every measured timing came from (the hardest
 * fixture answers in 14-259 s depending on model and level), so `baseMs` is
 * the floor and applies to a one-page upload. A whole exam paper is not one
 * long question but a dozen of them in one request, and both the reading and
 * the writing grow with it, so each further page adds `PER_EXTRA_PAGE_MS`.
 *
 * Lecture-notes pages count half: they are read once as reference and never
 * solved, so they add reading time but no answers.
 */
export function taskTimeoutMs(
  baseMs: number,
  imageCount: number,
  referenceImageCount = 0,
) {
  const pages = imageCount + referenceImageCount / 2;
  const scaled = baseMs + Math.max(0, pages - 1) * PER_EXTRA_PAGE_MS;
  return Math.max(baseMs, Math.min(scaled, MAX_TIMEOUT_MS));
}
