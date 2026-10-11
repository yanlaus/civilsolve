// The charts and diagrams a question asks the student to draw (12 October
// 2026, the owner's request). The solvers write text only, so each one comes
// described - its key points for the student - with a prompt to paste into
// an AI that draws pictures, Gemini by default: one tap copies it and opens
// Gemini, and the student pastes and sends (shared/solution.ts,
// SolutionDiagram; the solve prompt's DIAGRAM_RULES).

import { useState } from "react";
import { Check, Copy, ExternalLink, LineChart } from "lucide-react";
import type { SolutionDiagram } from "../../../shared/solution";
import MathProse from "./math-prose";
import { MathTitle } from "./math-title";

const GEMINI_URL = "https://gemini.google.com/app";

/** Puts text on the clipboard; a hidden text box where the Clipboard API is refused. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

export function DiagramList({ diagrams }: { diagrams: SolutionDiagram[] }) {
  const count = diagrams.length;
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-cs-ink-2">
        The question asks you to draw {count === 1 ? "this diagram" : `these ${count} diagrams`}. To see one drawn,
        copy its prompt into an AI that draws pictures, such as Gemini.
        <span className="block text-cs-ink-3" lang="zh-Hant-HK">
          題目要你畫{count === 1 ? "呢張圖" : `呢 ${count} 張圖`}。想睇畫好嘅樣，複製指示貼去 Gemini 就得。
        </span>
      </p>
      {diagrams.map((diagram, index) => (
        <DiagramCard key={`${index}:${diagram.title}`} diagram={diagram} />
      ))}
      <p className="text-xs leading-5 text-cs-ink-3">
        An AI drawing can get a number or a shape wrong - check it against the key points above. · AI
        畫嘅圖可能有錯，請對返上面嘅重點數值。
      </p>
    </div>
  );
}

function DiagramCard({ diagram }: { diagram: SolutionDiagram }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = () => {
    void copyText(diagram.prompt).then(setCopied);
  };

  return (
    <section className="rounded-cs border border-cs-line-soft bg-cs-surface">
      <header className="flex items-center gap-2 border-b border-cs-line-soft px-4 py-2.5">
        <LineChart className="h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
        <MathTitle text={diagram.title} className="min-w-0 font-semibold text-cs-ink" />
      </header>
      <div className="px-4 py-3">
        {diagram.description ? <MathProse source={diagram.description} /> : null}
        {diagram.prompt ? (
          <div className="mt-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
              Prompt to have it drawn · 畫圖指示
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-cs border border-cs-line-soft bg-cs-muted px-3 py-2 font-sans text-xs leading-5 text-cs-ink-2">
              {diagram.prompt}
            </pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Copies, then opens Gemini in a new tab as the link's own
                  action - a pop-up the browser would block otherwise. */}
              <a
                href={GEMINI_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={copy}
                className="cs-primary inline-flex items-center gap-1.5 rounded-cs bg-cs-accent px-3 py-1.5 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                Copy &amp; open Gemini · 複製再開 Gemini
              </a>
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1.5 rounded-cs border border-cs-line px-3 py-1.5 text-sm font-semibold text-cs-ink-2 transition hover:border-cs-accent hover:text-cs-accent"
              >
                <Copy className="h-4 w-4" aria-hidden="true" />
                Copy prompt · 複製指示
              </button>
            </div>
            {copied === true ? (
              <p className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-cs-success" role="status">
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
                Copied - paste it into Gemini and send. · 已複製，貼去 Gemini 再傳送。
              </p>
            ) : copied === false ? (
              <p className="mt-1.5 text-xs text-cs-danger" role="status">
                This browser would not copy it - select the prompt above and copy it by hand. · 未能自動複製，請自己揀選上面嘅指示再複製。
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
