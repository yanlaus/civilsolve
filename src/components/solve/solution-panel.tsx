import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CheckCircle2, Download, Languages, Loader2, Scale, X } from "lucide-react";
import { SOLUTION_LETTERS } from "../../../shared/judgement";
import {
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  UNSTABLE_PROVIDERS,
  type ProviderKey,
} from "../../../shared/providers";
import type { ProviderArtifact } from "../../../shared/solution";
import { formatDuration } from "../../../shared/stream-protocol";
import {
  isJudgeActive,
  isRunActive,
  type JudgeRun,
  type ProgressMap,
  type ProviderRuns,
} from "@/hooks/use-solve";
import { exportPdf } from "@/lib/exports";
import { renderMarkdown } from "@/lib/math-markdown";
import { formatClock, useNow, type Progress } from "@/lib/progress";
import { SolutionArticle } from "./solution-article";
import { PROVIDER_OPTIONS } from "./upload-form";

type ViewKey = "problem" | "assumptions" | "steps" | "answer";

const VIEWS: Array<{ key: ViewKey; label: string }> = [
  { key: "problem", label: "Problem" },
  { key: "assumptions", label: "Assumptions" },
  { key: "steps", label: "Solution" },
  { key: "answer", label: "Final Answer" },
];

function viewSource(artifact: ProviderArtifact, view: ViewKey) {
  return view === "problem"
    ? artifact.interpretedProblem
    : view === "assumptions"
      ? artifact.assumptions
      : view === "steps"
        ? artifact.stepByStep
        : artifact.finalAnswer;
}

/** What the verdict says about one solver: correct, wrong, or not judged. */
function solverMark(
  judgeRun: JudgeRun,
  provider: ProviderKey,
): "correct" | "wrong" | null {
  if (judgeRun.status !== "done") return null;
  const index = judgeRun.solvers.indexOf(provider);
  if (index < 0) return null;
  return judgeRun.judgement.correct.includes(index) ? "correct" : "wrong";
}

