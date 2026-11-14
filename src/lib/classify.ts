// The question's course subject, settled before anything is solved (14
// November 2026, the owner's request; shared/subjects.ts): the student's pick
// on the form, or - left on Auto - DeepSeek's, from the pages
// (POST /api/classify/:provider, DEFAULT_CLASSIFIER at "low"). The subject
// then goes in the run's body, so every solver, the cross-check, the study
// notes and the questions about a solution get its course guide.
//
// Never in the way of a solve: a classification that fails, or takes longer
// than CLASSIFY_WAIT_MS, leaves the question without a subject - solved
// the usual way - and says so.

import { DEFAULT_CLASSIFIER } from "../../shared/providers";
import type { ClassifyRequestBody } from "../../shared/stream-protocol";
import { isSubjectKey, type SubjectChoice, type SubjectKey, type SubjectResult } from "../../shared/subjects";
import {
  jobHandle,
  openTaskStream,
  readSseEvents,
  stopTask,
  StreamInterruptedError,
  takeJobEvent,
  withResume,
} from "@/lib/sse";

/** The longest a solve waits for the subject before going ahead without one. */
export const CLASSIFY_WAIT_MS = 60_000;

/** How a run's subject was settled, for the page to show. */
export type SubjectOutcome =
  | { status: "running" }
  | { status: "picked"; subject: SubjectKey }
  | { status: "classified"; subject: SubjectKey; result: SubjectResult }
  | { status: "unknown"; message: string };

export function outcomeSubject(outcome: SubjectOutcome | null): SubjectKey | undefined {
  return outcome && (outcome.status === "picked" || outcome.status === "classified") ? outcome.subject : undefined;
}

/** Asks the classifier, once; rejects on an error, a Stop (`signal`) or after `waitMs`. */
export async function classifySubject(
  body: ClassifyRequestBody,
  signal: AbortSignal,
  waitMs = CLASSIFY_WAIT_MS,
): Promise<SubjectResult> {
  if (signal.aborted) throw new Error("Stopped.");
  const handle = jobHandle();
  const abort = new AbortController();
  // Cancels the job when the server has named it, and ends the wait at once
  // either way: a quick look is not worth holding a Stop up for.
  const stop = () => {
    stopTask(handle, abort);
    abort.abort();
  };
  signal.addEventListener("abort", stop, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, waitMs);
  try {
    return await withResume(
      async () => {
        const stream = await openTaskStream(handle, `/api/classify/${DEFAULT_CLASSIFIER.provider}`, body, abort.signal);
        for await (const event of readSseEvents(stream)) {
          if (takeJobEvent(handle, event)) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(event.data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (event.name === "done") {
            const result = payload.subject as SubjectResult | undefined;
            if (result && isSubjectKey(result.subject)) return result;
            throw new Error("The classifier gave no subject.");
          }
          if (event.name === "error") {
            throw new Error(typeof payload.message === "string" ? payload.message : "The classifier failed.");
          }
        }
        throw new StreamInterruptedError("The classifier's stream ended before its answer.");
      },
      handle,
      abort.signal,
      () => undefined,
    );
  } catch (error) {
    if (timedOut) throw new Error(`No answer within ${Math.round(waitMs / 1000)} s.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}

/** The student's pick as it stands, or the classifier's answer - never a rejection. */
export async function settleSubject(
  choice: SubjectChoice,
  body: ClassifyRequestBody,
  signal: AbortSignal,
): Promise<SubjectOutcome> {
  if (choice !== "auto") return { status: "picked", subject: choice };
  try {
    const result = await classifySubject(body, signal);
    return { status: "classified", subject: result.subject, result };
  } catch (error) {
    return {
      status: "unknown",
      message: error instanceof Error ? error.message : "The subject could not be identified.",
    };
  }
}
