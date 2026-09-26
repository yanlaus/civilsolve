import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Calculator, History, Loader2, X } from "lucide-react";
import { InterpretProgress } from "@/components/solve/interpret-progress";
import { InterpretationReview } from "@/components/solve/interpretation-review";
import { useTheme } from "@/components/theme-provider";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { UploadForm, type SolveSubmission } from "@/components/solve/upload-form";
import { useHealth } from "@/hooks/use-health";
import { useInterpret } from "@/hooks/use-interpret";
import { isJudgeActive, isRunActive, useSolve } from "@/hooks/use-solve";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { filesToImageDataUrls } from "@/lib/attachments";
import { useNow } from "@/lib/progress";
import { lectureNotesToPayload } from "@/lib/lecture-notes";
import { providerDisplayName, type ModelVariant, type ProviderKey } from "../../shared/providers";
import {
  estimateBodyBytes,
  formatBytes,
  MAX_BODY_BYTES,
  MAX_IMAGES,
  type SolveRequestBody,
} from "../../shared/stream-protocol";

const SolutionPanel = lazy(() => import("@/components/solve/solution-panel"));

/** The Unicorn theme's V-fin, over the wordmark. */
function UnicornCrest() {
  return (
    <svg viewBox="0 0 120 34" className="mx-auto mb-2 h-7 w-auto" aria-hidden="true">
      <path d="M57 30 4 3h12l44 20z" fill="#d4a72c" />
      <path d="M63 30 116 3h-12L60 23z" fill="#d4a72c" />
      <path d="M60 12l5 9-5 11-5-11z" fill="#c4262e" />
    </svg>
  );
}

// Prepared at submit time and needed again once the user confirms the
// reviewed interpretation - nothing is solved before that. The cross-check
// is not part of it: it runs from the solutions once they are in.
type PendingSolve = {
  providers: ProviderKey[];
  body: SolveRequestBody;
  variants: Partial<Record<ProviderKey, ModelVariant>>;
};

