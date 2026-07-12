import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2 } from "lucide-react";
import type { ProviderArtifact, ProviderKey } from "../../../shared/solution";
import { isRunActive, type ProviderRuns } from "@/hooks/use-solve";
import { exportPdf, exportTex, openInOverleaf } from "@/lib/exports";
import { renderMarkdown } from "@/lib/math-markdown";
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

export default function SolutionPanel({ runs }: { runs: ProviderRuns }) {
  const [activeProvider, setActiveProvider] = useState<ProviderKey>("codex");
  const [activeView, setActiveView] = useState<ViewKey>("steps");

  const visibleProviders = PROVIDER_OPTIONS.filter(
    (provider) => runs[provider.key].status !== "idle",
  );
  const firstDone = visibleProviders.find(
    (provider) => runs[provider.key].status === "done",
  )?.key;

  // Auto-activate the first finished provider once, or keep a sensible tab
  // active while the current one has nothing to show yet.
  useEffect(() => {
    if (runs[activeProvider].status === "idle" && visibleProviders.length) {
      setActiveProvider(firstDone ?? visibleProviders[0].key);
    } else if (firstDone && runs[activeProvider].status !== "done" && !isRunActive(runs[activeProvider])) {
      setActiveProvider(firstDone);
    }
  }, [runs, activeProvider, firstDone, visibleProviders]);

  const activeRun = runs[activeProvider];
  const activeArtifact = activeRun.status === "done" ? activeRun.solution : null;
  const activeLabel = PROVIDER_OPTIONS.find((p) => p.key === activeProvider)?.label ?? "";

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

      <div className="overflow-hidden rounded-2xl border border-[#e8e3db] bg-white shadow-[0_4px_16px_rgba(27,22,16,0.08)] print:hidden dark:border-[#1e2a40] dark:bg-[#151d2e]">
        <div className="border-b-2 border-[#e8e3db] px-2 pt-1 dark:border-[#1e2a40]">
          <div className="flex overflow-x-auto">
            {visibleProviders.map((provider) => {
              const run = runs[provider.key];
              return (
                <button
                  key={provider.key}
                  type="button"
                  onClick={() => setActiveProvider(provider.key)}
                  className={`relative shrink-0 px-4 py-3 pr-8 text-left text-sm font-semibold transition ${
                    activeProvider === provider.key
                      ? "text-[#b35c1e] dark:text-[#e8903a]"
                      : "text-[#8a7f72] hover:text-[#1b1610] dark:text-[#a8a098] dark:hover:text-[#e4e0db]"
                  }`}
                >
                  <div>{provider.label}</div>
                  <div className="text-[11px] font-normal opacity-80">{provider.note}</div>
                  <span
                    className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${
                      activeProvider === provider.key ? "bg-[#b35c1e] dark:bg-[#e8903a]" : "bg-transparent"
                    }`}
                  />
                  {isRunActive(run) ? (
                    <Loader2 className="absolute right-2.5 top-3 h-3 w-3 animate-spin text-[#8a7f72] dark:text-[#a8a098]" />
                  ) : (
                    <span
                      className={`absolute right-3 top-3 h-2.5 w-2.5 rounded-full ${
                        run.status === "error"
                          ? "bg-[#c0392b] dark:bg-[#f2b8b2]"
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
                <button
                  type="button"
                  onClick={() => exportTex(activeArtifact)}
                  className="inline-flex items-center gap-2 rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-2 text-sm font-semibold text-[#1b1610] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#e4e0db]"
                >
                  <Download className="h-4 w-4" />
                  LaTeX (.tex)
                </button>
                <button
                  type="button"
                  onClick={() => openInOverleaf(activeArtifact)}
                  className="inline-flex items-center gap-2 rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-2 text-sm font-semibold text-[#1b1610] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#e4e0db]"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open in Overleaf
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
              <div className="rounded-[10px] border border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] px-4 py-3 text-sm text-[#c0392b] dark:border-[#5b2a31] dark:text-[#f2b8b2]">
                {activeRun.message}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 text-sm text-[#5c5347] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#cfc7bf]">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#b35c1e] dark:text-[#e8903a]" />
                {activeRun.status === "streaming"
                  ? `${activeLabel} is writing the solution... ${activeRun.charsReceived.toLocaleString()} characters received.`
                  : activeRun.status === "waiting"
                    ? activeRun.message
                    : "Waiting..."}
              </div>
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
