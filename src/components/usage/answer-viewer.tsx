// The usage page's answer window (19 October 2026, the owner's request): a
// task's answer as its job still keeps it - for 24 hours after it finished -
// read from GET /api/jobs/:id, which only reads. Nothing is copied or kept:
// once the job has deleted it, the window says so. The question's pages,
// when the server still keeps them (worker/questions.ts), open from here
// too. Math is typeset by MathProse, loaded with the window.

import { lazy, Suspense, useEffect, useState } from "react";
import { X } from "lucide-react";
import { interpretationToText, type InterpretationResult } from "../../../shared/interpretation";
import { judgementToText, type JudgementResult } from "../../../shared/judgement";
import type { ProviderArtifact } from "../../../shared/solution";
import type { StudyResult } from "../../../shared/study";
import { readBoards, type VisualBoard } from "../../../shared/visual";
import { usagePartLabel, type UsageReport } from "../../../shared/usage-report";
import { RETENTION_MS } from "@/lib/run-store";

const MathProse = lazy(() => import("@/components/solve/math-prose"));
// A Visualize deck runs in its sandboxed frame here too (board-viewer.tsx).
const BoardViewer = lazy(() => import("@/components/solve/board-viewer").then((module) => ({ default: module.BoardViewer })));

type Row = UsageReport["recent"][number];
type Section = { heading: string; text: string; chinese?: boolean };
type State =
  | { status: "loading" }
  | { status: "gone" }
  | { status: "failed"; message: string }
  | { status: "done"; sections: Section[]; boards?: VisualBoard[] };

/** How long a stored answer is read for before the window gives up. */
const READ_TIMEOUT_MS = 20_000;

