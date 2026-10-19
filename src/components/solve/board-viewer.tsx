// A deck of Visualize boards (shared/visual.ts), one at a time: its title and
// note above, the board in a sandboxed frame, the problems the frame reported
// under it, and - on the page, not in the History - a way to have one board
// drawn again. The deck's layout comes from the owner's rebuild of Kimi's
// 可视题解 (visual-solution-api, BoardViewer.tsx); the frame is ours
// (lib/board-document.ts): "allow-scripts" only - no same-origin, popups,
// forms or modals as that rebuild allowed - and a Content-Security-Policy
// written ahead of the board.
//
// For lazy-loaded components only: MathTitle brings the math renderer.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Maximize2, Minimize2, RotateCcw, Wrench } from "lucide-react";
import type { VisualBoard } from "../../../shared/visual";
import {
  boardDocument,
  isBoardMessage,
  readBoardReports,
  readPalette,
  type BoardReport,
} from "@/lib/board-document";
import { MathTitle } from "./math-title";
import { RevisePanel } from "./revise-panel";

/** The frame's height before the board has measured itself, and its bounds after. */
const START_HEIGHT = 420;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 900;
/** Reports kept per load: a board that throws in a loop would otherwise grow without end. */
const MAX_REPORTS = 20;

// Unique across every viewer on the page, so a report is only ever read by
// the load it came from (a frame being replaced can still have one in flight).
let nextGeneration = 1;

