// What can still be done with a run's upload once its solvers have
// answered, without uploading again: solve it with another provider, or run
// the answer cross-check over the finished solutions - one that was not
// switched on, that failed, or whose verdict came before a solver was added
// or retried. Both reuse the run's images, notes, thinking level and
// confirmed reading, which the page keeps in memory and in this browser's
// IndexedDB (lib/upload-store.ts), so they work after a reload too.

import { useState } from "react";
import { Plus, Scale } from "lucide-react";
import { MAX_JUDGED_SOLUTIONS } from "../../../shared/judgement";
import {
  DEFAULT_JUDGE,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  SOLVER_KEYS,
  type ProviderKey,
  type ProviderStatus,
} from "../../../shared/providers";
import { isJudgeActive, isRunActive, type JudgeRun, type ProviderRuns } from "@/hooks/use-solve";

const SELECT_CLASS =
  "mt-1 w-full rounded-cs border border-cs-line bg-cs-surface px-3 py-2 text-sm text-cs-ink outline-none transition focus:border-cs-accent disabled:opacity-50";
const BUTTON_CLASS =
  "cs-primary inline-flex items-center justify-center gap-2 rounded-cs bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-on-accent transition hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50";
const HINT_CLASS = "mt-2 text-[0.7rem] text-cs-ink-3";

export function RunActions({
  runs,
  judgeRun,
  providerStatus,
  canRerun,
  locked,
  onSolveProvider,
  onCrossCheck,
}: {
  runs: ProviderRuns;
  judgeRun: JudgeRun;
  providerStatus: Record<ProviderKey, ProviderStatus> | null;
  /** Whether the run's images are still at hand to send again. */
  canRerun: boolean;
  /** True while the page prepares or reads a new upload. */
  locked: boolean;
  onSolveProvider: (provider: ProviderKey) => void;
  onCrossCheck: (judge: ProviderKey, providers: ProviderKey[]) => void;
}) {
  const configured = (key: ProviderKey) =>
    providerStatus ? providerStatus[key]?.configured !== false : true;

  // Add a solver: every configured one not already in this run.
  const addable = SOLVER_KEYS.filter((key) => runs[key].status === "idle" && configured(key));
  const [addPick, setAddPick] = useState<ProviderKey | null>(null);
  const toAdd = addPick && addable.includes(addPick) ? addPick : addable[0];

  // Cross-check: the finished solutions, in picker order (the judge's A, B...).
  const finished = PROVIDER_KEYS.filter((key) => runs[key].status === "done");
  const [picked, setPicked] = useState<ProviderKey[] | null>(null);
  const chosen = (picked ?? finished.slice(0, MAX_JUDGED_SOLUTIONS)).filter((key) =>
    finished.includes(key),
  );
  const judges = PROVIDER_KEYS.filter(configured);
  const [judgePick, setJudgePick] = useState<ProviderKey | null>(null);
  const judge =
    judgePick ?? (judgeRun.status !== "idle" ? judgeRun.judge : DEFAULT_JUDGE);

  const solving = PROVIDER_KEYS.some((key) => isRunActive(runs[key]));
  const judging = isJudgeActive(judgeRun);
  const hasVerdict = judgeRun.status === "done" || judgeRun.status === "error";

  if (!canRerun) {
    return (
      <p className="mt-4 rounded-cs border border-cs-line-soft bg-cs-surface px-4 py-3 text-xs text-cs-ink-3 print:hidden">
        Adding a solver, retrying one or running the cross-check needs this run&apos;s images,
        which this browser no longer has. Upload the question again to do that.
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

  const crossCheckBlocked =
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
    <div className="cs-panel mt-4 grid gap-4 rounded-cs-lg border border-cs-line-soft bg-cs-surface p-5 shadow-[0_1px_3px_var(--cs-shadow)] print:hidden sm:grid-cols-2">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
          <Plus className="h-4 w-4 text-cs-accent" aria-hidden="true" />
          Add a solver
        </p>
        {addable.length ? (
          <>
            <label className="mt-2 block text-xs text-cs-ink-3">
              Provider
              <select
                value={toAdd}
                disabled={locked || judging}
                onChange={(event) => setAddPick(event.target.value as ProviderKey)}
                className={SELECT_CLASS}
              >
                {addable.map((key) => (
                  <option key={key} value={key}>
                    {PROVIDER_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={`${BUTTON_CLASS} mt-3`}
              disabled={locked || judging || !toAdd}
              onClick={() => toAdd && onSolveProvider(toAdd)}
            >
              Solve with {PROVIDER_LABELS[toAdd]}
            </button>
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

      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-cs-ink">
          <Scale className="h-4 w-4 text-cs-accent" aria-hidden="true" />
          {hasVerdict ? "Cross-check again" : "Cross-check these solutions"}
        </p>
        {finished.length ? (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {finished.map((key) => (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-1.5 text-sm text-cs-ink-2"
              >
                <input
                  type="checkbox"
                  checked={chosen.includes(key)}
                  disabled={locked || judging}
                  onChange={() => togglePicked(key)}
                  className="h-4 w-4 accent-cs-accent"
                />
                {PROVIDER_LABELS[key]}
              </label>
            ))}
          </div>
        ) : null}
        <label className="mt-2 block text-xs text-cs-ink-3">
          Judge
          <select
            value={judge}
            disabled={locked || judging}
            onChange={(event) => setJudgePick(event.target.value as ProviderKey)}
            className={SELECT_CLASS}
          >
            {judges.map((key) => (
              <option key={key} value={key}>
                {PROVIDER_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`${BUTTON_CLASS} mt-3`}
          disabled={locked || judging || Boolean(crossCheckBlocked)}
          onClick={() => onCrossCheck(judge, chosen)}
        >
          {judging ? "Cross-checking..." : hasVerdict ? "Run the cross-check again" : "Run the cross-check"}
        </button>
        <p className={HINT_CLASS}>
          {crossCheckBlocked ||
            "One extra model call. The judge sees Solution A, B... and never learns which model wrote which."}
        </p>
      </div>
    </div>
  );
}
