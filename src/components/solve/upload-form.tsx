import { useEffect, useRef, useState } from "react";
import {
  Asterisk,
  Atom,
  BookOpen,
  Brain,
  Calculator,
  Eye,
  Feather,
  FileImage,
  Flag,
  FileText,
  Flame,
  Gem,
  Lightbulb,
  Loader2,
  Moon,
  Orbit,
  PenSquare,
  Scale,
  Sparkles,
  TriangleAlert,
  Upload,
  Waves,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { InterpretConfig } from "@/hooks/use-interpret";
import { MAX_JUDGED_SOLUTIONS } from "../../../shared/judgement";
import { EFFORT_KEYS, type EffortKey } from "../../../shared/prompt";
import {
  CHANNEL_LABELS,
  CHINA_PROVIDERS,
  DEFAULT_INTERPRETERS,
  DEFAULT_JUDGE,
  DEFAULT_SOLVERS,
  DEFAULT_VERIFIER,
  HIGHER_CREDIT_PROVIDERS,
  LOWER_CREDIT_PROVIDERS,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  SOLVER_KEYS,
  UNSTABLE_PROVIDERS,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import { isAcceptedUpload, isPdfFile, type UploadItem } from "@/lib/attachments";
import { parsePageSpec } from "@/lib/page-range";
import { MAX_IMAGES } from "../../../shared/stream-protocol";

type QueuedFile = {
  id: string;
  file: File;
  previewUrl?: string;
  /** PDFs: the page count, once read; undefined while it is being read. */
  pageCount?: number;
  /** PDFs: why the page count could not be read. */
  pageError?: string;
  /** PDFs: which pages to send, as typed ("" means every page). */
  pageSpec?: string;
};

export type SolveSubmission = {
  /** Assignment files; each PDF with the pages chosen from it. */
  uploads: UploadItem[];
  /** Reference material for method/notation, never solved. */
  lectureFiles: File[];
  /** The selected solvers, in picker order; they run together. */
  providers: ProviderKey[];
  notes: string;
  effort: EffortKey;
  /** Null when the user leaves the interpretation pass switched off. */
  verify: InterpretConfig | null;
  /** The judge for the answer cross-check; null when it is switched off. */
  judge: ProviderKey | null;
};

const MAX_FILES = 10;
const MAX_LECTURE_FILES = 6;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

// Every provider: the reader, reconciler and judge lists (and the solution
// tabs). The solver cards show SOLVER_OPTIONS, which leaves out the
// review-only providers - Kimi reads and judges but does not solve.
export const PROVIDER_OPTIONS: Array<{ key: ProviderKey; label: string }> =
  PROVIDER_KEYS.map((key) => ({ key, label: PROVIDER_LABELS[key] }));

const SOLVER_OPTIONS = PROVIDER_OPTIONS.filter((option) => SOLVER_KEYS.includes(option.key));

// One glyph per provider so the cards read at a glance. Lucide, like the rest
// of the UI, rather than vendor logos: no assets, no trademark questions, and
// they take the accent colour in both themes.
const PROVIDER_ICONS: Record<ProviderKey, LucideIcon> = {
  chatgpt: Sparkles,
  gemini: Gem,
  deepseek: Waves,
  grok: Zap,
  mimo: Orbit,
  minimax: Atom,
  kimi: Moon,
  muse: Lightbulb,
  claude: Asterisk,
};

const EFFORT_OPTIONS: Array<{ key: EffortKey; label: string }> = [
  { key: "none", label: "None" },
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "max", label: "Max" },
];

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadForm({
  providerStatus,
  busy,
  solving,
  status,
  error,
  onSolve,
  onCancel,
}: {
  /** What GET /api/health reported (hooks/use-health.ts); null until it answers. */
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  busy: boolean;
  /** True only while provider requests are in flight (image prep excluded). */
  solving: boolean;
  status: string;
  error: string;
  onSolve: (submission: SolveSubmission) => void;
  onCancel: () => void;
}) {
  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
  const [lectureFiles, setLectureFiles] = useState<QueuedFile[]>([]);
  const [notes, setNotes] = useState("");
  const [verifyEnabled, setVerifyEnabled] = useState(false);
  const [interpreterA, setInterpreterA] = useState<ProviderKey>(DEFAULT_INTERPRETERS[0]);
  const [interpreterB, setInterpreterB] = useState<ProviderKey>(DEFAULT_INTERPRETERS[1]);
  const [verifier, setVerifier] = useState<ProviderKey>(DEFAULT_VERIFIER);
  const [readerEffort, setReaderEffort] = useState<EffortKey>("medium");
  const [crossCheckEnabled, setCrossCheckEnabled] = useState(false);
  const [judge, setJudge] = useState<ProviderKey>(DEFAULT_JUDGE);
  const [effort, setEffort] = useState<EffortKey>("high");
  const [selectedProviders, setSelectedProviders] = useState<ProviderKey[]>(DEFAULT_SOLVERS);
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return () => {
      queuedFiles.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [queuedFiles]);

  // Once the server says which providers actually have a key, untick the
  // ones that do not.
  useEffect(() => {
    if (!providerStatus) return;
    setSelectedProviders((current) => {
      const configured = current.filter((key) => providerStatus[key]?.configured);
      if (configured.length) return configured;
      const firstConfigured = SOLVER_KEYS.find((key) => providerStatus[key]?.configured);
      return firstConfigured ? [firstConfigured] : current;
    });
  }, [providerStatus]);

  const isAvailable = (provider: ProviderKey) =>
    providerStatus ? providerStatus[provider]?.configured !== false : true;

  const noneConfigured = Boolean(
    providerStatus && SOLVER_KEYS.every((key) => !providerStatus[key]?.configured),
  );

  // Some routes put a floor under the reasoning level (minEffort; a pinned
  // forceEffort counts as a floor too), and the Worker applies that
  // regardless of what is sent. One level serves every selected solver, so
  // the highest floor among them rules, and it is shown here instead of
  // letting the user pick a level that is silently raised: ChatGPT floors at
  // "high".
  const providerFloor = (key: ProviderKey) => {
    const status = providerStatus?.[key];
    const floor = status?.forcedEffort ?? status?.minEffort;
    return floor ? EFFORT_KEYS.indexOf(floor as EffortKey) : -1;
  };
  const providerCeiling = (key: ProviderKey) => {
    const status = providerStatus?.[key];
    const ceiling = status?.forcedEffort ?? status?.maxEffort;
    return ceiling ? EFFORT_KEYS.indexOf(ceiling as EffortKey) : EFFORT_KEYS.length;
  };
  const floorIndex = selectedProviders.reduce(
    (highest, key) => Math.max(highest, providerFloor(key)),
    -1,
  );
  const ceilingIndex = selectedProviders.reduce(
    (lowest, key) => Math.min(lowest, providerCeiling(key)),
    EFFORT_KEYS.length,
  );
  const effortFloor = floorIndex > 0 ? EFFORT_KEYS[floorIndex] : undefined;
  const effortCeiling =
    ceilingIndex < EFFORT_KEYS.length - 1 ? EFFORT_KEYS[ceilingIndex] : undefined;
  const labelsFor = (matches: (key: ProviderKey) => boolean) =>
    selectedProviders.filter(matches).map((key) => PROVIDER_LABELS[key]).join(" and ");
  const floorLabels = labelsFor((key) => providerFloor(key) === floorIndex);
  const ceilingLabels = labelsFor((key) => providerCeiling(key) === ceilingIndex);

  // A floor above a ceiling leaves no level that suits every solver. Nothing
  // is clamped or disabled then - the run is blocked instead (below), so the
  // two rules cannot fight over the same value.
  const bandIsEmpty = floorIndex > ceilingIndex;

  const isEffortLocked = (key: EffortKey) => {
    if (bandIsEmpty) return false;
    const index = EFFORT_KEYS.indexOf(key);
    return (floorIndex > 0 && index < floorIndex) || index > ceilingIndex;
  };

  // Snap the visible level into the band when the current pick falls outside
  // it. Deselecting the provider that set the bound keeps the level the user
  // last chose rather than moving it back.
  useEffect(() => {
    if (bandIsEmpty) return;
    setEffort((current) => {
      const index = EFFORT_KEYS.indexOf(current);
      if (floorIndex > 0 && index < floorIndex) return EFFORT_KEYS[floorIndex];
      if (index > ceilingIndex) return EFFORT_KEYS[ceilingIndex];
      return current;
    });
  }, [bandIsEmpty, floorIndex, ceilingIndex]);

  // Two readers that are the same model would just agree with themselves.
  const verifyConfigError =
    verifyEnabled && interpreterA === interpreterB
      ? "Pick two different models to read the question independently."
      : "";

  const solverConfigError =
    bandIsEmpty
      ? `${floorLabels} needs at least ${effortFloor} thinking and ${ceilingLabels} cannot go above ${effortCeiling} — pick one or the other.`
      : selectedProviders.length === 0
        ? "Pick at least one AI provider to solve with."
        : crossCheckEnabled && selectedProviders.length < 2
          ? "Pick at least two solvers for the cross-check to compare."
          : crossCheckEnabled && selectedProviders.length > MAX_JUDGED_SOLUTIONS
            ? `The cross-check compares up to ${MAX_JUDGED_SOLUTIONS} solutions - untick some solvers.`
            : "";

  // Every page that will be sent: one per image, the chosen pages of each PDF.
  // A paper longer than the request can carry makes the user choose pages
  // rather than losing the rest without a word.
  const pageSelections = queuedFiles.map((item) => {
    if (!isPdfFile(item.file)) return { item, pages: 1 };
    if (item.pageError) return { item, error: `${item.file.name}: ${item.pageError}` };
    if (item.pageCount === undefined) return { item, pending: true };
    const selection = parsePageSpec(item.pageSpec ?? "", item.pageCount);
    return "error" in selection
      ? { item, error: `${item.file.name}: ${selection.error}` }
      : { item, pages: selection.pages.length, chosen: selection.pages };
  });
  const countingPages = pageSelections.some((entry) => entry.pending);
  const totalPages = pageSelections.reduce((sum, entry) => sum + (entry.pages ?? 0), 0);
  const hasPdf = queuedFiles.some((item) => isPdfFile(item.file));
  const pageConfigError =
    pageSelections.find((entry) => entry.error)?.error ??
    (!countingPages && totalPages > MAX_IMAGES
      ? `That is ${totalPages} pages, and up to ${MAX_IMAGES} can be sent at once. Choose the pages to solve for each PDF below (for example 1-6).`
      : "");

  const canSubmit =
    queuedFiles.length > 0 &&
    selectedProviders.every(isAvailable) &&
    !verifyConfigError &&
    !solverConfigError &&
    !pageConfigError &&
    !countingPages &&
    !busy;

  // Each queued PDF has its pages counted once, in the background.
  const countRequested = useRef(new Set<string>());
  useEffect(() => {
    for (const item of queuedFiles) {
      if (!isPdfFile(item.file) || countRequested.current.has(item.id)) continue;
      countRequested.current.add(item.id);
      readPageCount(item.id, item.file);
    }
  }, [queuedFiles]);

  /** Reads a queued PDF's page count (pdf.js loads on demand). */
  function readPageCount(id: string, file: File) {
    import("@/lib/pdf-to-images")
      .then(({ pdfPageCount }) => pdfPageCount(file))
      .then((pageCount) => {
        setQueuedFiles((current) =>
          current.map((item) => (item.id === id ? { ...item, pageCount } : item)),
        );
      })
      .catch(() => {
        setQueuedFiles((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, pageError: "could not be opened as a PDF (damaged or password-protected?)" }
              : item,
          ),
        );
      });
  }

  function setPageSpec(id: string, pageSpec: string) {
    setQueuedFiles((current) =>
      current.map((item) => (item.id === id ? { ...item, pageSpec } : item)),
    );
  }

  function addFiles(inputFiles: FileList | File[]) {
    const next = Array.from(inputFiles);
    const nextQueued: QueuedFile[] = [];
    let nextError = "";

    setQueuedFiles((current) => {
      const existingKeys = new Set(
        current.map((item) => `${item.file.name}-${item.file.size}-${item.file.lastModified}`),
      );

      for (const file of next) {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (existingKeys.has(key)) continue;
        if (current.length + nextQueued.length >= MAX_FILES) {
          nextError = `You can upload up to ${MAX_FILES} files at a time.`;
          break;
        }
        if (!isAcceptedUpload(file)) {
          nextError = `Unsupported file type: ${file.name}. Use JPEG, PNG, WebP, GIF, or PDF.`;
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          nextError = `${file.name} is larger than 25 MB.`;
          continue;
        }

        let previewUrl: string | undefined;
        if (!isPdfFile(file)) {
          try {
            previewUrl = URL.createObjectURL(file);
          } catch {
            // Preview is best-effort; the file can still be submitted.
          }
        }

        nextQueued.push({ id: key, file, previewUrl });
        existingKeys.add(key);
      }

      return [...current, ...nextQueued];
    });

    setFileError(nextError);
  }

  function addLectureFiles(inputFiles: FileList | File[]) {
    const next = Array.from(inputFiles);
    let nextError = "";

    setLectureFiles((current) => {
      const existingKeys = new Set(current.map((item) => item.id));
      const added: QueuedFile[] = [];

      for (const file of next) {
        const key = `${file.name}-${file.size}-${file.lastModified}`;
        if (existingKeys.has(key)) continue;
        if (current.length + added.length >= MAX_LECTURE_FILES) {
          nextError = `You can attach up to ${MAX_LECTURE_FILES} lecture-notes files.`;
          break;
        }
        if (!isAcceptedUpload(file)) {
          nextError = `Unsupported file type: ${file.name}. Use JPEG, PNG, WebP, GIF, or PDF.`;
          continue;
        }
        if (file.size > MAX_FILE_SIZE) {
          nextError = `${file.name} is larger than 25 MB.`;
          continue;
        }
        added.push({ id: key, file });
        existingKeys.add(key);
      }

      return [...current, ...added];
    });

    setFileError(nextError);
  }

  function removeLectureFile(id: string) {
    setLectureFiles((current) => current.filter((item) => item.id !== id));
  }

  function removeFile(id: string) {
    // The same file added again is counted again.
    countRequested.current.delete(id);
    setQueuedFiles((current) => {
      const match = current.find((item) => item.id === id);
      if (match?.previewUrl) URL.revokeObjectURL(match.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  // Keeps picker order, which is also the order the judge sees solutions in.
  function toggleProvider(provider: ProviderKey) {
    setSelectedProviders((current) =>
      current.includes(provider)
        ? current.filter((key) => key !== provider)
        : SOLVER_KEYS.filter((key) => key === provider || current.includes(key)),
    );
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    onSolve({
      uploads: pageSelections.map((entry) => ({ file: entry.item.file, pages: entry.chosen })),
      lectureFiles: lectureFiles.map((item) => item.file),
      providers: selectedProviders,
      notes,
      effort,
      verify: verifyEnabled ? { interpreterA, interpreterB, verifier, readerEffort } : null,
      judge: crossCheckEnabled ? judge : null,
    });
  }

  const bannerError =
    error || fileError || pageConfigError || verifyConfigError || solverConfigError;

  return (
    <form className="space-y-5 print:hidden" onSubmit={handleSubmit}>
      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Upload className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Upload Assignment Materials
        </p>

        <label
          className={`relative block cursor-pointer overflow-hidden rounded-2xl border-2 border-dashed bg-white px-6 py-12 text-center shadow-[0_1px_3px_rgba(27,22,16,0.06)] transition dark:bg-[#151d2e] ${
            isDragging
              ? "border-[#b35c1e] shadow-[0_0_0_4px_rgba(179,92,30,0.15)] dark:border-[#e8903a]"
              : "border-[#d4cdc3] hover:border-[#b35c1e] hover:shadow-[0_0_0_4px_rgba(179,92,30,0.15)] dark:border-[#2a3650] dark:hover:border-[#e8903a]"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            if (event.dataTransfer.files.length > 0) {
              addFiles(event.dataTransfer.files);
            }
          }}
        >
          <div className="relative">
            <div className="mb-3 text-[#b35c1e] dark:text-[#e8903a]">
              <FileImage className="mx-auto h-10 w-10" />
            </div>
            <p className="text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
              Drag and drop your files here
            </p>
            <p className="mt-1 text-sm text-[#8a7f72] dark:text-[#a8a098]">
              or <span className="font-semibold text-[#b35c1e] dark:text-[#e8903a]">browse</span> — JPEG, PNG, WebP, GIF, and PDF accepted
            </p>
          </div>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Choose assignment images or PDFs"
            onChange={(event) => {
              if (event.target.files?.length) addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>

        {queuedFiles.length > 0 ? (
          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {queuedFiles.map((item) => (
              <div
                key={item.id}
                className="relative overflow-hidden rounded-[10px] border border-[#e8e3db] bg-white shadow-[0_1px_3px_rgba(27,22,16,0.06)] transition hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(27,22,16,0.08)] dark:border-[#1e2a40] dark:bg-[#151d2e]"
              >
                <button
                  type="button"
                  onClick={() => removeFile(item.id)}
                  className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white"
                  aria-label={`Remove ${item.file.name}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt={item.file.name}
                    className="h-[120px] w-full object-cover"
                  />
                ) : (
                  <div className="flex h-[120px] w-full flex-col items-center justify-center bg-[#e8e3db] text-[#c0392b] dark:bg-[#080d15] dark:text-[#e74c3c]">
                    <FileText className="mb-1 h-9 w-9" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.2em]">
                      {isPdfFile(item.file) ? "PDF" : "IMAGE"}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[#5c5347] dark:text-[#a8a098]">
                      {item.file.name}
                    </div>
                  </div>
                  <div className="shrink-0 text-[0.7rem] text-[#8a7f72] dark:text-[#6e6960]">
                    {formatSize(item.file.size)}
                  </div>
                </div>
                {isPdfFile(item.file) ? (
                  <div className="border-t border-[#e8e3db] px-3 py-2 dark:border-[#1e2a40]">
                    {item.pageError ? (
                      <p className="text-[0.7rem] text-[#c0392b] dark:text-[#f2b8b2]">
                        Could not be opened as a PDF.
                      </p>
                    ) : item.pageCount === undefined ? (
                      <p className="flex items-center gap-1.5 text-[0.7rem] text-[#8a7f72] dark:text-[#a8a098]">
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        Counting pages...
                      </p>
                    ) : (
                      <label className="block text-[0.7rem] text-[#8a7f72] dark:text-[#a8a098]">
                        {item.pageCount} page{item.pageCount === 1 ? "" : "s"} · pages to send
                        <input
                          type="text"
                          inputMode="numeric"
                          value={item.pageSpec ?? ""}
                          onChange={(event) => setPageSpec(item.id, event.target.value)}
                          placeholder={item.pageCount === 1 ? "1" : `all, or e.g. 1-${Math.min(item.pageCount, 4)}`}
                          aria-label={`Pages of ${item.file.name} to send`}
                          className="mt-1 w-full rounded-[8px] border border-[#d4cdc3] bg-white px-2 py-1 text-xs text-[#1b1610] outline-none transition focus:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db] dark:focus:border-[#e8903a]"
                        />
                      </label>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {hasPdf && !countingPages ? (
          <p
            className={`mt-2 text-xs ${
              totalPages > MAX_IMAGES
                ? "font-semibold text-[#c0392b] dark:text-[#f2b8b2]"
                : "text-[#8a7f72] dark:text-[#a8a098]"
            }`}
          >
            Pages to send: {totalPages} of at most {MAX_IMAGES}.
          </p>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <PenSquare className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Additional Instructions
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(optional)</span>
        </p>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder='e.g. "Focus on shear force diagrams" or "Show all unit conversions"'
          className="min-h-24 w-full resize-y rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 text-base text-[#1b1610] shadow-none outline-none transition focus:border-[#b35c1e] focus:ring-4 focus:ring-[rgba(179,92,30,0.15)] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#e4e0db] dark:focus:border-[#e8903a]"
        />
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <BookOpen className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Lecture Notes
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(optional)</span>
        </p>
        <p className="mb-3 text-sm text-[#8a7f72] dark:text-[#a8a098]">
          Attach notes or worked examples and the solutions will follow the methods, notation,
          and sign conventions taught there. Reference only — nothing in them is solved.
        </p>
        <label className="relative block cursor-pointer rounded-[10px] border-2 border-dashed border-[#d4cdc3] bg-white px-4 py-5 text-center text-sm text-[#8a7f72] transition hover:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098] dark:hover:border-[#e8903a]">
          Add lecture notes — <span className="font-semibold text-[#b35c1e] dark:text-[#e8903a]">browse</span>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,image/jpeg,image/png,image/webp,image/gif,application/pdf"
            multiple
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            aria-label="Choose lecture-notes files"
            onChange={(event) => {
              if (event.target.files?.length) addLectureFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </label>

        {lectureFiles.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {lectureFiles.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-[10px] border border-[#e8e3db] bg-white px-3 py-2 text-sm dark:border-[#1e2a40] dark:bg-[#151d2e]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-[#b35c1e] dark:text-[#e8903a]" />
                  <span className="truncate text-[#5c5347] dark:text-[#a8a098]">{item.file.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-[0.7rem] text-[#8a7f72] dark:text-[#6e6960]">
                    {formatSize(item.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLectureFile(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="text-[#8a7f72] transition hover:text-[#c0392b] dark:text-[#6e6960]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Calculator className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          AI Providers
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">
            {crossCheckEnabled
              ? `(solvers - pick two to ${MAX_JUDGED_SOLUTIONS})`
              : "(pick one or more - they solve together)"}
          </span>
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SOLVER_OPTIONS.map((provider) => {
            const status = providerStatus?.[provider.key];
            const available = isAvailable(provider.key);
            const checked = selectedProviders.includes(provider.key) && available;
            const Icon = PROVIDER_ICONS[provider.key];
            const higherCredit = HIGHER_CREDIT_PROVIDERS.has(provider.key);
            const lowerCredit = LOWER_CREDIT_PROVIDERS.has(provider.key);
            const china = CHINA_PROVIDERS.has(provider.key);
            const unstable = UNSTABLE_PROVIDERS.has(provider.key);
            // Brand, account, model - nothing else. Effort floors are shown
            // under Thinking Effort, and a model chain announces itself in the
            // status line when it actually switches.
            const note = status
              ? status.configured
                ? `${CHANNEL_LABELS[status.channel]} · ${status.model}`
                : `${CHANNEL_LABELS[status.channel]} key not configured`
              : "checking...";
            return (
              <label
                key={provider.key}
                className={`flex min-h-[84px] items-start gap-3 rounded-[10px] border-2 bg-white p-4 transition dark:bg-[#151d2e] ${
                  available ? "cursor-pointer" : "cursor-not-allowed opacity-55"
                } ${
                  checked
                    ? "border-[#b35c1e] shadow-[0_0_0_4px_rgba(179,92,30,0.12)] dark:border-[#e8903a]"
                    : "border-[#d4cdc3] hover:border-[#b35c1e] dark:border-[#2a3650] dark:hover:border-[#e8903a]"
                }`}
              >
                <input
                  type="checkbox"
                  name="providers"
                  value={provider.key}
                  checked={checked}
                  disabled={!available}
                  onChange={() => toggleProvider(provider.key)}
                  className="mt-1 h-4 w-4 accent-[#b35c1e] disabled:cursor-not-allowed dark:accent-[#e8903a]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-semibold text-[#1b1610] dark:text-[#e4e0db]">
                    <Icon
                      className="h-4 w-4 shrink-0 text-[#b35c1e] dark:text-[#e8903a]"
                      aria-hidden="true"
                    />
                    {provider.label}
                    {higherCredit ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#ecd3b8] bg-[#fdf3e7] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#b35c1e] dark:border-[#4a2f18] dark:bg-[#2b1d10] dark:text-[#e8903a]"
                        title={`${provider.label} draws more credit per solve than the other providers.`}
                      >
                        <Flame className="h-3 w-3" aria-hidden="true" />
                        More credit
                      </span>
                    ) : null}
                    {lowerCredit ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#c9dcc4] bg-[#eef6ea] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#3f7a3a] dark:border-[#2f4a2c] dark:bg-[#14241a] dark:text-[#8fcf86]"
                        title={`${provider.label} draws less credit per solve than the other providers.`}
                      >
                        <Feather className="h-3 w-3" aria-hidden="true" />
                        Less credit
                      </span>
                    ) : null}
                    {unstable ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#ecdcae] bg-[#fdf8e7] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#8a6a12] dark:border-[#4a3f1a] dark:bg-[#2a2310] dark:text-[#e0c46a]"
                        title={`${provider.label} costs nothing but often fails to answer - its tab is shown last.`}
                      >
                        <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                        Free but unstable
                      </span>
                    ) : null}
                    {china ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#d9c2c2] bg-[#f7eeee] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#8a4040] dark:border-[#4a2a2a] dark:bg-[#241616] dark:text-[#d99a9a]"
                        title={`${provider.label} is developed and served in mainland China.`}
                      >
                        <Flag className="h-3 w-3" aria-hidden="true" />
                        China model
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block break-words text-xs text-[#8a7f72] dark:text-[#a8a098]">
                    {note}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {noneConfigured ? (
          <p className="mt-3 text-sm text-[#c0392b] dark:text-[#f2b8b2]">
            No provider keys are configured on the server. Add at least one key
            (OPENCODE_API_KEY, POE_API_KEY, or GOOGLE_API_KEY) and restart.
          </p>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Brain className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Thinking Effort
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(guides solution depth)</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {EFFORT_OPTIONS.map((option) => {
            const locked = isEffortLocked(option.key);
            return (
              <button
                key={option.key}
                type="button"
                disabled={locked}
                title={
                  !locked
                    ? undefined
                    : EFFORT_KEYS.indexOf(option.key) > ceilingIndex
                      ? `${ceilingLabels} cannot finish above ${effortCeiling} thinking on this route.`
                      : `${floorLabels} runs at ${effortFloor} thinking or above on this route.`
                }
                onClick={() => setEffort(option.key)}
                className={`rounded-full border-2 px-4 py-2 text-sm font-semibold transition ${
                  effort === option.key
                    ? "border-[#b35c1e] bg-[#b35c1e] text-white shadow-[0_2px_10px_rgba(179,92,30,0.15)] dark:border-[#e8903a] dark:bg-[#e8903a] dark:text-[#0e1420]"
                    : locked
                      ? "cursor-not-allowed border-[#d4cdc3] bg-white text-[#5c5347] opacity-45 dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098]"
                      : "border-[#d4cdc3] bg-white text-[#5c5347] hover:border-[#b35c1e] hover:text-[#b35c1e] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098] dark:hover:border-[#e8903a] dark:hover:text-[#e8903a]"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {effortFloor && !bandIsEmpty ? (
          <p className="mt-3 text-xs text-[#b35c1e] dark:text-[#e8903a]">
            {floorLabels} runs at <strong>{effortFloor} or above</strong> on this route, so
            lower levels are disabled for every solver in this run.
          </p>
        ) : null}
        {effortCeiling && !bandIsEmpty ? (
          <p className="mt-3 text-xs text-[#b35c1e] dark:text-[#e8903a]">
            {ceilingLabels} cannot finish above <strong>{effortCeiling}</strong> on this route
            — it thinks past the time limit — so higher levels are disabled.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-[#8a7f72] dark:text-[#a8a098]">
          Each model has its own reasoning scale, so the level is mapped per provider.
          Levels a model does not offer fall back to its own default (Gemini Pro, for
          example, cannot switch thinking off).
        </p>
      </section>


      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Eye className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Question Interpretation
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(optional)</span>
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border-2 border-[#d4cdc3] bg-white p-4 transition hover:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#151d2e] dark:hover:border-[#e8903a]">
          <input
            type="checkbox"
            checked={verifyEnabled}
            onChange={(event) => setVerifyEnabled(event.target.checked)}
            className="mt-1 h-4 w-4 accent-[#b35c1e] dark:accent-[#e8903a]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[#1b1610] dark:text-[#e4e0db]">
              Check the diagram reading before solving
            </span>
            <span className="mt-1 block text-xs text-[#8a7f72] dark:text-[#a8a098]">
              Two models read the question independently, a third reconciles them, and you get to
              correct the result before any solving starts. Catches misread diagrams — at the cost
              of three extra model calls and a wait before the solutions begin.
            </span>
          </span>
        </label>

        {verifyEnabled ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { label: "First reader", value: interpreterA, set: setInterpreterA },
              { label: "Second reader", value: interpreterB, set: setInterpreterB },
              { label: "Reconciler", value: verifier, set: setVerifier },
            ].map((field) => (
              <label key={field.label} className="block text-xs text-[#8a7f72] dark:text-[#a8a098]">
                {field.label}
                <select
                  value={field.value}
                  onChange={(event) => field.set(event.target.value as ProviderKey)}
                  className="mt-1 w-full rounded-[10px] border border-[#d4cdc3] bg-white px-3 py-2 text-sm text-[#1b1610] outline-none transition focus:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db]"
                >
                  {PROVIDER_OPTIONS.filter((option) => isAvailable(option.key)).map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="block text-xs text-[#8a7f72] dark:text-[#a8a098]">
              Readers&apos; thinking
              <select
                value={readerEffort}
                onChange={(event) => setReaderEffort(event.target.value as EffortKey)}
                className="mt-1 w-full rounded-[10px] border border-[#d4cdc3] bg-white px-3 py-2 text-sm text-[#1b1610] outline-none transition focus:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db]"
              >
                {EFFORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[0.7rem] text-[#8a7f72] dark:text-[#6e6960]">
                The reconciler always thinks at its maximum.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Scale className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Answer Cross-check
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(optional)</span>
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border-2 border-[#d4cdc3] bg-white p-4 transition hover:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#151d2e] dark:hover:border-[#e8903a]">
          <input
            type="checkbox"
            checked={crossCheckEnabled}
            onChange={(event) => setCrossCheckEnabled(event.target.checked)}
            className="mt-1 h-4 w-4 accent-[#b35c1e] dark:accent-[#e8903a]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[#1b1610] dark:text-[#e4e0db]">
              Have a judge grade every solution
            </span>
            <span className="mt-1 block text-xs text-[#8a7f72] dark:text-[#a8a098]">
              The selected solvers work at the same time, then the judge re-derives the
              numbers from the images and says which solutions are right — or corrects them
              all. Catches a plausible-looking wrong answer, at the cost of one extra model
              call. Needs two or more solvers ticked above. Combine with the interpretation
              check for the most robust result.
            </span>
          </span>
        </label>

        {crossCheckEnabled ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-[#8a7f72] dark:text-[#a8a098]">
              Judge
              <select
                value={judge}
                onChange={(event) => setJudge(event.target.value as ProviderKey)}
                className="mt-1 w-full rounded-[10px] border border-[#d4cdc3] bg-white px-3 py-2 text-sm text-[#1b1610] outline-none transition focus:border-[#b35c1e] dark:border-[#2a3650] dark:bg-[#0e1420] dark:text-[#e4e0db]"
              >
                {PROVIDER_OPTIONS.filter((option) => isAvailable(option.key)).map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[0.7rem] text-[#8a7f72] dark:text-[#6e6960] sm:col-span-2">
              Solving: {selectedProviders.map((key) => PROVIDER_LABELS[key]).join(", ") || "nobody yet"}.
              The judge thinks at <strong>high</strong> and never learns which model wrote
              which solution.
            </p>
          </div>
        ) : null}
      </section>

      {bannerError ? (
        <div className="rounded-[10px] border border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] px-4 py-3 text-sm text-[#c0392b] dark:border-[#5b2a31] dark:text-[#f2b8b2]">
          {bannerError}
        </div>
      ) : null}

      {status ? (
        <div className="rounded-[10px] border border-[#d4cdc3] bg-white px-4 py-3 text-sm text-[#5c5347] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#cfc7bf]">
          {status}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] bg-[#b35c1e] px-8 py-3 text-base font-semibold text-white shadow-[0_3px_14px_rgba(179,92,30,0.15)] transition hover:-translate-y-0.5 hover:bg-[#9a4d17] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#e8903a] dark:text-[#0e1420] dark:hover:bg-[#f5a04f] sm:px-12"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
          {busy ? "Generating solutions..." : "Solve Problems"}
        </button>
        {solving ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] border-2 border-[#d4cdc3] bg-white px-6 py-3 text-base font-semibold text-[#5c5347] transition hover:border-[#c0392b] hover:text-[#c0392b] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098] dark:hover:border-[#f2b8b2] dark:hover:text-[#f2b8b2]"
          >
            <X className="h-4 w-4" />
            Stop
          </button>
        ) : null}
      </div>
    </form>
  );
}
