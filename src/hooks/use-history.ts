// Writes the run on the page into the history (lib/history-store.ts) as its
// answers come in: every finished solution, the verdict and the study notes,
// with the question's first page as a thumbnail. A run picked back up after
// a reload only ever adds to its entry - a solution still re-attaching does
// not wipe the one already kept.

import { useEffect, useRef } from "react";
import { PROVIDER_KEYS, SOLUTION_ORDER, type ProviderKey } from "../../shared/providers";
import { STUDY_KINDS } from "../../shared/study";
import type {
  ConfirmedInterpretation,
  JudgeRun,
  PdfTarget,
  ProviderRuns,
  RunVariants,
  StudyRuns,
} from "@/hooks/use-solve";
import { makeThumbnail, saveEntry, type HistoryEntry } from "@/lib/history-store";

/** How long the page waits for more answers before writing (a burst of them writes once). */
const WRITE_DELAY_MS = 1000;

type HistorySource = {
  runId: number | null;
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  studyRuns: StudyRuns;
  variants: RunVariants;
  interpretation: ConfirmedInterpretation | null;
  questionImages: string[];
  notes: string;
  pdfJobOf: (target: PdfTarget) => string | null;
};

/**
 * What has finished, as a string that changes only when an answer does - not
 * on every chunk a running solver streams, which would keep putting the
 * write off.
 */
function finishedSignature({ runs, judgeRun, studyRuns, interpretation }: HistorySource) {
  return [
    ...PROVIDER_KEYS.map((key) => {
      const run = runs[key];
      return run.status === "done"
        ? `${key}:${run.solution.title.length}:${run.solution.stepByStep.length}:${run.solution.finalAnswer.length}`
        : "";
    }),
    judgeRun.status === "done" ? `verdict:${judgeRun.judgement.final_answer.length}` : "",
    ...STUDY_KINDS.map((kind) => {
      const run = studyRuns[kind];
      return run.status === "done" ? `${kind}:${run.study.guide.length}` : "";
    }),
    `reading:${interpretation?.text.length ?? 0}`,
  ].join("|");
}

/** The run as a history entry, merged over what was kept before. */
function entryOf(source: HistorySource, runId: number, thumbnail: string | undefined) {
  const { runs, judgeRun, studyRuns, variants, interpretation, notes, pdfJobOf } = source;
  const solutions: HistoryEntry["solutions"] = {};
  for (const key of PROVIDER_KEYS) {
    const run = runs[key];
    if (run.status !== "done") continue;
    const jobId = pdfJobOf(key);
    solutions[key] = {
      artifact: run.solution,
      ...(variants.solvers[key] ? { variant: variants.solvers[key] } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(jobId ? { jobId } : {}),
    };
  }
  const verdictJob = pdfJobOf("verdict");
  const verdict: HistoryEntry["verdict"] | undefined =
    judgeRun.status === "done"
      ? {
          judge: judgeRun.judge,
          ...(variants.judge ? { variant: variants.judge } : {}),
          graded: judgeRun.solvers,
          correct: judgeRun.judgement.correct
            .map((index) => judgeRun.solvers[index])
            .filter((key): key is ProviderKey => Boolean(key)),
          finalAnswer: judgeRun.judgement.final_answer,
          ...(verdictJob ? { jobId: verdictJob } : {}),
        }
      : undefined;
  const study: HistoryEntry["study"] = {};
  for (const kind of STUDY_KINDS) {
    const run = studyRuns[kind];
    const jobId = pdfJobOf(kind);
    if (run.status === "done") study[kind] = { study: run.study, ...(jobId ? { jobId } : {}) };
  }
  const first = SOLUTION_ORDER.map((key) => runs[key]).find((run) => run.status === "done");
  const firstTitle = first?.status === "done" ? first.solution.title : "";

  return (current: HistoryEntry | undefined): HistoryEntry => ({
    savedAt: runId,
    updatedAt: Date.now(),
    title: current?.title || firstTitle || "Untitled question",
    thumbnail: current?.thumbnail ?? thumbnail,
    notes: notes || current?.notes,
    interpretation: interpretation?.text || current?.interpretation,
    solutions: { ...current?.solutions, ...solutions },
    verdict: verdict ?? current?.verdict,
    study: { ...current?.study, ...study },
  });
}

export function useHistory(source: HistorySource) {
  const latest = useRef(source);
  latest.current = source;
  const thumbnails = useRef(new Map<number, string | undefined>());
  const { runId } = source;
  const signature = finishedSignature(source);

  useEffect(() => {
    if (runId === null || !SOLUTION_ORDER.some((key) => latest.current.runs[key].status === "done")) return;
    const timer = setTimeout(async () => {
      const images = latest.current.questionImages;
      if (!thumbnails.current.has(runId) && images[0]) {
        thumbnails.current.set(runId, await makeThumbnail(images[0]));
      }
      await saveEntry(runId, entryOf(latest.current, runId, thumbnails.current.get(runId)));
    }, WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [runId, signature]);
}