export default function CivilAnswerAppPage() {
  const { theme } = useTheme();
  const {
    runs,
    judgeRun,
    progress,
    judgeProgress,
    variants: runVariants,
    canRerun,
    start,
    cancel,
    restore,
    dismiss,
    solveProvider,
    crossCheck,
  } = useSolve();
  const { providerStatus } = useHealth();
  // Set when the page came back with the last run's results - the jobs kept
  // running on the server while the page was closed or reloaded.
  const [recovered, setRecovered] = useState(false);
  const restoreAttempted = useRef(false);

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    if (restore()) setRecovered(true);
  }, [restore]);
  const { pipeline, start: startInterpret, reset: resetInterpret } = useInterpret();
  const [pendingSolve, setPendingSolve] = useState<PendingSolve | null>(null);
  const [prepStatus, setPrepStatus] = useState("");
  const [error, setError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const detail = event.error instanceof Error ? event.error.message : event.message;
      setRuntimeError(detail || "Unexpected browser error.");
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const detail =
        event.reason instanceof Error
          ? event.reason.message
          : typeof event.reason === "string"
            ? event.reason
            : "Unexpected browser error.";
      setRuntimeError(detail);
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  const isSolving = Object.values(runs).some(isRunActive) || isJudgeActive(judgeRun);
  const isInterpreting = pipeline.status === "running";
  const busy = isSolving || isInterpreting || Boolean(prepStatus);

  // A long solve on a phone: keep the screen from locking while it runs.
  useWakeLock(isSolving || isInterpreting);

  // The interpretation step in progress: the step, a running clock, and a
  // line per model, so a slow reader is visibly still working.
  const now = useNow(isInterpreting);
  const statusMessage =
    prepStatus ||
    (pipeline.status === "running" ? (
      <InterpretProgress
        stage={pipeline.stage}
        step={pipeline.step}
        steps={pipeline.steps}
        models={pipeline.models}
        elapsedMs={now - pipeline.startedAt}
      />
    ) : (
      ""
    ));
  const bannerError = error || (pipeline.status === "error" ? pipeline.message : "");

  function clearRecovered() {
    dismiss();
    setRecovered(false);
  }

  function cancelAll() {
    setRecovered(false);
    resetInterpret();
    setPendingSolve(null);
    cancel();
  }

  async function handleSolve({
    uploads,
    lectureFiles,
    providers,
    notes,
    effort,
    verify,
    variants,
  }: SolveSubmission) {
    setError("");
    setRecovered(false);
    resetInterpret();
    setPendingSolve(null);
    // A new question clears the last one's solutions and verdict first.
    // Left on screen while the new question was being read, they looked
    // like what the interpretation pass was working on (26 September 2026).
    dismiss();
    setPrepStatus("Preparing images...");

    try {
      const images = await filesToImageDataUrls(uploads);
      if (images.length > MAX_IMAGES) {
        throw new Error(
          `The upload produced ${images.length} images (PDF pages count individually). The limit is ${MAX_IMAGES} — remove some files or pages.`,
        );
      }

      let referenceText = "";
      let referenceImages: string[] = [];
      if (lectureFiles.length > 0) {
        setPrepStatus("Preparing lecture notes...");
        const payload = await lectureNotesToPayload(lectureFiles);
        referenceText = payload.referenceText;
        referenceImages = payload.referenceImages;
      }

      const body: SolveRequestBody = {
        images,
        notes,
        effort,
        ...(referenceText ? { referenceText } : {}),
        ...(referenceImages.length ? { referenceImages } : {}),
      };

      // One copy of this payload is uploaded per selected provider, so an
      // oversized batch is caught here rather than as N rejected requests.
      const bytes = estimateBodyBytes(body);
      if (bytes > MAX_BODY_BYTES) {
        throw new Error(
          `The prepared upload is about ${formatBytes(bytes)}, over the ${formatBytes(MAX_BODY_BYTES)} limit for one request. Remove some pages, or rescan at a lower resolution.`,
        );
      }

      if (verify) {
        setPendingSolve({ providers, body, variants });
        setPrepStatus("");
        await startInterpret(verify, images, notes);
        return;
      }

      start(providers, body, null, variants);
    } catch (prepError) {
      setError(
        prepError instanceof Error ? prepError.message : "Could not prepare the uploads.",
      );
    } finally {
      setPrepStatus("");
    }
  }

  function confirmInterpretation(confirmedText: string) {
    if (!pendingSolve) return;
    const { providers, body, variants } = pendingSolve;
    setPendingSolve(null);
    resetInterpret();
    start(providers, { ...body, interpretation: confirmedText }, null, variants);
  }

  return (
    <main className="cs-backdrop min-h-screen text-cs-ink">
      <div className="mx-auto w-full max-w-[860px] px-5 pb-16 pt-6 sm:px-6">
        <div className="flex justify-end print:hidden">
          <ThemeSwitcher />
        </div>
        <header className="pb-9 pt-4 text-center print:hidden">
          {theme === "unicorn" ? <UnicornCrest /> : null}
          <div className="mb-2 inline-flex items-center gap-3">
            <div className="cs-primary flex h-11 w-11 items-center justify-center rounded-cs bg-cs-accent text-cs-on-accent shadow-[0_2px_12px_var(--cs-ring)]">
              <Calculator className="h-5 w-5" />
            </div>
            <div className="font-display text-[2.1rem] font-bold tracking-normal text-cs-ink">
              Civil<span className="text-cs-accent">Solve</span>
            </div>
          </div>
          <p className="text-xs font-medium uppercase tracking-[0.32em] text-cs-ink-3">
            Step-by-Step Engineering Solutions
          </p>
        </header>

        <UploadForm
          providerStatus={providerStatus}
          busy={busy}
          busyLabel={
            isInterpreting
              ? "Reading the question..."
              : prepStatus
                ? "Preparing the upload..."
                : "Generating solutions..."
          }
          solving={isSolving || isInterpreting}
          status={statusMessage}
          error={bannerError}
          onSolve={handleSolve}
          onCancel={cancelAll}
        />

        {pipeline.status === "review" ? (
          <InterpretationReview
            interpretation={pipeline.interpretation}
            initialText={pipeline.text}
            note={pipeline.note}
            solvers={
              pendingSolve
                ? pendingSolve.providers.map((key) => providerDisplayName(key, pendingSolve.variants[key]))
                : []
            }
            onConfirm={confirmInterpretation}
            onCancel={cancelAll}
          />
        ) : null}

        {runtimeError ? (
          <div className="mt-5 rounded-cs border border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] px-4 py-3 text-sm text-cs-danger print:hidden">
            Browser runtime error: {runtimeError}
          </div>
        ) : null}

        <Suspense
          fallback={
            <div className="mt-10 flex items-center justify-center gap-2 text-sm text-cs-ink-3 print:hidden">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading solution view...
            </div>
          }
        >
          {recovered ? (
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-cs border border-cs-line bg-cs-surface px-4 py-3 text-sm text-cs-ink-2 print:hidden">
              <span className="flex items-center gap-2">
                <History className="h-4 w-4 shrink-0 text-cs-accent" aria-hidden="true" />
                Your last run, recovered from this browser. Results are kept for 24 hours.
              </span>
              <button
                type="button"
                onClick={clearRecovered}
                className="inline-flex items-center gap-1 rounded-cs border border-cs-line px-3 py-1 text-xs font-semibold transition hover:border-cs-accent hover:text-cs-accent"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                Clear
              </button>
            </div>
          ) : null}
          <SolutionPanel
            runs={runs}
            judgeRun={judgeRun}
            progress={progress}
            judgeProgress={judgeProgress}
            variants={runVariants}
            providerStatus={providerStatus}
            canRerun={canRerun}
            locked={isInterpreting || Boolean(prepStatus)}
            onSolveProvider={solveProvider}
            onCrossCheck={crossCheck}
          />
        </Suspense>
      </div>
    </main>
  );
}