export function BoardViewer({
  boards,
  onFix,
  fixBlocked,
  focus,
}: {
  boards: VisualBoard[];
  /** Draws one board again with the instructions; absent where the deck is read-only. */
  onFix?: (index: number, instructions: string) => void;
  /** Set while a board cannot be drawn again, saying why. */
  fixBlocked?: string;
  /** A board to turn to, such as the one just drawn again. */
  focus?: number;
}) {
  const [at, setAt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [reports, setReports] = useState<BoardReport[]>([]);
  const [size, setSize] = useState<Extract<BoardReport, { type: "size" }> | null>(null);
  const [leftPage, setLeftPage] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const loadsRef = useRef(0);

  const index = Math.min(at, Math.max(0, boards.length - 1));
  const board = boards[index];
  useEffect(() => {
    if (focus !== undefined) setAt(focus);
  }, [focus]);

  // The theme's colours go into the frame; a new theme reloads the board.
  // Read once <html> carries the new data-theme: the theme provider sets it
  // in an effect, after this component has rendered (and after its effects,
  // which run before an ancestor's), so reading on render got the old one.
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const watch = new MutationObserver(() => {
      const next = readPalette();
      // The same theme set again must not reload a board mid-animation.
      setPalette((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch.disconnect();
  }, []);
  const generation = useMemo(
    () => nextGeneration++,
    [board?.html, palette, reloads], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const srcDoc = useMemo(
    () => (board ? boardDocument(board.html, { generation, palette }) : ""),
    [board, generation, palette],
  );

  useEffect(() => {
    loadsRef.current = 0;
    setReports([]);
    setSize(null);
    setLeftPage(false);
  }, [generation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data;
      if (!isBoardMessage(data) || data.generation !== generationRef.current) return;
      if (data.type === "size") {
        setSize({ type: "size", ready: Boolean(data.ready), height: Number(data.height) || 0, width: Number(data.width) || 0, overflowX: Number(data.overflowX) || 0, empty: Boolean(data.empty) });
        return;
      }
      const text = String(data.text ?? "").slice(0, 400);
      setReports((current) => (current.length >= MAX_REPORTS ? current : [...current, { type: data.type, text } as BoardReport]));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (!board) return null;

  // The frame loads its document once. A second load is the board
  // navigating itself away (location, a meta refresh), which nothing on it
  // should do: the frame is taken down rather than left showing who knows what.
  const onLoad = () => {
    loadsRef.current += 1;
    if (loadsRef.current > 1) setLeftPage(true);
  };

  const problems = readBoardReports(size ? [...reports, size] : reports);
  const height = Math.min(MAX_HEIGHT, Math.round(window.innerHeight * 0.8), Math.max(MIN_HEIGHT, size?.height ? size.height + 4 : START_HEIGHT));
  const count = boards.length;
  const go = (next: number) => setAt(Math.max(0, Math.min(count - 1, next)));
  const fix = (instructions: string) => onFix?.(index, instructions);
  const caught = problems.length
    ? `The page caught these problems on this board:\n${problems.map((line) => `- ${line}`).join("\n")}`
    : "";

  return (
    <div
      className={
        expanded
          ? "fixed inset-0 z-[70] flex flex-col gap-3 bg-cs-page p-3 sm:p-6"
          : "flex flex-col gap-3"
      }
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold leading-snug text-cs-ink">
            <MathTitle text={board.title} />
            {board.title_zh ? (
              <span lang="zh-Hant" className="ml-2 text-sm font-normal text-cs-ink-2">
                {board.title_zh}
              </span>
            ) : null}
          </p>
          {board.note || board.note_zh ? (
            <p className="mt-0.5 text-sm text-cs-ink-3">
              {board.note}
              {board.note && board.note_zh ? " · " : ""}
              {board.note_zh ? <span lang="zh-Hant">{board.note_zh}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {count > 1 ? (
            <>
              <button
                type="button"
                onClick={() => go(index - 1)}
                disabled={index === 0}
                aria-label="Previous board"
                className="rounded-cs p-1.5 text-cs-ink-2 transition hover:bg-cs-muted disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="min-w-10 text-center text-xs tabular-nums text-cs-ink-3">
                {index + 1} / {count}
              </span>
              <button
                type="button"
                onClick={() => go(index + 1)}
                disabled={index === count - 1}
                aria-label="Next board"
                className="rounded-cs p-1.5 text-cs-ink-2 transition hover:bg-cs-muted disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-label={expanded ? "Back to the page" : "Enlarge the board"}
            title={expanded ? "Back to the page (Esc)" : "Enlarge"}
            className="rounded-cs p-1.5 text-cs-ink-2 transition hover:bg-cs-muted"
          >
            {expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div
        className={`overflow-hidden rounded-cs border border-cs-line-soft bg-cs-surface ${expanded ? "min-h-0 flex-1" : ""}`}
      >
        {leftPage ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center text-sm text-cs-ink-2" style={{ minHeight: MIN_HEIGHT }}>
            <p>This board tried to leave the page, so it was stopped.</p>
            <button
              type="button"
              onClick={() => setReloads((value) => value + 1)}
              className="inline-flex items-center gap-1.5 rounded-cs border border-cs-line px-3 py-1.5 text-cs-ink transition hover:bg-cs-muted"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Load it again
            </button>
          </div>
        ) : (
          <iframe
            key={generation}
            ref={frameRef}
            title={`Board ${index + 1}: ${board.title}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={srcDoc}
            onLoad={onLoad}
            className="block w-full border-0"
            style={expanded ? { height: "100%" } : { height }}
          />
        )}
      </div>

      {count > 1 && !expanded ? (
        <div className="flex justify-center gap-1.5" role="tablist" aria-label="Boards">
          {boards.map((entry, dot) => (
            <button
              key={dot}
              type="button"
              role="tab"
              aria-selected={dot === index}
              aria-label={`Board ${dot + 1}: ${entry.title}`}
              onClick={() => go(dot)}
              className={`h-1.5 rounded-full transition-all ${dot === index ? "w-5 bg-cs-accent" : "w-1.5 bg-cs-line hover:bg-cs-ink-3"}`}
            />
          ))}
        </div>
      ) : null}

      {problems.length && !expanded ? (
        <div className="rounded-cs border border-[#f3cf9f] bg-[rgba(230,126,34,0.10)] px-4 py-3 text-sm text-[#a85a12]">
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            This board reported {problems.length === 1 ? "a problem" : `${problems.length} problems`}
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 break-words">
            {problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {onFix ? (
            <button
              type="button"
              onClick={() => fix(`${caught}\nFix them.`)}
              disabled={Boolean(fixBlocked)}
              title={fixBlocked}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-cs bg-cs-accent px-3 py-1.5 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:opacity-50"
            >
              <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
              Fix this board · <span lang="zh-Hant">修正呢張</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {onFix && !expanded ? (
        <RevisePanel
          key={index}
          title="Change this board · 改呢張"
          hint="DeepSeek draws this board again with your instructions; the other boards stay as they are."
          placeholder="e.g. Make the 10 kN load draggable and show the reactions change"
          buttonLabel="Draw it again"
          disabledReason={fixBlocked}
          onSubmit={(instructions) => fix(caught ? `${instructions}\n\n${caught}` : instructions)}
        />
      ) : null}
    </div>
  );
}
