// "History · 紀錄" (3 October 2026): the questions solved in this browser,
// for revision - each with its first page, every solver's solution, the
// verdict and the study notes, kept as text after the server has deleted the
// answers (lib/history-store.ts). Read-only; a kept answer's PDF link works
// for good once the PDF was made, and within 24 hours of solving it can
// still be made. Lazy-loaded with the math renderer.

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, FileDown, History, Languages, Trash2, X } from "lucide-react";
import { extractQuantities, groupAnswers } from "../../shared/answers";
import { providerDisplayName, SOLUTION_ORDER, type ProviderKey } from "../../shared/providers";
import { STUDY_KINDS, STUDY_TITLES } from "../../shared/study";
import { clearHistory, deleteEntry, listEntries, type HistoryEntry } from "@/lib/history-store";
import MathProse from "./solve/math-prose";
import { ProviderLogo } from "./solve/provider-logo";
import { AllView } from "./solve/solution-views";

function formatWhen(savedAt: number) {
  try {
    return new Date(savedAt).toLocaleString("en-HK", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(savedAt).toISOString().slice(0, 16).replace("T", " ");
  }
}

function solvedBy(entry: HistoryEntry) {
  return SOLUTION_ORDER.filter((key) => entry.solutions[key]);
}

/** What the list says about an entry's answers: the verdict, or how far they agree. */
function summaryOf(entry: HistoryEntry) {
  const keys = solvedBy(entry);
  if (entry.verdict) {
    const right = entry.verdict.correct.map((key) => providerDisplayName(key, entry.solutions[key]?.variant));
    return right.length ? `Verified: ${right.join(", ")} correct` : "Verified: none correct";
  }
  if (keys.length < 2) return `${keys.length} solution`;
  const { groups } = groupAnswers(
    keys.map((key) => ({ key, quantities: extractQuantities(entry.solutions[key]?.artifact.finalAnswer ?? "") })),
  );
  const largest = groups[0]?.length ?? 0;
  return largest === keys.length ? `${keys.length} solutions, all agree` : largest > 1 ? `${largest} of ${keys.length} agree` : `${keys.length} solutions, answers differ`;
}

function PdfLink({ jobId }: { jobId?: string }) {
  if (!jobId) return null;
  return (
    <a
      href={`/api/pdf/${jobId}`}
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1 text-xs font-semibold text-cs-accent underline-offset-2 hover:underline"
      title="The PDF, if it was made - or made now, within 24 hours of solving"
    >
      <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
      PDF
    </a>
  );
}

function EntryView({ entry, onBack, onDelete }: { entry: HistoryEntry; onBack: () => void; onDelete: () => void }) {
  const keys = solvedBy(entry);
  const [active, setActive] = useState<ProviderKey | undefined>(keys[0]);
  const shown = active && entry.solutions[active] ? active : keys[0];
  const solution = shown ? entry.solutions[shown] : undefined;
  const mark = (key: ProviderKey) =>
    entry.verdict?.graded.includes(key) ? (entry.verdict.correct.includes(key) ? "correct" : "wrong") : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-cs-ink-2 hover:text-cs-accent"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All questions
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1.5 rounded-cs border border-cs-line px-3 py-1 text-xs font-semibold text-cs-ink-2 transition hover:border-cs-danger hover:text-cs-danger"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          Delete
        </button>
      </div>

      <div className="flex gap-3">
        {entry.thumbnail ? (
          <img src={entry.thumbnail} alt="The question's first page" className="h-24 w-auto shrink-0 rounded-cs border border-cs-line bg-white" />
        ) : null}
        <div className="min-w-0">
          <div className="font-display text-xl font-semibold text-cs-ink">{entry.title}</div>
          <div className="text-xs text-cs-ink-3">{formatWhen(entry.savedAt)}</div>
          {entry.notes ? <div className="mt-1 text-xs text-cs-ink-3">Your notes: {entry.notes}</div> : null}
        </div>
      </div>

      {entry.interpretation ? (
        <details className="group rounded-cs border border-cs-line-soft bg-cs-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-semibold text-cs-ink">
            Interpreted question
            <ChevronDown className="ml-auto h-4 w-4 text-cs-ink-3 transition group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="border-t border-cs-line-soft px-4 py-2">
            <MathProse source={entry.interpretation} />
          </div>
        </details>
      ) : null}

      {entry.verdict ? (
        <div className="rounded-cs border-2 border-cs-accent bg-cs-muted px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
            <span>
              Verified answer · 核對後答案{" "}
              <span className="normal-case tracking-normal">
                ({providerDisplayName(entry.verdict.judge, entry.verdict.variant)})
              </span>
            </span>
            <PdfLink jobId={entry.verdict.jobId} />
          </div>
          <MathProse source={entry.verdict.finalAnswer} className="text-sm" />
        </div>
      ) : null}

      {keys.length ? (
        <div className="overflow-hidden rounded-cs-lg border border-cs-line-soft bg-cs-surface">
          <div className="flex overflow-x-auto border-b-2 border-cs-line-soft px-2 pt-1">
            {keys.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={`relative flex shrink-0 items-center gap-1.5 px-4 py-3 text-sm font-semibold transition ${
                  shown === key ? "text-cs-accent" : "text-cs-ink-3 hover:text-cs-ink"
                }`}
              >
                <ProviderLogo provider={key} className="h-4 w-4 shrink-0" />
                {providerDisplayName(key, entry.solutions[key]?.variant)}
                {mark(key) === "correct" ? (
                  <Check className="h-3.5 w-3.5 text-cs-success" aria-label="Judged correct" />
                ) : mark(key) === "wrong" ? (
                  <X className="h-3.5 w-3.5 text-cs-danger" aria-label="Judged wrong" />
                ) : null}
                <span
                  className={`absolute bottom-0 left-0 right-0 h-[3px] rounded-t ${shown === key ? "bg-cs-accent" : "bg-transparent"}`}
                />
              </button>
            ))}
          </div>
          {solution ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 sm:px-7">
                <span className="font-display text-lg font-semibold text-cs-ink">{solution.artifact.title}</span>
                <PdfLink jobId={solution.jobId} />
              </div>
              <AllView artifact={solution.artifact} />
            </>
          ) : null}
        </div>
      ) : null}

      {STUDY_KINDS.filter((kind) => entry.study?.[kind]).map((kind) => {
        const notes = entry.study?.[kind];
        if (!notes) return null;
        return (
          <details key={kind} className="group rounded-cs border border-cs-line-soft bg-cs-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-semibold text-cs-ink">
              {STUDY_TITLES[kind].chinese} · {STUDY_TITLES[kind].title}
              <span className="ml-auto flex items-center gap-2">
                <PdfLink jobId={notes.jobId} />
                <ChevronDown className="h-4 w-4 text-cs-ink-3 transition group-open:rotate-180" aria-hidden="true" />
              </span>
            </summary>
            <div className="space-y-2 border-t border-cs-line-soft px-4 py-2">
              {notes.study.traditional_chinese ? (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.15em] text-cs-ink-3">
                    <Languages className="h-3.5 w-3.5" aria-hidden="true" />
                    繁體中文
                  </div>
                  <MathProse source={notes.study.traditional_chinese} chinese />
                </div>
              ) : null}
              <MathProse source={notes.study.guide} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

export default function HistoryDrawer({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const refresh = () => listEntries().then(setEntries);

  useEffect(() => {
    void refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const opened = useMemo(() => entries?.find((entry) => entry.savedAt === openId) ?? null, [entries, openId]);

  async function remove(savedAt: number) {
    if (!window.confirm("Delete this question from your history? 由紀錄刪除呢條題目？")) return;
    await deleteEntry(savedAt);
    setOpenId(null);
    await refresh();
  }

  async function removeAll() {
    if (!window.confirm("Delete every question from your history? 清空所有紀錄？")) return;
    await clearHistory();
    setOpenId(null);
    await refresh();
  }

  return (
    <div className="fixed inset-0 z-40 flex bg-black/40 print:hidden" onClick={onClose}>
      <div
        className="cs-backdrop ml-auto flex h-full w-full max-w-[760px] flex-col shadow-[0_0_40px_rgba(0,0,0,0.25)]"
        role="dialog"
        aria-modal="true"
        aria-label="History"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-cs-line-soft bg-cs-surface px-5 py-3">
          <span className="flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
            <History className="h-4 w-4 text-cs-accent" aria-hidden="true" />
            History · 題目紀錄
          </span>
          <button type="button" onClick={onClose} className="rounded-full p-2 text-cs-ink-3 hover:bg-cs-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {entries === null ? (
            <p className="text-sm text-cs-ink-3">Loading...</p>
          ) : opened ? (
            <EntryView entry={opened} onBack={() => setOpenId(null)} onDelete={() => void remove(opened.savedAt)} />
          ) : entries.length ? (
            <>
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <li key={entry.savedAt}>
                    <button
                      type="button"
                      onClick={() => setOpenId(entry.savedAt)}
                      className="flex w-full items-center gap-3 rounded-cs border border-cs-line-soft bg-cs-surface p-2 text-left transition hover:border-cs-accent"
                    >
                      {entry.thumbnail ? (
                        <img src={entry.thumbnail} alt="" className="h-14 w-14 shrink-0 rounded-cs border border-cs-line-soft bg-white object-cover" />
                      ) : (
                        <span className="h-14 w-14 shrink-0 rounded-cs bg-cs-muted" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-cs-ink">{entry.title}</span>
                        <span className="block text-xs text-cs-ink-3">{formatWhen(entry.savedAt)}</span>
                        <span className="block text-xs text-cs-ink-2">{summaryOf(entry)}</span>
                      </span>
                      <span className="flex shrink-0 -space-x-1">
                        {solvedBy(entry).map((key) => (
                          <span key={key} className="flex h-6 w-6 items-center justify-center rounded-full border border-cs-line-soft bg-white">
                            <ProviderLogo provider={key} className="h-3.5 w-3.5" />
                          </span>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-cs-ink-3">
                <span>Kept only in this browser, never on the server. 只存喺呢部機。</span>
                <button
                  type="button"
                  onClick={() => void removeAll()}
                  className="inline-flex items-center gap-1 font-semibold hover:text-cs-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Clear all
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-cs-ink-3">
              Nothing yet. Every question you solve is kept here, in this browser, so you can revise
              it later. 解過嘅題目會存喺呢度，方便溫習。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