/** The final event of a job's stream: `done` or `error`, with its data. */
function finalEvent(stream: string): { name: string; data: Record<string, unknown> } | null {
  for (const frame of stream.split(/\n\n/).reverse()) {
    const name = /^event: (.+)$/m.exec(frame)?.[1]?.trim();
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if ((name === "done" || name === "error") && data) {
      try {
        return { name, data: JSON.parse(data) as Record<string, unknown> };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** What a stored answer shows, by the part of the page that asked for it. */
function sectionsOf(row: Row, data: Record<string, unknown>): Section[] {
  const sections: Section[] = [];
  const add = (heading: string, value: unknown, chinese = false) => {
    if (text(value)) sections.push({ heading, text: text(value), chinese });
  };
  const solution = data.solution as ProviderArtifact | undefined;
  if (solution && typeof solution === "object") {
    add("Problem, as the model read it · 題目", solution.interpretedProblem);
    add("Assumptions · 假設", solution.assumptions);
    add("Working · 解題步驟", solution.stepByStep);
    add("Final answer · 答案", solution.finalAnswer);
    for (const diagram of solution.diagrams ?? []) add(`Diagram to draw · ${diagram.title}`, diagram.description);
    return sections;
  }
  const reading = data.interpretation as (InterpretationResult & Record<string, unknown>) | undefined;
  if (reading && typeof reading === "object") {
    add("Conclusion · 結論", reading.conclusion);
    add("The question, as read · 題目", interpretationToText(reading));
    add("中文", reading.traditional_chinese, true);
    return sections;
  }
  const judgement = data.judgement as (JudgementResult & Record<string, unknown>) | undefined;
  if (judgement && typeof judgement === "object") {
    const count = row.solutions ?? judgement.assessments?.length ?? 0;
    add("Verdict · 核對結果", judgementToText(judgement, count));
    add("中文", judgement.traditional_chinese, true);
    return sections;
  }
  const study = data.study as StudyResult | undefined;
  if (study && typeof study === "object") {
    add("Study notes · 筆記", study.guide);
    add("中文", study.traditional_chinese, true);
    return sections;
  }
  const answer = data.answer as { answer?: unknown } | undefined;
  if (answer && typeof answer === "object") {
    add("Answer to the question · 回答", answer.answer);
    return sections;
  }
  const comparison = data.comparison as { alignment?: unknown[]; notes?: unknown[] } | undefined;
  if (comparison && Array.isArray(comparison.alignment)) {
    const lines = comparison.alignment.map(
      (value, index) =>
        `- **Answer ${index + 1}:** ${String(value)}${text(comparison.notes?.[index]) ? ` - ${text(comparison.notes?.[index])}` : ""}`,
    );
    add("How the answers line up · 比對", lines.join("\n"));
  }
  return sections;
}

export function AnswerViewer({
  row,
  onClose,
  onShowPages,
}: {
  row: Row;
  onClose: () => void;
  /** Opens the question's pages, when the server keeps them. */
  onShowPages?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, READ_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`/api/jobs/${row.jobId}`, { signal: abort.signal, cache: "no-store" });
        if (response.status === 404) return setState({ status: "gone" });
        if (!response.ok) return setState({ status: "failed", message: `HTTP ${response.status}` });
        // A finished job sends its stored final event and closes the stream.
        const event = finalEvent(await response.text());
        if (!event) return setState({ status: "failed", message: "The job sent no answer." });
        if (event.name === "error") {
          return setState({ status: "failed", message: text(event.data.message) || "The task failed." });
        }
        const boards = readBoards((event.data.visual as { boards?: unknown } | undefined)?.boards);
        if (boards) return setState({ status: "done", sections: [], boards });
        const sections = sectionsOf(row, event.data);
        setState(sections.length ? { status: "done", sections } : { status: "failed", message: "Nothing to show." });
      } catch {
        // An abort that is not the timeout is the window closing: nothing to show.
        if (timedOut) setState({ status: "failed", message: "The answer took too long to read." });
        else if (!abort.signal.aborted) setState({ status: "failed", message: "The answer could not be read." });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [row]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Stored answer"
        className="w-full max-w-3xl rounded-cs-lg border border-cs-line bg-cs-surface p-4 shadow-lg sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg text-cs-ink">{usagePartLabel(row.kind, row.detail, row.revision)}</h2>
            <p className="text-xs text-cs-ink-3">
              {row.model ?? row.provider ?? ""}
              {row.ip ? ` · ${row.ip}` : ""}
              {row.endedAt ? ` · kept until ${new Date(row.endedAt + RETENTION_MS).toLocaleString("en-HK", { dateStyle: "medium", timeStyle: "short" })}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-cs border border-cs-line p-1.5 text-cs-ink-2 hover:border-cs-accent"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {onShowPages ? (
          <button
            type="button"
            onClick={onShowPages}
            className="mt-3 text-xs font-semibold text-cs-accent underline-offset-2 hover:underline"
          >
            See the question's pages · 睇題目
          </button>
        ) : row.question ? (
          <p className="mt-3 rounded-cs bg-cs-muted px-3 py-2 text-xs text-cs-ink-3">
            The question's pages are not kept for this one: asked before the server kept them (19 October 2026), or
            deleted 24 hours after its last task. 題目原圖冇保留。
          </p>
        ) : null}
        <div className="mt-4">
          {state.status === "loading" ? <p className="text-sm text-cs-ink-3">Reading the stored answer...</p> : null}
          {state.status === "gone" ? (
            <p className="text-sm text-cs-ink-2">
              This answer is no longer kept: answers are deleted 24 hours after they finish. 答案已過咗 24 小時，已刪除。
            </p>
          ) : null}
          {state.status === "failed" ? <p className="text-sm text-[#a8321f]">{state.message}</p> : null}
          {state.status === "done" ? (
            <Suspense fallback={<p className="text-sm text-cs-ink-3">Loading...</p>}>
              {state.boards ? <BoardViewer boards={state.boards} /> : null}
              {state.sections.map((section) => (
                <section key={section.heading} className="mt-5 first:mt-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-cs-ink-3">{section.heading}</h3>
                  <MathProse source={section.text} chinese={section.chinese} className="mt-1.5" />
                </section>
              ))}
            </Suspense>
          ) : null}
        </div>
      </div>
    </div>
  );
}
