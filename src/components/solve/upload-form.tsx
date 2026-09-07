import { useEffect, useState } from "react";
import {
  BookOpen,
  Brain,
  Calculator,
  Eye,
  FileImage,
  FileText,
  Loader2,
  PenSquare,
  Upload,
  X,
} from "lucide-react";
import type { InterpretConfig } from "@/hooks/use-interpret";
import type { EffortKey } from "../../../shared/prompt";
import {
  CHANNEL_LABELS,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  type HealthResponse,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import { isAcceptedUpload, isPdfFile } from "@/lib/attachments";

type QueuedFile = {
  id: string;
  file: File;
  previewUrl?: string;
};

export type SolveSubmission = {
  files: File[];
  /** Reference material for method/notation, never solved. */
  lectureFiles: File[];
  providers: ProviderKey[];
  notes: string;
  effort: EffortKey;
  /** Null when the user leaves the interpretation pass switched off. */
  verify: InterpretConfig | null;
};

const MAX_FILES = 10;
const MAX_LECTURE_FILES = 6;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const PROVIDER_OPTIONS: Array<{ key: ProviderKey; label: string }> =
  PROVIDER_KEYS.map((key) => ({ key, label: PROVIDER_LABELS[key] }));

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
  solving,
  status,
  error,
  onSolve,
  onCancel,
}: {
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
  const [interpreterA, setInterpreterA] = useState<ProviderKey>("chatgpt");
  const [interpreterB, setInterpreterB] = useState<ProviderKey>("gemini");
  const [verifier, setVerifier] = useState<ProviderKey>("claude");
  const [effort, setEffort] = useState<EffortKey>("low");
  const [selectedProviders, setSelectedProviders] = useState<ProviderKey[]>([
    ...PROVIDER_KEYS,
  ]);
  const [providerStatus, setProviderStatus] =
    useState<Record<ProviderKey, ProviderStatus> | null>(null);
  const [fileError, setFileError] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    return () => {
      queuedFiles.forEach((item) => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      });
    };
  }, [queuedFiles]);

  // Which providers actually have a key on the server. Advisory only: if the
  // probe fails the form still works and the Worker reports the real error.
  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((response) => (response.ok ? (response.json() as Promise<HealthResponse>) : null))
      .then((payload) => {
        if (cancelled || !payload?.providers) return;
        setProviderStatus(payload.providers);
        setSelectedProviders((current) => {
          const usable = current.filter((key) => payload.providers[key]?.configured);
          return usable.length ? usable : current;
        });
      })
      .catch(() => {
        // Ignored on purpose - health is a hint, not a gate.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const isAvailable = (provider: ProviderKey) =>
    providerStatus ? providerStatus[provider]?.configured !== false : true;

  const noneConfigured = Boolean(
    providerStatus && PROVIDER_KEYS.every((key) => !providerStatus[key]?.configured),
  );

  // Two readers that are the same model would just agree with themselves.
  const verifyConfigError =
    verifyEnabled && interpreterA === interpreterB
      ? "Pick two different models to read the question independently."
      : "";

  const canSubmit =
    queuedFiles.length > 0 && selectedProviders.length > 0 && !verifyConfigError && !busy;

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
      lectureFiles: lectureFiles.map((item) => item.file),
      providers: selectedProviders,
      notes,
      effort,
      verify: verifyEnabled ? { interpreterA, interpreterB, verifier } : null,
    });
  }

  const bannerError = error || fileError || verifyConfigError;

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
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PROVIDER_OPTIONS.map((provider) => {
            const status = providerStatus?.[provider.key];
            const available = isAvailable(provider.key);
            const checked = selectedProviders.includes(provider.key) && available;
            const note = status
              ? status.configured
                ? `via ${CHANNEL_LABELS[status.channel]} - ${status.model}`
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
                  checked={checked}
                  disabled={!available}
                  onChange={() => toggleProvider(provider.key)}
                  className="mt-1 h-4 w-4 accent-[#b35c1e] disabled:cursor-not-allowed dark:accent-[#e8903a]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-[#1b1610] dark:text-[#e4e0db]">
                    {provider.label}
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
            (POE_API_KEY, MOONSHOT_API_KEY, MINIMAX_API_KEY, or GOOGLE_API_KEY) and restart.
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
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
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
