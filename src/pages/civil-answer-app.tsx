import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Calculator, History, Loader2, X } from "lucide-react";
import { InterpretProgress } from "@/components/solve/interpret-progress";
import { InterpretationReview } from "@/components/solve/interpretation-review";
import { JourneyBar, JumpButton } from "@/components/solve/journey-bar";
import { useTheme } from "@/components/theme-provider";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { UploadForm, type SolveSubmission } from "@/components/solve/upload-form";
import { useAsk } from "@/hooks/use-ask";
import { useCompletionAlert } from "@/hooks/use-completion-alert";
import { useHealth } from "@/hooks/use-health";
import { useHistory } from "@/hooks/use-history";
import { useInterpret } from "@/hooks/use-interpret";
import { isJudgeActive, isRunActive, isStudyActive, useSolve } from "@/hooks/use-solve";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { filesToImageDataUrls } from "@/lib/attachments";
import { buildJourney, scrollToStep, scrollToStepWhenReady, STEP_IDS, type JourneyStep } from "@/lib/journey";
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
// The history renders kept solutions, so it comes with the math chunk too.
const HistoryDrawer = lazy(() => import("@/components/history-drawer"));

/** The form's automatic cross-check as the judge `start` takes. */
function judgeOf(autoCheck: SolveSubmission["autoCheck"]) {
  return autoCheck ? { ...autoCheck.judge, effort: autoCheck.effort } : null;
}

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
// reviewed interpretation - nothing is solved before that. The automatic
// cross-check, when the form asked for one, follows the solvers.
type PendingSolve = {
  providers: ProviderKey[];
  body: SolveRequestBody;
  variants: Partial<Record<ProviderKey, ModelVariant>>;
  autoCheck: SolveSubmission["autoCheck"];
  /** The reconciler, which also re-generates the reading when asked. */
  verifierLabel: string;
};

