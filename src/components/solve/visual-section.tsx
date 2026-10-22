// Visualize 圖解 under the study notes (19 October 2026, the owner's request):
// the solution the student picks drawn as a deck of interactive boards, the
// way Kimi's 可视题解 draws a problem - by Muse Spark (the default since
// 21 October 2026) or DeepSeek V4.1 Flash, both on OpenCode Go
// (shared/visual.ts). Optional and made on request, like the notes, from the
// same sources; the boards run in a sandbox (lib/board-document.ts).
//
// With `purpose="diagrams"` the same section is Diagrams 畫圖 (22 October
// 2026, the owner's request), under the solutions: the diagrams the question
// asks the student to draw, drawn as a full-mark exam answer would draw them -
// by itself once a solution lists some (use-visual.ts `auto`), from the
// solutions that list them, the verdict among them when it graded one.

import { useState } from "react";
import { LineChart, Shapes, Sparkles } from "lucide-react";
import type { EffortKey } from "../../../shared/prompt";
import {
  DEFAULT_VISUAL_PROVIDER,
  VISUAL_MODELS,
  VISUAL_PROVIDERS,
  type VisualProvider,
  type VisualPurpose,
} from "../../../shared/visual";
import { modelStatus, type ProviderKey, type ProviderStatus } from "../../../shared/providers";
import type { JudgeRun, ProviderRuns, StudySource } from "@/hooks/use-solve";
import type { VisualDeck, VisualTask } from "@/hooks/use-visual";
import { effortBand } from "@/lib/effort-band";
import type { Progress } from "@/lib/progress";
import { BoardViewer } from "./board-viewer";
import { RevisionNotice } from "./revise-panel";
import { StickyHeading } from "./section-heading";
import { answerSources, listNames, sourceSentWith } from "./study-notes";
import { ERROR_BOX, EventLog, ProgressBox, STOPPED_BOX, TIMEOUT_BOX, tookLabel } from "./task-status";

/** The levels offered: both routes map "max" to "high" and "none" to no thinking at all. */
const LEVELS: EffortKey[] = ["low", "medium", "high"];

const SELECT_CLASS =
  "mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent disabled:opacity-50";
const BUTTON_CLASS =
  "cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50";

export const VISUAL_SECTION_ID = "step-visualize";
export const DIAGRAMS_SECTION_ID = "step-diagrams";

/** Whether a solution on the page lists diagrams to draw. */
function listsDiagrams(runs: ProviderRuns, key: ProviderKey) {
  const run = runs[key];
  return run.status === "done" && Boolean(run.solution.diagrams?.length);
}

/**
 * Where diagrams can be drawn from: the solutions that list some, and the
 * verdict when one of the solutions it graded does.
 */
export function diagramSources(runs: ProviderRuns, judgeRun: JudgeRun): StudySource[] {
  return answerSources(runs, judgeRun).filter((source) =>
    source === "verdict"
      ? judgeRun.status === "done" && judgeRun.solvers.some((key) => listsDiagrams(runs, key))
      : listsDiagrams(runs, source),
  );
}

