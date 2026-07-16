import { lazy, Suspense, useEffect, useState } from "react";
import { Calculator, Loader2 } from "lucide-react";
import { UploadForm, type SolveSubmission } from "@/components/solve/upload-form";
import { InterpretationReview } from "@/components/solve/interpretation-review";
import { isRunActive, useSolve } from "@/hooks/use-solve";
import { useInterpret } from "@/hooks/use-interpret";
import { filesToImageDataUrls } from "@/lib/attachments";
import { lectureNotesToPayload } from "@/lib/lecture-notes";
import { MAX_IMAGES, type SolveRequestBody } from "../../shared/stream-protocol";
import type { ProviderKey } from "../../shared/solution";

const SolutionPanel = lazy(() => import("@/components/solve/solution-panel"));

// Everything prepared at submit time and needed again after the user
// confirms the reviewed interpretation.
type PendingSolve = {
  providers: ProviderKey[];
  body: SolveRequestBody;
};

export default function CivilAnswerAppPage() {
  const { runs, start } = useSolve();
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

  const isSolving = Object.values(runs).some(isRunActive);
  const isInterpreting = pipeline.status === "running" || pipeline.status === "review";
  const busy = isSolving || isInterpreting || Boolean(prepStatus);

  const statusMessage =
    prepStatus || (pipeline.status === "running" ? pipeline.stage : "");
  const bannerError =
    error || (pipeline.status === "error" ? pipeline.message : "");

  async function handleSolve({
    files,
    lectureFiles,
    providers,
    notes,
    effort,
    verify,
  }: SolveSubmission) {
    setError("");
    resetInterpret();
    setPendingSolve(null);
    setPrepStatus("Preparing images...");

    try {
      const images = await filesToImageDataUrls(files);
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

      if (verify) {
        setPendingSolve({ providers, body });
        setPrepStatus("");
        await startInterpret(verify, images, notes);
        return;
      }

      start(providers, body);
    } catch (prepError) {
      setError(
        prepError instanceof Error ? prepError.message : "Could not prepare the uploads.",
      );
    } finally {
      setPrepStatus("");
    }
  }

  function handleInterpretationConfirm(confirmedText: string) {
    if (!pendingSolve) return;
    const { providers, body } = pendingSolve;
    setPendingSolve(null);
    resetInterpret();
    start(providers, { ...body, interpretation: confirmedText });
  }

  function handleInterpretationCancel() {
    setPendingSolve(null);
    resetInterpret();
  }

  return (
    <main className="min-h-screen bg-[#f4f1ec] bg-[linear-gradient(rgba(139,126,112,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(139,126,112,0.07)_1px,transparent_1px)] bg-[size:28px_28px] text-[#1b1610] print:bg-none dark:bg-[#0e1420] dark:bg-[linear-gradient(rgba(100,140,200,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(100,140,200,0.04)_1px,transparent_1px)] dark:text-[#e4e0db]">
      <div className="mx-auto w-full max-w-[860px] px-5 pb-16 pt-6 sm:px-6">
        <header className="py-9 text-center print:hidden">
          <div className="mb-2 inline-flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-[10px] bg-[#b35c1e] text-white shadow-[0_2px_12px_rgba(179,92,30,0.15)] dark:bg-[#e8903a] dark:text-[#0e1420]">
              <Calculator className="h-5 w-5" />
            </div>
            <div className="font-serif text-[2.1rem] font-bold tracking-normal text-[#1b1610] dark:text-[#e4e0db]">
              Civil<span className="text-[#b35c1e] dark:text-[#e8903a]">Solve</span>
            </div>
          </div>
          <p className="text-xs font-medium uppercase tracking-[0.32em] text-[#8a7f72] dark:text-[#a8a098]">
            Step-by-Step Engineering Solutions
          </p>
        </header>

        <UploadForm
          busy={busy}
          status={statusMessage}
          error={bannerError}
          onSolve={handleSolve}
        />

        {pipeline.status === "review" ? (
          <InterpretationReview
            interpretation={pipeline.interpretation}
            initialText={pipeline.text}
            onConfirm={handleInterpretationConfirm}
            onCancel={handleInterpretationCancel}
          />
        ) : null}

        {runtimeError ? (
          <div className="mt-5 rounded-[10px] border border-[#f0c1bc] bg-[rgba(192,57,43,0.08)] px-4 py-3 text-sm text-[#c0392b] print:hidden dark:border-[#5b2a31] dark:text-[#f2b8b2]">
            Browser runtime error: {runtimeError}
          </div>
        ) : null}

        <Suspense
          fallback={
            <div className="mt-10 flex items-center justify-center gap-2 text-sm text-[#8a7f72] print:hidden dark:text-[#a8a098]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading solution view...
            </div>
          }
        >
          <SolutionPanel runs={runs} />
        </Suspense>
      </div>
    </main>
  );
}
