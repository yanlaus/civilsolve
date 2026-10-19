// What GET /api/admin/usage answers (worker/usage-report.ts) and the usage
// page reads (src/pages/usage-page.tsx): the usage log summed up.

export type UsageMetrics = {
  /** Distinct questions (page fingerprints). */
  questions: number;
  /** Distinct client IPs. */
  users: number;
  /** Model-calling requests let through. */
  tasks: number;
  /** Upstream requests: every attempt, retry and fallback. */
  modelCalls: number;
  /** Tasks that ended in an error or the safety timeout. */
  failed: number;
  /** Requests rate-limited or rejected. */
  turnedAway: number;
  /** PDFs served. */
  pdfs: number;
};

export type UsageReport = {
  generatedAt: number;
  filter: { days: number; ip: string | null; question: string | null };
  totals: UsageMetrics;
  /** Per Hong Kong day, latest first. */
  daily: Array<UsageMetrics & { day: string }>;
  byIp: Array<UsageMetrics & { ip: string | null; country: string | null; lastSeen: number }>;
  /** Tasks by part of the page and model. */
  byPart: Array<{
    kind: string;
    detail: string | null;
    provider: string | null;
    variant: string | null;
    model: string | null;
    tasks: number;
    modelCalls: number;
    done: number;
    failed: number;
    cancelled: number;
    avgDoneMs: number | null;
  }>;
  /** The latest rows, newest first. */
  recent: Array<{
    id: number;
    startedAt: number;
    endedAt: number | null;
    ip: string | null;
    country: string | null;
    /** The task's job: its answer is kept 24 hours after it finished (GET /api/jobs/:id). */
    jobId: string | null;
    kind: string;
    detail: string | null;
    revision: number;
    provider: string | null;
    variant: string | null;
    effort: string | null;
    question: string | null;
    pages: number | null;
    solutions: number | null;
    model: string | null;
    channel: string | null;
    modelCalls: number | null;
    outcome: string;
    durationMs: number | null;
    error: string | null;
    /** Its PDF is kept in R2 (GET /api/pdf/:id?existing serves it, never makes one). */
    pdf: boolean;
  }>;
};

/** The part of the page a row came from, in words: "Reading · reconcile". */
export function usagePartLabel(kind: string, detail: string | null, revision = 0): string {
  const base: Record<string, string> = {
    solve: "Solution 解題",
    interpret: "Reading 讀題",
    judge: "Cross-check 核對",
    study: "Study notes 筆記",
    ask: "Question 提問",
    align: "Answer comparison 比對",
    pdf: "PDF",
  };
  const steps: Record<string, string> = {
    read: "read",
    reconcile: "reconcile",
    revise: "revise",
    approach: "approach",
    explain: "explain",
    cache: "from cache",
    kept: "from storage",
    made: "made",
  };
  const label = base[kind] ?? kind;
  const step = detail ? ` · ${steps[detail] ?? detail}` : "";
  return `${label}${step}${revision ? " · re-generated" : ""}`;
}