export function VisualSection({
  purpose = "explain",
  deck,
  task,
  progress,
  focus,
  runs,
  judgeRun,
  now,
  providerStatus,
  nameOf,
  judgeLabel,
  markOf,
  blocked,
  interpretation,
  onDraw,
  onFix,
  onStop,
}: {
  /** "diagrams": the Diagrams 畫圖 section. Visualize otherwise. */
  purpose?: VisualPurpose;
  deck: VisualDeck | null;
  task: VisualTask;
  progress?: Progress;
  /** A board to turn to: the one just drawn again. */
  focus?: number;
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  now: number;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  nameOf: (key: ProviderKey) => string;
  judgeLabel: string;
  markOf: (key: ProviderKey) => "correct" | "wrong" | null;
  /** Why nothing can be drawn right now, if it cannot. */
  blocked?: string;
  /** Whether the run had a confirmed reading, which the model also gets. */
  interpretation: boolean;
  onDraw: (provider: VisualProvider, source: StudySource, effort: EffortKey) => void;
  onFix: (board: number, instructions: string) => void;
  onStop: () => void;
}) {
  const diagrams = purpose === "diagrams";
  const sources = diagrams ? diagramSources(runs, judgeRun) : answerSources(runs, judgeRun);
  const [sourcePick, setSourcePick] = useState<StudySource | null>(null);
  const source: StudySource | undefined =
    sourcePick && sources.includes(sourcePick) ? sourcePick : sources[0];
  // Muse Spark unless the student picks DeepSeek - or the server has no
  // key for it, when the first model it can run takes its place.
  const configured = (key: VisualProvider) => modelStatus(providerStatus?.[key])?.configured !== false;
  const [modelPick, setModelPick] = useState<VisualProvider | null>(null);
  const model =
    modelPick && configured(modelPick)
      ? modelPick
      : configured(DEFAULT_VISUAL_PROVIDER)
        ? DEFAULT_VISUAL_PROVIDER
        : (VISUAL_PROVIDERS.find(configured) ?? DEFAULT_VISUAL_PROVIDER);
  const [effortPick, setEffortPick] = useState<EffortKey>("medium");
  const { inBand, clamp } = effortBand(modelStatus(providerStatus?.[model]));
  const effort = clamp(effortPick);

  const active = task.status === "waiting" || task.status === "streaming";
  const sourceLabel = (entry: StudySource) =>
    entry === "verdict" ? `Verified answer (${judgeLabel}'s verdict)` : `${nameOf(entry)}'s solution`;
  const unconfigured = configured(model) ? undefined : `${VISUAL_MODELS[model].name} is not configured on the server.`;
  const stopReason = blocked || unconfigured || (sources.length ? undefined : "Needs a finished solution.");
  const hint = source
    ? `${diagrams ? "Drawn by itself once a solution lists diagrams; drawing again is one" : "One"} extra call to ${VISUAL_MODELS[model].label}, with the question${interpretation ? ", the confirmed reading" : ""} and ${sourceSentWith(source, judgeRun, nameOf)}. The boards run in a sandbox on this page: they cannot reach your account, your history or anything else here.`
    : "";
  const fixing = task.status !== "idle" && task.status !== "error" ? task.board : undefined;
  // While a drawing runs, the progress names the model it went to.
  const drawing = VISUAL_MODELS[task.status === "waiting" || task.status === "streaming" ? task.provider : model].name;
  // Nothing to draw: no solution lists a diagram, and none was drawn.
  if (diagrams && !sources.length && !deck && task.status === "idle") return null;

  return (
    <section
      id={diagrams ? DIAGRAMS_SECTION_ID : VISUAL_SECTION_ID}
      tabIndex={-1}
      className="mt-8 scroll-mt-28 outline-none sm:scroll-mt-20 print:hidden"
      aria-labelledby={diagrams ? "diagrams-heading" : "visualize-heading"}
    >
      {diagrams ? (
        <>
          <StickyHeading id="diagrams-heading" icon={LineChart} title="Diagrams" chinese="畫圖" />
          <p className="mb-3 text-xs text-cs-ink-3">
            The question asks you to draw {sources.length || deck ? "these diagrams" : "diagrams"}: here they are,
            drawn as a full-mark answer would draw them, to check yours against - in the exam you draw them
            yourself. An AI can still get a value or a shape wrong, so check them against the key points in the
            solution. · 題目要你畫嘅圖，畫好俾你對答案；考試時要自己畫。AI 都可能畫錯，請對返解答嘅重點數值。
          </p>
        </>
      ) : (
        <>
          <StickyHeading id="visualize-heading" icon={Shapes} title="Visualize" chinese="圖解" />
          <p className="mb-3 text-xs text-cs-ink-3">
            Optional - the solution you pick, drawn as a few interactive boards: the set-up, the key idea and the
            result, with animations and sliders where they help.
          </p>
        </>
      )}

      <div className="cs-panel min-w-0 rounded-cs-lg border border-cs-line-soft bg-cs-surface p-5 shadow-[0_1px_3px_var(--cs-shadow)]">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <label className="block text-xs text-cs-ink-3">
            Start from
            <select
              value={source ?? ""}
              disabled={active || !sources.length}
              onChange={(event) => setSourcePick(event.target.value as StudySource)}
              className={SELECT_CLASS}
            >
              {sources.map((entry) => (
                <option key={entry} value={entry}>
                  {sourceLabel(entry)}
                  {entry !== "verdict" && markOf(entry) === "correct" ? " - judged correct ✓" : ""}
                  {entry !== "verdict" && markOf(entry) === "wrong" ? " - judged wrong ✗" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-cs-ink-3">
            Model
            <select
              value={model}
              disabled={active}
              onChange={(event) => setModelPick(event.target.value as VisualProvider)}
              className={SELECT_CLASS}
            >
              {VISUAL_PROVIDERS.map((key) => (
                <option key={key} value={key} disabled={!configured(key)}>
                  {VISUAL_MODELS[key].label}
                  {key === DEFAULT_VISUAL_PROVIDER ? " (default)" : ""}
                  {configured(key) ? "" : " - not configured"}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-cs-ink-3">
            Thinking
            <select
              value={effort}
              disabled={active}
              onChange={(event) => setEffortPick(event.target.value as EffortKey)}
              className={SELECT_CLASS}
            >
              {LEVELS.map((key) => (
                <option key={key} value={key} disabled={!inBand(key)}>
                  {key.charAt(0).toUpperCase() + key.slice(1)}
                  {key === "medium" ? " (default)" : ""}
                  {inBand(key) ? "" : " - not offered by this model"}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={active || Boolean(stopReason) || !source}
            onClick={() => source && onDraw(model, source, effort)}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {active ? "Drawing..." : deck ? "Draw again" : "Draw it"}
          </button>
        </div>
        <p className="mt-2 text-[0.7rem] text-cs-ink-3">{stopReason || hint}</p>
        {source && source !== "verdict" && markOf(source) === "wrong" && !active ? (
          <p className="mt-1 text-xs font-medium text-[#a85a12]">
            The cross-check judged this solution wrong: {diagrams ? "diagrams" : "boards"} drawn from it follow it,
            mistakes included. Start from the verified answer for {diagrams ? "diagrams" : "boards"} you can rely on.
          </p>
        ) : null}

        {active ? (
          <div className="mt-3">
            <ProgressBox
              now={now}
              progress={progress}
              line={
                task.status === "streaming"
                  ? `${drawing} is drawing ${fixing === undefined ? (diagrams ? "the diagrams" : "the boards") : `board ${fixing + 1} again`}... ${task.charsReceived.toLocaleString()} characters received.`
                  : task.message
              }
              onStop={onStop}
              stopTitle="Stop the drawing - everything else carries on"
            />
          </div>
        ) : null}

        {task.status === "error" ? (
          <div
            className={`mt-3 rounded-cs border px-4 py-3 text-sm ${
              task.stopped ? STOPPED_BOX : task.timedOut ? TIMEOUT_BOX : ERROR_BOX
            }`}
          >
            <div className="font-semibold">
              {task.stopped
                ? `Stopped - no ${diagrams ? "diagrams" : "boards"}`
                : task.timedOut
                  ? `Timed out - no ${diagrams ? "diagrams" : "boards"}`
                  : `No ${diagrams ? "diagrams" : "boards"} returned`}
              {tookLabel(progress) ? <span className="font-normal"> after {tookLabel(progress)}</span> : null}
            </div>
            {task.stopped ? null : <div className="mt-1">{task.message}</div>}
            <EventLog progress={progress} />
            <p className="mt-2 text-xs opacity-80">Draw it again above to try once more.</p>
          </div>
        ) : null}

        {deck ? (
          <div className="mt-4 border-t border-cs-line-soft pt-3">
            <p className="text-xs text-cs-ink-3">
              Drawn by {VISUAL_MODELS[deck.provider].name} at {deck.effort} thinking
              {deck.model ? ` with ${deck.model}` : ""}, from{" "}
              {deck.basis.source === "verdict"
                ? `the cross-check's verified answer (with the solutions by ${listNames(deck.basis.solvers.map(nameOf))})`
                : sourceLabel(deck.basis.source)}
              .
            </p>
            {deck.fixed ? (
              <p className="mt-1 text-xs text-cs-ink-3">
                Board {deck.fixed.board + 1} drawn again:{" "}
                <span className="italic text-cs-ink-2">&ldquo;{deck.fixed.instructions.split("\n")[0]}&rdquo;</span>
              </p>
            ) : null}
            {deck.notice ? (
              <div className="mt-2">
                <RevisionNotice message={deck.notice} />
              </div>
            ) : null}
            <div className="mt-3">
              <BoardViewer
                boards={deck.boards}
                focus={focus}
                onFix={onFix}
                drawer={VISUAL_MODELS[deck.provider].name}
                fixBlocked={
                  active
                    ? "A drawing is in progress."
                    : blocked ||
                      (configured(deck.provider)
                        ? undefined
                        : `${VISUAL_MODELS[deck.provider].name}, which drew these boards, is not configured on the server.`)
                }
              />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
