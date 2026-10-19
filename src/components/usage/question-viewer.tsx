// The usage page's question window (19 October 2026, the owner's request):
// the pages a student uploaded and the lecture notes sent with them, as the
// server keeps them (worker/questions.ts) - 24 hours after the question's
// last task, or for good once a PDF of one of its answers was made. Read
// from GET /api/admin/question/..., which only reads.

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Listing = { pages: string[]; notes: string[]; kept: boolean; deleteAt: number | null };

function formatTime(ms: number) {
  try {
    return new Date(ms).toLocaleString("en-HK", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function Pages({ question, names, label }: { question: string; names: string[]; label: string }) {
  return (
    <>
      {names.map((name, index) => (
        <figure key={name} className="mt-4 first:mt-0">
          <figcaption className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-cs-ink-3">
            {label} {index + 1}
          </figcaption>
          <a href={`/api/admin/question/${question}/${name}`} target="_blank" rel="noopener" title="Open the page by itself">
            <img
              src={`/api/admin/question/${question}/${name}`}
              alt={`${label} ${index + 1}`}
              className="w-full rounded-cs border border-cs-line bg-white"
            />
          </a>
        </figure>
      ))}
    </>
  );
}

export function QuestionViewer({ question, onClose }: { question: string; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/question/${question}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) return setError(`The pages could not be read (HTTP ${response.status}).`);
        setListing((await response.json()) as Listing);
      } catch {
        if (!abort.signal.aborted) setError("The pages could not be read.");
      }
    })();
    return () => abort.abort();
  }, [question]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const empty = listing && !listing.pages.length && !listing.notes.length;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="The question's pages"
        className="w-full max-w-3xl rounded-cs-lg border border-cs-line bg-cs-surface p-4 shadow-lg sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg text-cs-ink">The question · 題目</h2>
            <p className="font-mono text-xs text-cs-ink-3">{question}</p>
            {listing && !empty ? (
              <p className="mt-0.5 text-xs text-cs-ink-3">
                {listing.kept
                  ? "Kept for good: a PDF of one of its answers was made. 已整 PDF，永久保留。"
                  : listing.deleteAt
                    ? `Kept until ${formatTime(listing.deleteAt)}, 24 hours after its last task. 之後會刪除。`
                    : "Kept for 24 hours after its last task."}
              </p>
            ) : null}
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
        <div className="mt-4">
          {!listing && !error ? <p className="text-sm text-cs-ink-3">Reading the pages...</p> : null}
          {error ? <p className="text-sm text-[#a8321f]">{error}</p> : null}
          {empty ? (
            <p className="text-sm text-cs-ink-2">
              These pages are no longer kept: they are deleted 24 hours after the question's last task, unless a PDF
              of one of its answers was made. 題目已刪除。
            </p>
          ) : null}
          {listing ? <Pages question={question} names={listing.pages} label="Page" /> : null}
          {listing?.notes.length ? (
            <div className="mt-6 border-t border-cs-line-soft pt-4">
              <Pages question={question} names={listing.notes} label="Lecture notes page" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
