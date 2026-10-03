// Where the student is in a run (3 October 2026, the owner's request: in
// Careful, nothing said the solutions had appeared below the interpreted
// question). Four steps - upload, check the reading, answers, cross-check -
// each with a state worked out from the page's own state, for the step bar
// at the top (components/solve/journey-bar.tsx), the jump button and the
// automatic scroll from one step to the next.

import type { InterpretPipeline } from "@/hooks/use-interpret";
import {
  isRunActive,
  JUDGE_QUEUED,
  type ConfirmedInterpretation,
  type JudgeRun,
  type ProviderRuns,
} from "@/hooks/use-solve";

export type StepKey = "upload" | "reading" | "answers" | "check";

/**
 * - `todo`: not reached yet; `now`: the student's move (upload a question);
 * - `running`: a model is at it; `queued`: it starts by itself after another
 *   step; `yourTurn`: waiting for the student (confirm the reading);
 * - `done`, `skipped` (this run leaves it out), `failed`.
 */
export type StepState = "todo" | "now" | "running" | "queued" | "yourTurn" | "done" | "skipped" | "failed";

export type JourneyStep = {
  key: StepKey;
  label: string;
  chinese: string;
  state: StepState;
  /** Where it stands, in a few words: English, then Chinese (phones show the Chinese). */
  detail?: [string, string];
  /** The id of the element it jumps to, when that is on the page. */
  target?: string;
};

/** The elements the steps jump to. */
export const STEP_IDS = {
  upload: "step-upload",
  review: "step-reading-review",
  reading: "step-reading",
  answers: "step-answers",
  check: "step-check",
} as const;

export type JourneyInput = {
  /** Images being prepared for upload. */
  preparing: boolean;
  pipeline: InterpretPipeline;
  /** What the form will run, read before anything has started. */
  plan: { verify: boolean; autoCheck: boolean };
  interpretation: ConfirmedInterpretation | null;
  runs: ProviderRuns;
  judgeRun: JudgeRun;
};

export function buildJourney({ preparing, pipeline, plan, interpretation, runs, judgeRun }: JourneyInput) {
  const started = Object.values(runs).filter((run) => run.status !== "idle");
  const total = started.length;
  const active = started.filter(isRunActive).length;
  const done = started.filter((run) => run.status === "done").length;
  const begun = preparing || pipeline.status !== "idle" || total > 0;

  const upload: JourneyStep = {
    key: "upload",
    label: "Upload",
    chinese: "上載",
    target: STEP_IDS.upload,
    ...(preparing
      ? { state: "running", detail: ["Preparing", "準備緊"] }
      : begun
        ? { state: "done" }
        : { state: "now", detail: ["Add the question", "加題目"] }),
  };

  const reading: JourneyStep = {
    key: "reading",
    label: "Check reading",
    chinese: "核對題目",
    ...(pipeline.status === "running"
      ? { state: "running", detail: ["Reading", "讀緊"], target: STEP_IDS.upload }
      : pipeline.status === "review"
        ? { state: "yourTurn", detail: ["Your turn", "到你確認"], target: STEP_IDS.review }
        : pipeline.status === "error"
          ? { state: "failed", detail: ["Failed", "失敗"], target: STEP_IDS.upload }
          : interpretation
            ? { state: "done", detail: ["Confirmed", "已確認"], target: STEP_IDS.reading }
            : total || !plan.verify
              ? { state: "skipped", detail: ["Skipped", "略過"] }
              : { state: "todo" }),
  };

  const answers: JourneyStep = {
    key: "answers",
    label: "Answers",
    chinese: "答案",
    ...(!total
      ? { state: "todo" }
      : {
          target: STEP_IDS.answers,
          ...(active
            ? { state: "running", detail: [`${done}/${total} ready`, `${done}/${total} 完成`] }
            : done
              ? { state: "done", detail: [`${done}/${total} ready`, `${done}/${total} 完成`] }
              : { state: "failed", detail: ["No answer", "冇答案"] }),
        }),
  };

  const check: JourneyStep = {
    key: "check",
    label: "Cross-check",
    chinese: "核對答案",
    ...(total ? { target: STEP_IDS.check } : {}),
    ...(judgeRun.status === "waiting" && judgeRun.message === JUDGE_QUEUED
      ? { state: "queued", detail: ["After the answers", "答案之後"] }
      : judgeRun.status === "waiting" || judgeRun.status === "streaming"
        ? { state: "running", detail: ["Checking", "核對緊"] }
        : judgeRun.status === "done"
          ? { state: "done", detail: ["Verdict ready", "有結果"] }
          : judgeRun.status === "error"
            ? judgeRun.message.startsWith("Cross-check skipped") || judgeRun.stopped
              ? { state: "skipped", detail: ["Skipped", "略過"] }
              : { state: "failed", detail: ["Failed", "失敗"] }
            : // Nothing to say while it waits for a tap (the owner, 4 October
              // 2026); Custom's automatic cross-check says so.
              !total && plan.autoCheck
              ? { state: "todo", detail: ["Automatic", "自動"] }
              : { state: "todo" }),
  };

  const steps = [upload, reading, answers, check];
  return { steps, current: currentStep(steps) };
}

/**
 * The step to look at now: the reading while it is read or waits for the
 * student, the cross-check once its verdict is in or it runs, else the
 * answers once there are any, else the upload.
 */
function currentStep([upload, reading, answers, check]: JourneyStep[]): JourneyStep {
  if (reading.state === "running" || reading.state === "yourTurn" || reading.state === "failed") return reading;
  if (upload.state === "running" || upload.state === "now") return upload;
  if (answers.state === "running") return answers;
  if (check.state === "running" || check.state === "done") return check;
  if (answers.target) return answers;
  return upload;
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Brings a step's element into view, under the sticky step bar, and moves
 * the keyboard focus to it (the element has tabIndex -1). A folded
 * `<details>` is opened on the way.
 */
export function scrollToStep(id: string) {
  const element = document.getElementById(id);
  if (!element) return false;
  if (element instanceof HTMLDetailsElement) element.open = true;
  element.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  element.focus({ preventScroll: true });
  return true;
}

/**
 * Scrolls to a step's element once it is on the page - the solutions panel
 * is lazy-loaded, so it may take a moment after the run starts. Gives up
 * after `timeoutMs`; the returned function cancels.
 */
export function scrollToStepWhenReady(id: string, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let frame = 0;
  const attempt = () => {
    if (scrollToStep(id) || Date.now() > until) return;
    frame = window.requestAnimationFrame(attempt);
  };
  frame = window.requestAnimationFrame(attempt);
  return () => window.cancelAnimationFrame(frame);
}