/** "Gemini's solution is correct", "Gemini and Muse Spark are correct", ... */
function verdictHeadline(labels: string[], correct: number[]) {
  if (correct.length === 0) {
    return labels.length === 2 ? "Neither solution is correct" : "None of the solutions is correct";
  }
  if (correct.length === labels.length) {
    return labels.length === 2 ? "Both solutions are correct" : "All solutions are correct";
  }
  const names = correct.map((index) => labels[index]);
  if (names.length === 1) return `${names[0]}'s solution is correct`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} are correct`;
}

// A task that ran out of time and returned nothing is shown in orange, apart
// from the red of a real failure: nothing went wrong that a rerun could not fix.
const TIMEOUT_DOT = "bg-[#e67e22] dark:bg-[#f0a35e]";
const TIMEOUT_BOX =
  "border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] text-[#a85a12] dark:border-[#5b4020] dark:text-[#f0b878]";
const ERROR_BOX =
  "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-[#c0392b] dark:border-[#5b2a31] dark:text-[#f2b8b2]";

/**
 * Every status line so far, with when it came, so a long wait shows its
 * history - each retry, model switch and dropped connection - instead of one
 * line that never changes. The line already shown above is left out.
 */
function EventLog({ progress, current }: { progress?: Progress; current?: string }) {
  if (!progress) return null;
  const events = progress.events.filter(
    (event, index, all) => !(index === all.length - 1 && event.message === current),
  );
  if (!events.length) return null;
  return (
    <ol className="mt-3 space-y-1 border-t border-current/10 pt-2 text-xs opacity-80">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className="flex gap-2">
          <span className="shrink-0 tabular-nums opacity-70">
            {formatClock(event.at - progress.startedAt)}
          </span>
          <span className="min-w-0 break-words">{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The progress bar of a task still running: what it is doing, how long it has
 * taken so far, and what happened on the way. The timeout is deliberately not
 * shown - only the time spent (the owner's choice, 25 September 2026).
 */
function ProgressBox({ line, progress, now }: { line: string; progress?: Progress; now: number }) {
  const elapsed = progress ? now - progress.startedAt : 0;
  return (
    <div className="rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 text-sm text-[#5c5347] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#cfc7bf]">
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#b35c1e] dark:text-[#e8903a]" />
        <span className="min-w-0 flex-1 break-words">{line}</span>
        {progress ? (
          <span className="shrink-0 font-semibold tabular-nums" title="Time since the request was sent">
            {formatClock(elapsed)}
          </span>
        ) : null}
      </div>
      <EventLog progress={progress} current={line} />
    </div>
  );
}

/**
 * How long a finished task took, when known: "2 min 15 s". Nothing under a
 * second - that is a request refused outright, or a job the server no longer
 * had, where a time would only mislead.
 */
function tookLabel(progress?: Progress) {
  if (!progress?.endedAt) return "";
  const took = progress.endedAt - progress.startedAt;
  return took >= 1000 ? formatDuration(took) : "";
}

export default function SolutionPanel({
  runs,
  judgeRun,
  progress,
  judgeProgress,
}: {
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  progress: ProgressMap;
  judgeProgress: Progress | null;
}) {
  const [activeProvider, setActiveProvider] = useState<ProviderKey>(PROVIDER_KEYS[0]);
  const [activeView, setActiveView] = useState<ViewKey>("steps");

  // Picker order, except that an unstable provider (Gemini) goes last: the
  // page opens on the first finished tab, and that should be a dependable one.
  const visibleProviders = PROVIDER_OPTIONS.filter(
    (provider) => runs[provider.key].status !== "idle",
  ).sort(
    (a, b) => Number(UNSTABLE_PROVIDERS.has(a.key)) - Number(UNSTABLE_PROVIDERS.has(b.key)),
  );
  const firstDone = visibleProviders.find(
    (provider) => runs[provider.key].status === "done",
  )?.key;

  // Set once the user opens a tab themselves: from then on the page stops
  // choosing for them. Without it, opening a failed or timed-out tab while
  // another had finished bounced straight back to the finished one, so the
  // failure's message could never be read.
  const userPicked = useRef(false);
  const pickProvider = (key: ProviderKey) => {
    userPicked.current = true;
    setActiveProvider(key);
  };

  // Auto-activate the first finished provider once, or keep a sensible tab
  // active while the current one has nothing to show yet.
  useEffect(() => {
    // A fresh run, nothing finished yet: the page may choose again.
    if (visibleProviders.every((provider) => isRunActive(runs[provider.key]))) {
      userPicked.current = false;
    }
    if (runs[activeProvider].status === "idle" && visibleProviders.length) {
      setActiveProvider(firstDone ?? visibleProviders[0].key);
    } else if (
      !userPicked.current &&
      firstDone &&
      runs[activeProvider].status !== "done" &&
      !isRunActive(runs[activeProvider])
    ) {
      setActiveProvider(firstDone);
    }
  }, [runs, activeProvider, firstDone, visibleProviders]);

  const activeRun = runs[activeProvider];
  const activeArtifact = activeRun.status === "done" ? activeRun.solution : null;
  const activeLabel = PROVIDER_OPTIONS.find((p) => p.key === activeProvider)?.label ?? "";
  const activeProgress = progress[activeProvider];
  // Ticks every second while anything is still running, for the clocks.
  const now = useNow(
    visibleProviders.some((provider) => isRunActive(runs[provider.key])) || isJudgeActive(judgeRun),
  );

  const printHtml = useMemo(() => {
    if (!activeArtifact) return "";
    const escapedTitle = activeArtifact.title
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return [
      `<h1>${escapedTitle}</h1>`,
      "<h2>Interpreted Problem</h2>",
      renderMarkdown(activeArtifact.interpretedProblem),
      "<h2>Assumptions</h2>",
      renderMarkdown(activeArtifact.assumptions),
      "<h2>Solution</h2>",
      renderMarkdown(activeArtifact.stepByStep),
      "<h2>Final Answer</h2>",
      renderMarkdown(activeArtifact.finalAnswer),
    ].join("\n");
  }, [activeArtifact]);

  if (!visibleProviders.length) return null;

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <h2 className="flex items-center gap-2 font-serif text-2xl font-bold text-[#1b1610] dark:text-[#e4e0db]">
          <CheckCircle2 className="h-5 w-5 text-[#2d8a4e] dark:text-[#3daf66]" />
          Solutions
        </h2>
      </div>

      {judgeRun.status !== "idle" ? (
        <JudgementCard judgeRun={judgeRun} progress={judgeProgress ?? undefined} now={now} />
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-[#e8e3db] bg-white shadow-[0_4px_16px_rgba(27,22,16,0.08)] print:hidden dark:border-[#1e2a40] dark:bg-[#151d2e]">
        <div className="border-b-2 border-[#e8e3db] px-2 pt-1 dark:border-[#1e2a40]">
          <div className="flex overflow-x-auto">
            {visibleProviders.map((provider) => {
              const run = runs[provider.key];
              const mark = solverMark(judgeRun, provider.key);
              return (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => pickProvider(provider.key)}
                  className={`relative shrink-0 px-4 py-3 pr-8 text-left text-sm font-semibold transition ${
                    activeProvider === provider.key
                      ? "text-[#b35c1e] dark:text-[#e8903a]"
                      : "text-[#8a7f72] hover:text-[#1b1610] dark:text-[#a8a098] dark:hover:text-[#e4e0db]"
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {provider.label}
                    {mark === "correct" ? (
                      <Check className="h-3.5 w-3.5 text-[#2d8a4e] dark:text-[#3daf66]" aria-label="Judged correct" />
                    ) : mark === "wrong" ? (
                      <X className="h-3.5 w-3.5 text-[#c0392b] dark:text-[#f2b8b2]" aria-label="Judged wrong" />
                    ) : null}
                  </div>
                  <span
                    className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                      activeProvider === provider.key ? "bg-[#b35c1e] dark:bg-[#e8903a]" : "bg-transparent"
                    }`}
                  />
                  {isRunActive(run) ? (
                    <Loader2 className="absolute right-2.5 top-3 h-3 w-3 animate-spin text-[#8a7f72] dark:text-[#a8a098]" />
                  ) : (
                    <span
                      title={
                        run.status === "error"
                          ? run.timedOut
                            ? "Timed out - no solution"
                            : "Failed - no solution"
                          : "Finished"
                      }
                      className={`absolute right-3 top-3 h-2.5 w-2.5 rounded-full ${
                        run.status === "error"
                          ? run.timedOut
                            ? TIMEOUT_DOT
                            : "bg-[#c0392b] dark:bg-[#f2b8b2]"
                          : "bg-[#2d8a4e] dark:bg-[#3daf66]"
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {activeArtifact ? (
          <>
            <div className="border-b border-[#e8e3db] px-7 py-5 dark:border-[#1e2a40]">
              <div className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-[#8a7f72] dark:text-[#a8a098]">
                {activeLabel}
                {tookLabel(activeProgress) ? (
                  <span className="ml-2 font-normal normal-case tracking-normal">
                    answered in {tookLabel(activeProgress)}
                  </span>
                ) : null}
              </div>
              <div className="font-serif text-2xl font-semibold text-[#1b1610] dark:text-[#e4e0db]">
                {activeArtifact.title}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => exportPdf(activeArtifact.title)}
                  className="inline-flex items-center gap-2 rounded-[10px] bg-[#1b1610] px-4 py-2 text-sm font-semibold text-white dark:bg-[#e8903a] dark:text-[#0e1420]"
                >
                  <Download className="h-4 w-4" />
                  Save as PDF
                </button>
              </div>
            </div>

            <div className="border-b-2 border-[#e8e3db] px-2 pt-1 dark:border-[#1e2a40]">
              <div className="flex overflow-x-auto">
                {VIEWS.map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    onClick={() => setActiveView(view.key)}
                    className={`relative shrink-0 px-4 py-3 text-sm font-semibold transition ${
                      activeView === view.key
                        ? "text-[#b35c1e] dark:text-[#e8903a]"
                        : "text-[#8a7f72] hover:text-[#1b1610] dark:text-[#a8a098] dark:hover:text-[#e4e0db]"
                    }`}
                  >
                    {view.label}
                    <span
                      className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                        activeView === view.key ? "bg-[#b35c1e] dark:bg-[#e8903a]" : "bg-transparent"
                      }`}
                    />
                  </button>
                ))}
              </div>
            </div>

            <SolutionArticle source={viewSource(activeArtifact, activeView)} />
          </>
        ) : (
          <div className="px-7 py-8">
            {activeRun.status === "error" ? (
              <div
                className={`rounded-[10px] border px-4 py-3 text-sm ${
                  activeRun.timedOut ? TIMEOUT_BOX : ERROR_BOX
                }`}
              >
                <div className="font-semibold">
                  {activeRun.timedOut ? "Timed out - no solution returned" : "No solution returned"}
                  {tookLabel(activeProgress) ? (
                    <span className="font-normal"> after {tookLabel(activeProgress)}</span>
                  ) : null}
                </div>
                <div className="mt-1">{activeRun.message}</div>
                <EventLog progress={activeProgress} />
              </div>
            ) : (
              <ProgressBox
                now={now}
                progress={activeProgress}
                line={
                  activeRun.status === "streaming"
                    ? `${activeLabel} is writing the solution... ${activeRun.charsReceived.toLocaleString()} characters received.`
                    : activeRun.status === "waiting"
                      ? activeRun.message
                      : "Waiting..."
                }
              />
            )}
          </div>
        )}
      </div>

      {/* Hidden on screen; the only visible content when printing (Save as PDF). */}
      {printHtml ? (
        <div
          className="print-area solution-content prose prose-stone hidden max-w-none print:block"
          dangerouslySetInnerHTML={{ __html: printHtml }}
        />
      ) : null}
    </section>
  );
}

const CONFIDENCE_CLASS = {
  high: "border-[#c9dcc4] bg-[#eef6ea] text-[#3f7a3a] dark:border-[#2f4a2c] dark:bg-[#14241a] dark:text-[#8fcf86]",
  medium:
    "border-[#e8d9a8] bg-[rgba(179,138,30,0.08)] text-[#7a5d10] dark:border-[#5b512a] dark:text-[#e6d6a0]",
  low: "border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] text-[#c0392b] dark:border-[#5b2a31] dark:text-[#f2b8b2]",
} as const;

/** Compact rendered markdown for the verdict's fields (math included). */
function Prose({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className="solution-content prose prose-sm prose-stone max-w-none min-w-0 overflow-x-hidden leading-7 dark:prose-invert"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Assessment({
  label,
  letter,
  text,
  correct,
}: {
  label: string;
  letter: string;
  text: string;
  correct: boolean;
}) {
  return (
    <div className="min-w-0 rounded-[10px] border border-[#e8e3db] bg-[#faf8f5] px-4 py-3 dark:border-[#1e2a40] dark:bg-[#0e1420]">
      <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
        {correct ? (
          <Check className="h-3.5 w-3.5 text-[#2d8a4e] dark:text-[#3daf66]" aria-hidden="true" />
        ) : (
          <X className="h-3.5 w-3.5 text-[#c0392b] dark:text-[#f2b8b2]" aria-hidden="true" />
        )}
        Solution {letter} · {label}
      </div>
      {text ? <Prose source={text} /> : <p className="text-sm text-[#8a7f72]">No assessment given.</p>}
    </div>
  );
}

/**
 * The answer cross-check's result: which solvers the judge found correct,
 * the judge's own verified answer, and what each solution got wrong. The
 * judge only ever saw "Solution A", "Solution B", ...; the provider names
 * are added back here from the order the solvers ran in.
 */
function JudgementCard({
  judgeRun,
  progress,
  now,
}: {
  judgeRun: JudgeRun;
  progress?: Progress;
  now: number;
}) {
  if (judgeRun.status === "idle") return null;
  const judgeLabel = PROVIDER_LABELS[judgeRun.judge];

  if (judgeRun.status === "error") {
    return (
      <div
        className={`mb-4 rounded-[10px] border px-4 py-3 text-sm print:hidden ${
          judgeRun.timedOut ? TIMEOUT_BOX : ERROR_BOX
        }`}
      >
        <div className="flex items-center gap-3">
          <Scale className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-semibold">
              Cross-check ({judgeLabel}){judgeRun.timedOut ? " timed out" : ""}
              {tookLabel(progress) ? ` after ${tookLabel(progress)}` : ""}:{" "}
            </span>
            {judgeRun.message}
          </span>
        </div>
        <EventLog progress={progress} />
      </div>
    );
  }

  if (judgeRun.status !== "done") {
    // Until every solver finishes the judge has not started, so there is no
    // clock yet - just the wait.
    return (
      <div className="mb-4 print:hidden">
        <ProgressBox
          now={now}
          progress={progress}
          line={`Cross-check (${judgeLabel}): ${
            judgeRun.status === "streaming"
              ? `writing the verdict... ${judgeRun.charsReceived.toLocaleString()} characters received.`
              : judgeRun.message
          }`}
        />
      </div>
    );
  }

  const { judgement, solvers, skipped } = judgeRun;
  const labels = solvers.map((provider) => PROVIDER_LABELS[provider]);
  const headlineTone =
    judgement.correct.length === 0
      ? "text-[#c0392b] dark:text-[#f2b8b2]"
      : "text-[#2d8a4e] dark:text-[#3daf66]";

  return (
    <div className="mb-4 rounded-2xl border-2 border-[#b35c1e] bg-white p-5 shadow-[0_0_0_4px_rgba(179,92,30,0.12)] print:hidden dark:border-[#e8903a] dark:bg-[#151d2e]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Scale className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" aria-hidden="true" />
          Cross-check verdict
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">
            judged by {judgeLabel}
            {tookLabel(progress) ? ` in ${tookLabel(progress)}` : ""}
          </span>
        </p>
        <span
          className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.7rem] font-medium ${CONFIDENCE_CLASS[judgement.confidence]}`}
        >
          {judgement.confidence} confidence
        </span>
      </div>

      <p className={`mt-2 text-base font-semibold ${headlineTone}`}>
        {verdictHeadline(labels, judgement.correct)}
      </p>
      {skipped.length ? (
        <p className="mt-1 text-xs text-[#8a7f72] dark:text-[#a8a098]">
          Not graded: {skipped.map((provider) => PROVIDER_LABELS[provider]).join(", ")} returned
          no solution.
        </p>
      ) : null}

      {judgement.final_answer ? (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
            Verified final answer
          </div>
          <Prose source={judgement.final_answer} />
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {solvers.map((provider, index) => (
          <Assessment
            key={provider}
            label={PROVIDER_LABELS[provider]}
            letter={SOLUTION_LETTERS[index] ?? String(index + 1)}
            text={judgement.assessments[index] ?? ""}
            correct={judgement.correct.includes(index)}
          />
        ))}
      </div>

      {judgement.comparison ? (
        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
            Why
          </div>
          <Prose source={judgement.comparison} />
        </div>
      ) : null}

      {judgement.traditional_chinese ? (
        <div
          lang="zh-Hant-HK"
          className="mt-4 rounded-[10px] border border-[#e8e3db] bg-[#faf8f5] px-4 py-3 dark:border-[#1e2a40] dark:bg-[#0e1420]"
        >
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-[#8a7f72] dark:text-[#a8a098]">
            <Languages className="h-3.5 w-3.5" aria-hidden="true" />
            繁體中文 · Traditional Chinese
          </div>
          <Prose source={judgement.traditional_chinese} />
        </div>
      ) : null}

      <p className="mt-4 text-xs text-[#8a7f72] dark:text-[#a8a098]">
        The judge is a model too — treat this as a second opinion, not an answer key. Open
        each solution above and check the step it flags.
      </p>
    </div>
  );
}
