// The last run's job ids, kept in localStorage so the page can re-attach to
// them after it was reloaded - a phone that discarded the tab in the
// background, a refresh - not just after a dropped connection.
//
// Only ids and provider names are kept here, never images or answers: the
// answers live on the server (worker/jobs.ts) for 24 hours, and so does this
// record. Everything is best effort - storage can be unavailable (private
// browsing, blocked site data) and the page works without it.

import { isProviderKey, type ProviderKey } from "../../shared/providers";

const KEY = "civilsolve:last-run";

/** Matches JOB_RETENTION_MS on the server: past this the jobs are gone. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type SavedJudge = {
  provider: ProviderKey;
  /** Set once the cross-check was sent; until then it cannot be resumed. */
  jobId?: string;
  /** Solution A, B, ... in order, and the solvers left out - for the verdict card. */
  solvers?: ProviderKey[];
  skipped?: ProviderKey[];
};

export type SavedRun = {
  savedAt: number;
  /** The solvers, in picker order. */
  providers: ProviderKey[];
  solveJobs: Partial<Record<ProviderKey, string>>;
  judge: SavedJudge | null;
};

export function loadRun(): SavedRun | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const run = JSON.parse(raw) as SavedRun;
    const valid =
      typeof run?.savedAt === "number" &&
      Array.isArray(run.providers) &&
      run.providers.every((provider) => typeof provider === "string" && isProviderKey(provider)) &&
      run.solveJobs &&
      typeof run.solveJobs === "object";
    if (!valid || Date.now() - run.savedAt > RETENTION_MS) {
      clearRun();
      return null;
    }
    return run;
  } catch {
    return null;
  }
}

export function saveRun(run: SavedRun) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(run));
  } catch {
    // Unavailable storage only costs recovery after a reload.
  }
}

export function clearRun() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
