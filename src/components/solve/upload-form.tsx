import { useEffect, useState } from "react";
import {
  Brain,
  Calculator,
  FileImage,
  FileText,
  Loader2,
  PenSquare,
  Upload,
  X,
} from "lucide-react";
import type { EffortKey } from "../../../shared/prompt";
import type { ProviderKey } from "../../../shared/solution";
import { isAcceptedUpload, isPdfFile } from "@/lib/attachments";

type QueuedFile = {
  id: string;
  file: File;
  previewUrl?: string;
};

export type SolveSubmission = {
  files: File[];
  providers: ProviderKey[];
  notes: string;
  effort: EffortKey;
};

const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const PROVIDER_OPTIONS: Array<{ key: ProviderKey; label: string; note: string }> = [
  { key: "codex", label: "ChatGPT", note: "via Poe" },
  { key: "claude", label: "Claude Sonnet", note: "via Poe" },
  { key: "gemini", label: "Gemini Pro", note: "via Poe" },
];

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
  busy,
  status,
  error,
  onSolve,
}: {
  busy: boolean;
  status: string;
  error: string;
  onSolve: (submission: SolveSubmission) => void;
}) {
  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
  const [notes, setNotes] = useState("");
  const [effort, setEffort] = useState<EffortKey>("low");
  const [selectedProviders, setSelectedProviders] = useState<ProviderKey[]>([
    "codex",
    "claude",
    "gemini",
  ]);
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return () => {
      queuedFiles.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [queuedFiles]);

  const canSubmit = queuedFiles.length > 0 && selectedProviders.length > 0 && !busy;

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

  function removeFile(id: string) {
    setQueuedFiles((current) => {
      const match = current.find((item) => item.id === id);
      if (match?.previewUrl) URL.revokeObjectURL(match.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  }

  function toggleProvider(provider: ProviderKey) {
    setSelectedProviders((current) => {
      if (current.includes(provider)) {
        return current.filter((item) => item !== provider);
      }
      return PROVIDER_OPTIONS.map((option) => option.key).filter(
        (key) => current.includes(key) || key === provider,
      );
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    onSolve({
      files: queuedFiles.map((item) => item.file),
      providers: selectedProviders,
      notes,
      effort,
    });
  }

  const bannerError = error || fileError;

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
              </div>
            ))}
          </div>
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
          <Calculator className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          AI Providers
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {PROVIDER_OPTIONS.map((provider) => {
            const checked = selectedProviders.includes(provider.key);
            return (
              <label
                key={provider.key}
                className={`flex min-h-[84px] cursor-pointer items-start gap-3 rounded-[10px] border-2 bg-white p-4 transition dark:bg-[#151d2e] ${
                  checked
                    ? "border-[#b35c1e] shadow-[0_0_0_4px_rgba(179,92,30,0.12)] dark:border-[#e8903a]"
                    : "border-[#d4cdc3] hover:border-[#b35c1e] dark:border-[#2a3650] dark:hover:border-[#e8903a]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleProvider(provider.key)}
                  className="mt-1 h-4 w-4 accent-[#b35c1e] dark:accent-[#e8903a]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#1b1610] dark:text-[#e4e0db]">
                    {provider.label}
                  </span>
                  <span className="mt-1 block text-xs text-[#8a7f72] dark:text-[#a8a098]">
                    {provider.note}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-serif text-lg font-semibold text-[#1b1610] dark:text-[#e4e0db]">
          <Brain className="h-4 w-4 text-[#b35c1e] dark:text-[#e8903a]" />
          Thinking Effort
          <span className="font-sans text-sm font-normal text-[#8a7f72] dark:text-[#a8a098]">(guides solution depth)</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {EFFORT_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setEffort(option.key)}
              className={`rounded-full border-2 px-4 py-2 text-sm font-semibold transition ${
                effort === option.key
                  ? "border-[#b35c1e] bg-[#b35c1e] text-white shadow-[0_2px_10px_rgba(179,92,30,0.15)] dark:border-[#e8903a] dark:bg-[#e8903a] dark:text-[#0e1420]"
                  : "border-[#d4cdc3] bg-white text-[#5c5347] hover:border-[#b35c1e] hover:text-[#b35c1e] dark:border-[#2a3650] dark:bg-[#151d2e] dark:text-[#a8a098] dark:hover:border-[#e8903a] dark:hover:text-[#e8903a]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
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

      <div className="flex justify-center pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[10px] bg-[#b35c1e] px-8 py-3 text-base font-semibold text-white shadow-[0_3px_14px_rgba(179,92,30,0.15)] transition hover:-translate-y-0.5 hover:bg-[#9a4d17] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#e8903a] dark:text-[#0e1420] dark:hover:bg-[#f5a04f] sm:px-12"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
          {busy ? "Generating solutions..." : "Solve Problems"}
        </button>
      </div>
    </form>
  );
}
