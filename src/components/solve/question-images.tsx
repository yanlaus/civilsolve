// The question as uploaded, beside what was made of it (3 October 2026): in
// the review step, where the student checks the reading against the diagram,
// and above the solutions. The pages are the prepared JPEGs the run was sent
// with - kept in memory and in this browser's IndexedDB, never on the
// server. A page opens full screen, where it can be enlarged and panned.

import { useEffect, useState } from "react";
import { Minus, Plus, X, ZoomIn } from "lucide-react";

const ZOOMS = [1, 1.5, 2, 3];

export function QuestionImages({ images }: { images: string[] }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(0);
  const page = Math.min(index, images.length - 1);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!images.length) return null;

  return (
    <div>
      {images.length > 1 ? (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Question pages">
          {images.map((image, at) => (
            <button
              key={at}
              type="button"
              role="tab"
              aria-selected={at === page}
              aria-label={`Page ${at + 1}`}
              onClick={() => setIndex(at)}
              className={`relative shrink-0 overflow-hidden rounded-cs border-2 transition ${
                at === page ? "border-cs-accent" : "border-cs-line-soft hover:border-cs-line"
              }`}
            >
              <img src={image} alt="" className="h-14 w-11 object-cover" />
              <span className="absolute bottom-0 right-0 bg-black/60 px-1 text-[0.6rem] font-semibold text-white">
                {at + 1}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => {
          setZoom(0);
          setOpen(true);
        }}
        className="group relative block w-full overflow-hidden rounded-cs border border-cs-line bg-white"
        title="Open the page full screen"
      >
        <img src={images[page]} alt={`Question, page ${page + 1}`} className="w-full" />
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[0.7rem] font-semibold text-white">
          <ZoomIn className="h-3.5 w-3.5" aria-hidden="true" />
          Enlarge · 放大
        </span>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/85 print:hidden"
          role="dialog"
          aria-modal="true"
          aria-label={`Question, page ${page + 1}`}
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-white">
            <span className="text-sm font-semibold">
              Page {page + 1}
              {images.length > 1 ? ` of ${images.length}` : ""}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setZoom((current) => Math.max(0, current - 1))}
                disabled={zoom === 0}
                className="rounded-full p-2 hover:bg-white/15 disabled:opacity-40"
                aria-label="Zoom out"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-10 text-center text-xs tabular-nums">{ZOOMS[zoom]}×</span>
              <button
                type="button"
                onClick={() => setZoom((current) => Math.min(ZOOMS.length - 1, current + 1))}
                disabled={zoom === ZOOMS.length - 1}
                className="rounded-full p-2 hover:bg-white/15 disabled:opacity-40"
                aria-label="Zoom in"
              >
                <Plus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-2 rounded-full p-2 hover:bg-white/15"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </span>
          </div>
          {/* Scroll to pan; pinch-zoom works too where the browser allows it. */}
          <div className="min-h-0 flex-1 overflow-auto" style={{ touchAction: "pan-x pan-y pinch-zoom" }}>
            <img
              src={images[page]}
              alt={`Question, page ${page + 1}`}
              className="mx-auto block max-w-none bg-white"
              style={{ width: `${ZOOMS[zoom] * 100}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
