// Course method guides (14 November 2026, the owner's request): for a
// question whose subject is known (shared/subjects.ts), the course's guide -
// distilled once from its lecture notes - goes first in the instructions of
// every solve, cross-check, set of study notes and question about a solution,
// so the models follow the methods the course teaches.
//
// The guides live in R2 (the PDFS bucket, under course-guides/<subject>.md),
// never in this repository: it is public, and the notes are the
// university's. Upload or replace one with `npm run guides:upload` (README,
// "Course guides"); a subject with no guide there simply gets none. Each
// isolate keeps what it read for a few minutes, so a run's dozen tasks read
// R2 once or twice, and a replaced guide is in use within GUIDE_CACHE_MS.

import { courseGuideInstructions } from "../shared/prompt";
import { subjectName, type SubjectKey } from "../shared/subjects";
import type { WorkerEnv } from "./channels";
import type { RunTaskParams } from "./run";
import type { TaskKind } from "./tasks";

/** The R2 key of a subject's guide. */
export function courseGuideKey(subject: SubjectKey) {
  return `course-guides/${subject}.md`;
}

/** The tasks a guide goes to: those that solve, grade or explain the question. */
export const GUIDED_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(["solve", "judge", "study", "ask"]);

/**
 * The most of a guide that is sent (about 10,000 tokens): a guide is meant to
 * be 16,000-28,000 characters; anything past this is cut, not refused.
 */
export const MAX_GUIDE_CHARS = 40_000;

const GUIDE_CACHE_MS = 5 * 60 * 1000;

const cache = new Map<SubjectKey, { text: string | null; at: number }>();

/** Forgets what this isolate read (tests). */
export function clearCourseGuideCache() {
  cache.clear();
}

/** The subject's guide, or null when there is none (or R2 could not be read). */
export async function loadCourseGuide(env: WorkerEnv, subject: SubjectKey): Promise<string | null> {
  const cached = cache.get(subject);
  if (cached && Date.now() - cached.at < GUIDE_CACHE_MS) return cached.text;
  if (!env.PDFS) return null;
  try {
    const object = await env.PDFS.get(courseGuideKey(subject));
    const text = object ? (await object.text()).trim().slice(0, MAX_GUIDE_CHARS) || null : null;
    cache.set(subject, { text, at: Date.now() });
    return text;
  } catch (error) {
    // Not cached: the next task tries again. The task runs without a guide.
    console.warn(`course guide ${subject} not read`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The task with its subject's guide put first in its instructions, and a
 * status line saying so. Unchanged when the task kind takes no guide, the
 * request named no subject, or the subject has none.
 */
export async function applyCourseGuide(
  kind: TaskKind,
  params: RunTaskParams,
  env: WorkerEnv,
): Promise<RunTaskParams> {
  const { subject } = params;
  if (!subject || !GUIDED_KINDS.has(kind)) return params;
  const guide = await loadCourseGuide(env, subject);
  if (!guide) return params;
  const name = subjectName(subject);
  return {
    ...params,
    notice: `Following the ${name} course method guide.`,
    task: {
      ...params.task,
      instructions: `${courseGuideInstructions(name, guide)}\n\n${params.task.instructions}`,
    },
  };
}
