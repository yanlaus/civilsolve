import { useEffect, useState } from "react";
import {
  BookOpen,
  Brain,
  Calculator,
  Eye,
  Feather,
  FileImage,
  Flag,
  FileText,
  Flame,
  Loader2,
  PenSquare,
  Scale,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import type { InterpretConfig } from "@/hooks/use-interpret";
import { ProviderLogo } from "./provider-logo";
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
  const [interpreterA, setInterpreterA] = useState<ProviderKey>(DEFAULT_INTERPRETERS[0]);
  const [interpreterB, setInterpreterB] = useState<ProviderKey>(DEFAULT_INTERPRETERS[1]);
  const [verifier, setVerifier] = useState<ProviderKey>(DEFAULT_VERIFIER);
  const [readerEffort, setReaderEffort] = useState<EffortKey>("medium");
  const [crossCheckEnabled, setCrossCheckEnabled] = useState(false);
  const [judge, setJudge] = useState<ProviderKey>(DEFAULT_JUDGE);
  const [effort, setEffort] = useState<EffortKey>("high");
  const [selectedProviders, setSelectedProviders] = useState<ProviderKey[]>(DEFAULT_SOLVERS);
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
          const configured = current.filter((key) => payload.providers[key]?.configured);
          if (configured.length) return configured;
          const firstConfigured = SOLVER_KEYS.find((key) => payload.providers[key]?.configured);
          return firstConfigured ? [firstConfigured] : current;
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

  const canSubmit =
    queuedFiles.length > 0 &&
    selectedProviders.every(isAvailable) &&
    !verifyConfigError &&
    !solverConfigError &&
    !busy;

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
      files: queuedFiles.map((item) => item.file),
      lectureFiles: lectureFiles.map((item) => item.file),
      providers: selectedProviders,
      notes,
      effort,
      verify: verifyEnabled ? { interpreterA, interpreterB, verifier, readerEffort } : null,
      judge: crossCheckEnabled ? judge : null,
    });
  }

  const bannerError = error || fileError || verifyConfigError || solverConfigError;

  return (
    <form className="space-y-5 print:hidden" onSubmit={handleSubmit}>
      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Upload className="h-4 w-4 text-cs-accent" />
          Upload Assignment Materials
        </p>

        <label
          className={`cs-panel relative block cursor-pointer overflow-hidden rounded-cs-lg border-2 border-dashed bg-cs-surface px-6 py-12 text-center shadow-[0_1px_3px_var(--cs-shadow)] transition ${
            isDragging
              ? "border-cs-accent shadow-[0_0_0_4px_var(--cs-ring)]"
              : "border-cs-line hover:border-cs-accent hover:shadow-[0_0_0_4px_var(--cs-ring)]"
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
            <div className="mb-3 text-cs-accent">
              <FileImage className="mx-auto h-10 w-10" />
            </div>
            <p className="text-lg font-semibold text-cs-ink">
              Drag and drop your files here
            </p>
            <p className="mt-1 text-sm text-cs-ink-3">
              or <span className="font-semibold text-cs-accent">browse</span> — JPEG, PNG, WebP, GIF, and PDF accepted
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
                className="relative overflow-hidden rounded-cs border border-cs-line-soft bg-cs-surface shadow-[0_1px_3px_var(--cs-shadow)] transition hover:-translate-y-0.5 hover:shadow-[0_4px_16px_var(--cs-shadow)]"
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
                  <div className="flex h-[120px] w-full flex-col items-center justify-center bg-cs-sunken text-cs-danger">
                    <FileText className="mb-1 h-9 w-9" />
                    <span className="text-[0.7rem] font-semibold uppercase tracking-[0.2em]">
                      {isPdfFile(item.file) ? "PDF" : "IMAGE"}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-cs-ink-2">
                      {item.file.name}
                    </div>
                  </div>
                  <div className="shrink-0 text-[0.7rem] text-cs-ink-3">
                    {formatSize(item.file.size)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <PenSquare className="h-4 w-4 text-cs-accent" />
          Additional Instructions
          <span className="font-sans text-sm font-normal text-cs-ink-3">(optional)</span>
        </p>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          rows={4}
          placeholder='e.g. "Focus on shear force diagrams" or "Show all unit conversions"'
          className="min-h-24 w-full resize-y rounded-cs border border-cs-line bg-cs-surface px-4 py-3 text-base text-cs-ink shadow-none outline-none transition focus:border-cs-accent focus:ring-4 focus:ring-cs-ring"
        />
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <BookOpen className="h-4 w-4 text-cs-accent" />
          Lecture Notes
          <span className="font-sans text-sm font-normal text-cs-ink-3">(optional)</span>
        </p>
        <p className="mb-3 text-sm text-cs-ink-3">
          Attach notes or worked examples and the solutions will follow the methods, notation,
          and sign conventions taught there. Reference only — nothing in them is solved.
        </p>
        <label className="relative block cursor-pointer rounded-cs border-2 border-dashed border-cs-line bg-cs-surface px-4 py-5 text-center text-sm text-cs-ink-3 transition hover:border-cs-accent">
          Add lecture notes — <span className="font-semibold text-cs-accent">browse</span>
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
                className="flex items-center justify-between gap-3 rounded-cs border border-cs-line-soft bg-cs-surface px-3 py-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-cs-accent" />
                  <span className="truncate text-cs-ink-2">{item.file.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="text-[0.7rem] text-cs-ink-3">
                    {formatSize(item.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeLectureFile(item.id)}
                    aria-label={`Remove ${item.file.name}`}
                    className="text-cs-ink-3 transition hover:text-cs-danger"
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
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Calculator className="h-4 w-4 text-cs-accent" />
          AI Providers
          <span className="font-sans text-sm font-normal text-cs-ink-3">
            {crossCheckEnabled
              ? `(solvers - pick two to ${MAX_JUDGED_SOLUTIONS})`
              : "(pick one or more - they solve together)"}
          </span>
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {SOLVER_OPTIONS.map((provider) => {
            const status = providerStatus?.[provider.key];
            const available = isAvailable(provider.key);
            const checked = selectedProviders.includes(provider.key) && available;
            const higherCredit = HIGHER_CREDIT_PROVIDERS.has(provider.key);
            const lowerCredit = LOWER_CREDIT_PROVIDERS.has(provider.key);
            const china = CHINA_PROVIDERS.has(provider.key);
            const unstable = UNSTABLE_PROVIDERS.has(provider.key);
            const hasBadge = higherCredit || lowerCredit || china || unstable;
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
                className={`flex min-w-0 flex-col gap-2 rounded-cs border-2 bg-cs-surface p-3.5 transition ${
                  available ? "cursor-pointer" : "cursor-not-allowed opacity-55"
                } ${
                  checked
                    ? "border-cs-accent shadow-[0_0_0_4px_var(--cs-ring)]"
                    : "border-cs-line hover:border-cs-accent"
                }`}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-cs border border-cs-line-soft bg-white">
                    <ProviderLogo provider={provider.key} className="h-6 w-6" />
                  </span>
                  <input
                    type="checkbox"
                    name="providers"
                    value={provider.key}
                    checked={checked}
                    disabled={!available}
                    onChange={() => toggleProvider(provider.key)}
                    className="mt-0.5 h-4 w-4 accent-cs-accent disabled:cursor-not-allowed"
                  />
                </span>
                <span className="text-sm font-semibold text-cs-ink">{provider.label}</span>
                {hasBadge ? (
                  <span className="flex flex-wrap gap-1">
                    {higherCredit ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#ecd3b8] bg-[#fdf3e7] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#b35c1e]"
                        title={`${provider.label} draws more credit per solve than the other providers.`}
                      >
                        <Flame className="h-3 w-3" aria-hidden="true" />
                        More credit
                      </span>
                    ) : null}
                    {lowerCredit ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#c9dcc4] bg-[#eef6ea] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#3f7a3a]"
                        title={`${provider.label} draws less credit per solve than the other providers.`}
                      >
                        <Feather className="h-3 w-3" aria-hidden="true" />
                        Less credit
                      </span>
                    ) : null}
                    {unstable ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#ecdcae] bg-[#fdf8e7] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#8a6a12]"
                        title={`${provider.label} costs nothing but often fails to answer - its tab is shown last.`}
                      >
                        <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                        Free but unstable
                      </span>
                    ) : null}
                    {china ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-[#d9c2c2] bg-[#f7eeee] px-2 py-0.5 text-[0.65rem] font-medium leading-none text-[#8a4040]"
                        title={`${provider.label} is developed and served in mainland China.`}
                      >
                        <Flag className="h-3 w-3" aria-hidden="true" />
                        China model
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <span className="mt-auto block break-words text-xs text-cs-ink-3">{note}</span>
              </label>
            );
          })}
        </div>
        {noneConfigured ? (
          <p className="mt-3 text-sm text-cs-danger">
            No provider keys are configured on the server. Add at least one key
            (OPENCODE_API_KEY, POE_API_KEY, or GOOGLE_API_KEY) and restart.
          </p>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Brain className="h-4 w-4 text-cs-accent" />
          Thinking Effort
          <span className="font-sans text-sm font-normal text-cs-ink-3">(guides solution depth)</span>
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
                    ? "border-cs-accent bg-cs-accent text-cs-on-accent shadow-[0_2px_10px_var(--cs-ring)]"
                    : locked
                      ? "cursor-not-allowed border-cs-line bg-cs-surface text-cs-ink-2 opacity-45"
                      : "border-cs-line bg-cs-surface text-cs-ink-2 hover:border-cs-accent hover:text-cs-accent"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {effortFloor && !bandIsEmpty ? (
          <p className="mt-3 text-xs text-cs-accent">
            {floorLabels} runs at <strong>{effortFloor} or above</strong> on this route, so
            lower levels are disabled for every solver in this run.
          </p>
        ) : null}
        {effortCeiling && !bandIsEmpty ? (
          <p className="mt-3 text-xs text-cs-accent">
            {ceilingLabels} cannot finish above <strong>{effortCeiling}</strong> on this route
            — it thinks past the time limit — so higher levels are disabled.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-cs-ink-3">
          Each model has its own reasoning scale, so the level is mapped per provider.
          Levels a model does not offer fall back to its own default (Gemini Pro, for
          example, cannot switch thinking off).
        </p>
      </section>


      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Eye className="h-4 w-4 text-cs-accent" />
          Question Interpretation
          <span className="font-sans text-sm font-normal text-cs-ink-3">(optional)</span>
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-cs border-2 border-cs-line bg-cs-surface p-4 transition hover:border-cs-accent">
          <input
            type="checkbox"
            checked={verifyEnabled}
            onChange={(event) => setVerifyEnabled(event.target.checked)}
            className="mt-1 h-4 w-4 accent-cs-accent"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-cs-ink">
              Check the diagram reading before solving
            </span>
            <span className="mt-1 block text-xs text-cs-ink-3">
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
              <label key={field.label} className="block text-xs text-cs-ink-3">
                {field.label}
                <select
                  value={field.value}
                  onChange={(event) => field.set(event.target.value as ProviderKey)}
                  className="mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent"
                >
                  {PROVIDER_OPTIONS.filter((option) => isAvailable(option.key)).map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="block text-xs text-cs-ink-3">
              Readers&apos; thinking
              <select
                value={readerEffort}
                onChange={(event) => setReaderEffort(event.target.value as EffortKey)}
                className="mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent"
              >
                {EFFORT_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[0.7rem] text-cs-ink-3">
                The reconciler always thinks at its maximum.
              </span>
            </label>
          </div>
        ) : null}
      </section>

      <section>
        <p className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-cs-ink">
          <Scale className="h-4 w-4 text-cs-accent" />
          Answer Cross-check
          <span className="font-sans text-sm font-normal text-cs-ink-3">(optional)</span>
        </p>

        <label className="flex cursor-pointer items-start gap-3 rounded-cs border-2 border-cs-line bg-cs-surface p-4 transition hover:border-cs-accent">
          <input
            type="checkbox"
            checked={crossCheckEnabled}
            onChange={(event) => setCrossCheckEnabled(event.target.checked)}
            className="mt-1 h-4 w-4 accent-cs-accent"
          />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-cs-ink">
              Have a judge grade every solution
            </span>
            <span className="mt-1 block text-xs text-cs-ink-3">
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
            <label className="block text-xs text-cs-ink-3">
              Judge
              <select
                value={judge}
                onChange={(event) => setJudge(event.target.value as ProviderKey)}
                className="mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent"
              >
                {PROVIDER_OPTIONS.filter((option) => isAvailable(option.key)).map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[0.7rem] text-cs-ink-3 sm:col-span-2">
              Solving: {selectedProviders.map((key) => PROVIDER_LABELS[key]).join(", ") || "nobody yet"}.
              The judge thinks at <strong>high</strong> and never learns which model wrote
              which solution.
            </p>
          </div>
        ) : null}
      </section>

      {bannerError ? (
        <div className="rounded-cs border border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] px-4 py-3 text-sm text-cs-danger">
          {bannerError}
        </div>
      ) : null}

      {status ? (
        <div className="rounded-cs border border-cs-line bg-cs-surface px-4 py-3 text-sm text-cs-ink-2">
          {status}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="cs-primary inline-flex min-h-12 items-center justify-center gap-2 rounded-cs bg-cs-accent px-8 py-3 text-base font-semibold text-cs-on-accent shadow-[0_3px_14px_var(--cs-ring)] transition hover:-translate-y-0.5 hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:px-12"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
          {busy ? "Generating solutions..." : "Solve Problems"}
        </button>
        {solving ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-cs border-2 border-cs-line bg-cs-surface px-6 py-3 text-base font-semibold text-cs-ink-2 transition hover:border-cs-danger hover:text-cs-danger"
          >
            <X className="h-4 w-4" />
            Stop
          </button>
        ) : null}
      </div>
    </form>
  );
}
