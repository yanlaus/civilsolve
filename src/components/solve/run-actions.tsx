// What can still be done with a run's upload once its solvers have
// answered, without uploading again: solve it with another provider (Add a
// solver, a card of its own under the solutions), or run the answer
// cross-check over the finished solutions (the controls at the top of the
// cross-check section, above its verdict) - one that was not switched on,
// that failed, or whose verdict came before a solver was added or retried.
// The two were one panel until 3 October 2026 (the owner's call). Both reuse
// the run's images, notes, thinking level and confirmed reading, which the
// page keeps in memory and in this browser's IndexedDB
// (lib/upload-store.ts), so they work after a reload too.

import { useState } from "react";
import { Plus, Scale } from "lucide-react";
import { MAX_JUDGED_SOLUTIONS } from "../../../shared/judgement";
import { EFFORT_KEYS, type EffortKey } from "../../../shared/prompt";
import {
  choiceKey,
  canonicalChoice,
  modelStatus,
  DEFAULT_JUDGE,
  MODEL_CHOICES,
  parseChoice,
  PROVIDER_KEYS,
  providerDisplayName,
  SOLVER_KEYS,
  type ModelChoice,
  type ModelVariant,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import {
  isJudgeActive,
  isRunActive,
  type JudgeRun,
  type ProviderRuns,
  type RunVariants,
} from "@/hooks/use-solve";
import { effortBand } from "@/lib/effort-band";
import { ProviderLogo } from "./provider-logo";

const PANEL_CLASS =
  "cs-panel rounded-cs-lg border border-cs-line-soft bg-cs-surface p-5 shadow-[0_1px_3px_var(--cs-shadow)] print:hidden";
const SELECT_CLASS =
  "mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent disabled:opacity-50";
const BUTTON_CLASS =
  "cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
const HINT_CLASS = "mt-2 text-[0.7rem] text-cs-ink-3";
const NO_IMAGES_CLASS =
  "rounded-cs border border-cs-line-soft bg-cs-surface px-4 py-3 text-xs text-cs-ink-3 print:hidden";

function configuredIn(providerStatus: Record<ProviderKey, ProviderStatus> | null) {
  return (choice: ModelChoice) => modelStatus(providerStatus?.[choice.provider], choice.variant)?.configured !== false;
}

/** Solve this run's upload with one more provider. */
export function AddSolver({
  runs,
  judgeRun,
  providerStatus,
  canRerun,
  locked,
  onSolveProvider,
}: {
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** Whether the run's images are still at hand to send again. */
  canRerun: boolean;
  /** True while the page prepares or reads a new upload. */
  locked: boolean;
  onSolveProvider: (provider: ProviderKey, variant?: ModelVariant) => void;
}) {
  const configured = configuredIn(providerStatus);
  // Every configured solver not already in this run - one entry per model
  // where a provider offers several (Gemini Flash, Gemini Pro).
  const addable = MODEL_CHOICES.filter(
    (choice) =>
      SOLVER_KEYS.includes(choice.provider) &&
      runs[choice.provider].status === "idle" &&
      configured(choice),
  );
  const [addPick, setAddPick] = useState<string | null>(null);
  const toAdd =
    addable.find((choice) => choiceKey(choice) === addPick) ?? (addable[0] as ModelChoice | undefined);
  const judging = isJudgeActive(judgeRun);

  if (!canRerun) {
    return (
      <p className={`mt-4 ${NO_IMAGES_CLASS}`}>
        Adding or retrying a solver needs this run&apos;s images, which this browser no longer has.
        Upload the question again to do that.
      </p>
    );
  }

  return (
    <div className={`mt-4 ${PANEL_CLASS}`}>
      <p className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
        <Plus className="h-4 w-4 text-cs-accent" aria-hidden="true" />
        Add a solver
      </p>
      {addable.length ? (
        <>
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block text-xs text-cs-ink-3">
              Provider
              <select
                value={toAdd ? choiceKey(toAdd) : ""}
                disabled={locked || judging}
                onChange={(event) => setAddPick(event.target.value)}
                className={SELECT_CLASS}
              >
                {addable.map((choice) => (
                  <option key={choiceKey(choice)} value={choiceKey(choice)}>
                    {providerDisplayName(choice.provider, choice.variant)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={BUTTON_CLASS}
              disabled={locked || judging || !toAdd}
              onClick={() => toAdd && onSolveProvider(toAdd.provider, toAdd.variant)}
            >
              Solve with {toAdd ? providerDisplayName(toAdd.provider, toAdd.variant) : ""}
            </button>
          </div>
          <p className={HINT_CLASS}>
            {judging
              ? "Waits for the cross-check to finish."
              : "Same images, notes, thinking level and confirmed reading as this run."}
          </p>
        </>
      ) : (
        <p className={HINT_CLASS}>Every available provider has already solved this upload.</p>
      )}
    </div>
  );
}

/** Run the answer cross-check (again) over the finished solutions the user ticks. */
export function CrossCheckControls({
  runs,
  judgeRun,
  variants,
  providerStatus,
  canRerun,
  locked,
  onCrossCheck,
}: {
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  /** The model each solver and the judge ran, where a provider offers several. */
  variants: RunVariants;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** Whether the run's images are still at hand to send again. */
  canRerun: boolean;
  /** True while the page prepares or reads a new upload. */
  locked: boolean;
  onCrossCheck: (judge: ModelChoice, providers: ProviderKey[], effort: EffortKey) => void;
}) {
  const configured = configuredIn(providerStatus);
  const nameOf = (key: ProviderKey) => providerDisplayName(key, variants.solvers[key]);

  // The finished solutions, in picker order (the judge's A, B...).
  const finished = PROVIDER_KEYS.filter((key) => runs[key].status === "done");
  const [picked, setPicked] = useState<ProviderKey[] | null>(null);
  const chosen = (picked ?? finished.slice(0, MAX_JUDGED_SOLUTIONS)).filter((key) =>
    finished.includes(key),
  );
  const judges = MODEL_CHOICES.filter(configured);
  const [judgePick, setJudgePick] = useState<ModelChoice | null>(null);
  const judge: ModelChoice =
    canonicalChoice(judgePick ??
    (judgeRun.status !== "idle" ? { provider: judgeRun.judge, variant: variants.judge } : DEFAULT_JUDGE));

  // How hard the judge thinks: high by default, the most reliable level
  // measured for grading. A judge's route may not offer every level (ChatGPT
  // runs at high or max); those are disabled, and a pick outside the band
  // moves to its nearest edge rather than being silently raised by the server.
  const [effortPick, setEffortPick] = useState<EffortKey>("high");
  const { inBand, clamp } = effortBand(modelStatus(providerStatus?.[judge.provider], judge.variant));
  const judgeEffort = clamp(effortPick);

  const solving = PROVIDER_KEYS.some((key) => isRunActive(runs[key]));
  const judging = isJudgeActive(judgeRun);
  const hasVerdict = judgeRun.status === "done" || judgeRun.status === "error";

  if (!canRerun) {
    return (
      <p className={NO_IMAGES_CLASS}>
        Running the cross-check needs this run&apos;s images, which this browser no longer has.
        Upload the question again to do that.
      </p>
    );
  }

  function togglePicked(key: ProviderKey) {
    const current = chosen;
    setPicked(
      current.includes(key)
        ? current.filter((item) => item !== key)
        : PROVIDER_KEYS.filter((item) => item === key || current.includes(item)),
    );
  }

  const blocked =
    finished.length < 2
      ? "Needs at least two finished solutions."
      : solving
        ? "Waits for the solvers still running."
        : chosen.length < 2
          ? "Tick at least two solutions."
          : chosen.length > MAX_JUDGED_SOLUTIONS
            ? `The judge compares up to ${MAX_JUDGED_SOLUTIONS} solutions - untick some.`
            : "";

  return (
    <div className={PANEL_CLASS}>
      <p className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
        <Scale className="h-4 w-4 text-cs-accent" aria-hidden="true" />
        {hasVerdict ? "Cross-check again" : "Cross-check these solutions"}
      </p>
      {finished.length ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {finished.map((key) => (
            <label key={key} className="flex cursor-pointer items-center gap-1.5 text-sm text-cs-ink-2">
              <input
                type="checkbox"
                checked={chosen.includes(key)}
                disabled={locked || judging}
                onChange={() => togglePicked(key)}
                className="h-4 w-4 accent-cs-accent"
              />
              <ProviderLogo provider={key} className="h-4 w-4 shrink-0" />
              {nameOf(key)}
            </label>
          ))}
        </div>
      ) : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="block text-xs text-cs-ink-3">
          Judge
          <select
            value={choiceKey(judge)}
            disabled={locked || judging}
            onChange={(event) => {
              const next = parseChoice(event.target.value);
              if (next) setJudgePick(next);
            }}
            className={SELECT_CLASS}
          >
            {judges.map((choice) => (
              <option key={choiceKey(choice)} value={choiceKey(choice)}>
                {providerDisplayName(choice.provider, choice.variant)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-cs-ink-3">
          Judge&apos;s thinking
          <select
            value={judgeEffort}
            disabled={locked || judging}
            onChange={(event) => setEffortPick(event.target.value as EffortKey)}
            className={SELECT_CLASS}
          >
            {EFFORT_KEYS.map((key) => (
              <option key={key} value={key} disabled={!inBand(key)}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
                {key === "high" ? " (default)" : ""}
                {inBand(key) ? "" : " - not offered by this judge"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={locked || judging || Boolean(blocked)}
          onClick={() => onCrossCheck(judge, chosen, judgeEffort)}
        >
          {judging ? "Cross-checking..." : hasVerdict ? "Run the cross-check again" : "Run the cross-check"}
        </button>
      </div>
      <p className={HINT_CLASS}>
        {blocked ||
          "One extra model call. The judge sees Solution A, B... and never learns which model wrote which."}
      </p>
    </div>
  );
}