export default function CivilAnswerAppPage() {
  const { theme } = useTheme();
  const {
    runs,
    judgeRun,
    progress,
    judgeProgress,
    variants: runVariants,
    interpretation: confirmedInterpretation,
    solutionVersions,
    canRerun,
    questionImages,
    runId,
    getBody,
    start,
    cancel,
    restore,
    dismiss,
    solveProvider,
    stopProvider,
    refineProvider,
    crossCheck,
    queueCrossCheck,
    canQueueCrossCheck,
    stopJudge,
    refineVerdict,
    studyRuns,
    studyProgress,
    writeStudy,
    stopStudy,
    refineStudy,
    pdfJobOf,
  } = useSolve();
  const { providerStatus } = useHealth();
  // Questions about a solution (問呢一步), answered in jobs of their own.
  const asks = useAsk({ runId, getBody });
  // Every question solved, kept in this browser for revision.
  const [historyOpen, setHistoryOpen] = useState(false);
  useHistory({
    runId,
    runs,
    judgeRun,
    studyRuns,
    variants: runVariants,
    interpretation: confirmedInterpretation,
    questionImages,
    notes: getBody()?.notes ?? "",
    pdfJobOf,
  });
  // Set when the page came back with the last run's results - the jobs kept
  // running on the server while the page was closed or reloaded.
  const [recovered, setRecovered] = useState(false);
  const restoreAttempted = useRef(false);
  // The form folds into one line once a run starts (lib/journey.ts, the step
  // bar): what comes next is then on screen rather than under the form.
  const [formCollapsed, setFormCollapsed] = useState(false);
  // What the form will run, before anything has: the step bar shows the
  // reading check as skipped in Quick.
  const [plan, setPlan] = useState({ verify: false, autoCheck: false });
  const onPlanChange = useCallback(
    (next: { verify: boolean; autoCheck: boolean }) =>
      setPlan((current) =>
        current.verify === next.verify && current.autoCheck === next.autoCheck ? current : next,
      ),
    [],
  );

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    if (restore()) {
      setRecovered(true);
      setFormCollapsed(true);
    }
  }, [restore]);
  const {
    pipeline,
    start: startInterpret,
    reset: resetInterpret,
    stopModel: stopReader,
    revise: reviseReading,
    stopRevise: stopReadingRevision,
  } = useInterpret();
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

  const isSolving =
    Object.values(runs).some(isRunActive) ||
    isJudgeActive(judgeRun) ||
    Object.values(studyRuns).some(isStudyActive);
  const isInterpreting = pipeline.status === "running";
  const busy = isSolving || isInterpreting || Boolean(prepStatus);
  const hasRun = Object.values(runs).some((run) => run.status !== "idle");
  // Folded only while there is something after it to look at.
  const collapsed = formCollapsed && (busy || pipeline.status !== "idle" || hasRun);

  const journey = buildJourney({
    preparing: Boolean(prepStatus),
    pipeline,
    plan,
    interpretation: confirmedInterpretation,
    runs,
    judgeRun,
  });
  const jump = useCallback((step: JourneyStep) => {
    if (step.target) scrollToStep(step.target);
  }, []);

  // The reading is ready for review: take the student to it - they were
  // watching the progress at the top.
  const lastPipelineStatus = useRef(pipeline.status);
  useEffect(() => {
    const previous = lastPipelineStatus.current;
    lastPipelineStatus.current = pipeline.status;
    if (pipeline.status === "review" && previous !== "review") return scrollToStepWhenReady(STEP_IDS.review);
  }, [pipeline.status]);

  // A long solve on a phone: keep the screen from locking while it runs.
  useWakeLock(isSolving || isInterpreting || asks.active);

  // The tab's title counts the solvers; a notification when all is done.
  const solverRuns = Object.values(runs).filter((run) => run.status !== "idle");
  const { notify, setNotify, notifyAvailable } = useCompletionAlert({
    running: isSolving || asks.active,
    finished: solverRuns.filter((run) => run.status === "done" || run.status === "error").length,
    total: solverRuns.length,
    summary: () => {
      const done = Object.values(runs).filter((run) => run.status === "done").length;
      const ready = `${done} solution${done === 1 ? "" : "s"} ready`;
      return judgeRun.status === "done" ? `${ready} · the cross-check has its verdict` : ready;
    },
  });

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
        onStop={stopInterpretation}
        onStopModel={stopReader}
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

  // The interpretation pass's own Stop. Nothing was solved yet, so this is
  // the page back where it was before Solve, the upload still in the form.
  function stopInterpretation() {
    resetInterpret();
    setPendingSolve(null);
    setFormCollapsed(false);
  }

  async function handleSolve({
    uploads,
    lectureFiles,
    providers,
    notes,
    effort,
    verify,
    variants,
    autoCheck,
  }: SolveSubmission) {
    setError("");
    setRecovered(false);
    resetInterpret();
    setPendingSolve(null);
    // A new question clears the last one's solutions and verdict first.
    // Left on screen while the new question was being read, they looked
    // like what the interpretation pass was working on (26 September 2026).
    dismiss();
    setFormCollapsed(true);
    setPrepStatus("Preparing images...");
    scrollToStepWhenReady(STEP_IDS.upload);

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
        setPendingSolve({
          providers,
          body,
          variants,
          autoCheck,
          verifierLabel: providerDisplayName(verify.verifier.provider, verify.verifier.variant),
        });
        setPrepStatus("");
        await startInterpret(verify, images, notes);
        return;
      }

      start(providers, body, judgeOf(autoCheck), variants);
      scrollToStepWhenReady(STEP_IDS.answers);
    } catch (prepError) {
      // Nothing was sent: back to the form to fix the upload.
      setFormCollapsed(false);
      setError(
        prepError instanceof Error ? prepError.message : "Could not prepare the uploads.",
      );
    } finally {
      setPrepStatus("");
    }
  }

  function confirmInterpretation(confirmedText: string) {
    if (!pendingSolve || pipeline.status !== "review") return;
    const { providers, body, variants, autoCheck } = pendingSolve;
    // Kept above the solutions: the Chinese and who read it go with the run.
    const extras = {
      chinese: pipeline.interpretation.traditional_chinese?.trim() || undefined,
      credit: pipeline.credit,
      note: pipeline.note,
    };
    setPendingSolve(null);
    resetInterpret();
    start(providers, { ...body, interpretation: confirmedText }, judgeOf(autoCheck), variants, extras);
    // The reading folds away and the solutions start below it: go to them.
    scrollToStepWhenReady(STEP_IDS.answers);
  }

  /** "New question": the run is cleared (it stays in the history) and the form opens empty. */
  function newQuestion() {
    setRecovered(false);
    resetInterpret();
    setPendingSolve(null);
    setError("");
    dismiss();
    setFormCollapsed(false);
    window.scrollTo({ top: 0 });
  }

  function expandForm() {
    setFormCollapsed(false);
    scrollToStepWhenReady(STEP_IDS.upload);
  }

  return (
    <main className="cs-backdrop min-h-screen text-cs-ink">
      <div className="mx-auto w-full max-w-[860px] px-5 pb-16 pt-6 sm:px-6">
        <div className="flex items-center justify-end gap-2 print:hidden">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-cs border border-cs-line bg-cs-surface px-3 py-1.5 text-xs font-semibold text-cs-ink-2 transition hover:border-cs-accent hover:text-cs-accent"
          >
            <History className="h-3.5 w-3.5" aria-hidden="true" />
            History · 紀錄
          </button>
          <ThemeSwitcher />
        </div>
        {historyOpen ? (
          <Suspense fallback={null}>
            <HistoryDrawer onClose={() => setHistoryOpen(false)} />
          </Suspense>
        ) : null}
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

        <JourneyBar steps={journey.steps} current={journey.current} onJump={jump} />
        <JumpButton step={journey.current} onJump={jump} />

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
          collapsed={collapsed}
          pageImages={pendingSolve?.body.images ?? questionImages}
          onExpand={expandForm}
          onCollapse={hasRun || pipeline.status === "review" ? () => setFormCollapsed(true) : undefined}
          onNewQuestion={newQuestion}
          onPlanChange={onPlanChange}
          footer={
            notifyAvailable ? (
              <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 text-xs text-cs-ink-3">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(event) => void setNotify(event.target.checked)}
                  className="h-3.5 w-3.5 accent-cs-accent"
                />
                Notify me when it&apos;s done · 完成時通知我
              </label>
            ) : null
          }
        />

        {pipeline.status === "review" ? (
          <InterpretationReview
            // A re-generated reading starts the review afresh from itself.
            key={pipeline.version}
            images={pendingSolve?.body.images ?? []}
            interpretation={pipeline.interpretation}
            initialText={pipeline.text}
            note={pipeline.note}
            reviser={
              pendingSolve?.verifierLabel ?? "the reconciler"
            }
            revising={pipeline.revising}
            reviseError={pipeline.reviseError}
            revisedWith={pipeline.revisedWith}
            onRevise={reviseReading}
            onStopRevise={stopReadingRevision}
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
            interpretation={confirmedInterpretation}
            solutionVersions={solutionVersions}
            providerStatus={providerStatus}
            canRerun={canRerun}
            questionImages={questionImages}
            locked={isInterpreting || Boolean(prepStatus)}
            onSolveProvider={solveProvider}
            onStopProvider={stopProvider}
            onRefineProvider={refineProvider}
            onCrossCheck={crossCheck}
            canQueueCrossCheck={canQueueCrossCheck}
            onQueueCrossCheck={queueCrossCheck}
            askThreads={asks.threads}
            askProgress={asks.progress}
            onAsk={asks.ask}
            onStopAsk={asks.stop}
            onStopJudge={stopJudge}
            onRefineVerdict={refineVerdict}
            studyRuns={studyRuns}
            studyProgress={studyProgress}
            onWriteStudy={writeStudy}
            onStopStudy={stopStudy}
            onRefineStudy={refineStudy}
            pdfJobOf={pdfJobOf}
          />
        </Suspense>
      </div>
    </main>
  );
}
