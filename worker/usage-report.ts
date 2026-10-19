// The usage page's data (19 October 2026, the owner's request): the usage
// log (worker/usage.ts) summed up for /admin/usage - by day, by IP, by part of
// the page and model - with the latest rows, in one D1 batch. Read by
// GET /api/admin/usage, which needs no password (the owner's call).

import type { WorkerEnv } from "./channels";
import type { UsageReport } from "../shared/usage-report";

export const MAX_RECENT_ROWS = 200;
const MAX_IP_ROWS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The days a day is counted in: Hong Kong time, where the owner and the
 * students are (no daylight saving, so a fixed offset is exact).
 */
const LOCAL_DAY = "date(started_at / 1000, 'unixepoch', '+8 hours')";

// What each summary counts. A task is a model-calling request that was let
// through; requests turned away and PDFs are counted on their own.
const TASK = "kind != 'pdf' AND outcome NOT IN ('rejected', 'rate-limited')";
const METRICS = `
  count(DISTINCT CASE WHEN kind != 'pdf' THEN question END) AS questions,
  count(DISTINCT ip) AS users,
  sum(CASE WHEN ${TASK} THEN 1 ELSE 0 END) AS tasks,
  coalesce(sum(model_calls), 0) AS modelCalls,
  sum(CASE WHEN outcome IN ('error', 'timeout') THEN 1 ELSE 0 END) AS failed,
  sum(CASE WHEN outcome IN ('rejected', 'rate-limited') THEN 1 ELSE 0 END) AS turnedAway,
  sum(CASE WHEN kind = 'pdf' AND outcome = 'done' THEN 1 ELSE 0 END) AS pdfs`;

export type UsageFilter = { days: number; ip: string | null; question: string | null };

/** Reads the filter from the query string: `days` (0 = everything), `ip`, `question`. */
export function usageFilter(query: URLSearchParams): UsageFilter {
  const days = Number(query.get("days") ?? 30);
  const text = (name: string) => {
    const value = query.get(name)?.trim();
    return value ? value.slice(0, 64) : null;
  };
  return {
    days: Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : 0,
    ip: text("ip"),
    question: text("question"),
  };
}

/**
 * The latest rows' links (19 October 2026, the owner's request), to what is
 * already kept and nothing new: a task's answer, in its TaskJob for 24 hours
 * after it finished (GET /api/jobs/:id), and the PDF of it someone asked
 * for, in R2 for good. `pdfKept` checks the bucket for a job's PDF - asked
 * only of jobs whose PDF the log says was served.
 */
export async function usageReport(
  db: D1Database,
  filter: UsageFilter,
  pdfKept: (jobId: string) => Promise<boolean> = async () => false,
): Promise<UsageReport> {
  const now = Date.now();
  const since = filter.days ? now - filter.days * DAY_MS : 0;
  const clauses = ["started_at >= ?"];
  const binds: unknown[] = [since];
  if (filter.ip) {
    clauses.push("ip = ?");
    binds.push(filter.ip);
  }
  if (filter.question) {
    clauses.push("question = ?");
    binds.push(filter.question);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const query = (sql: string) => db.prepare(sql).bind(...binds);

  const [totals, daily, byIp, byPart, recent, pdfs] = await db.batch([
    query(`SELECT ${METRICS} FROM usage_log ${where}`),
    query(`SELECT ${LOCAL_DAY} AS day, ${METRICS} FROM usage_log ${where} GROUP BY day ORDER BY day DESC`),
    query(
      `SELECT ip, max(country) AS country, ${METRICS}, max(started_at) AS lastSeen
       FROM usage_log ${where} GROUP BY ip ORDER BY modelCalls DESC, lastSeen DESC LIMIT ${MAX_IP_ROWS}`,
    ),
    query(
      `SELECT kind, detail, provider, variant, model,
         count(*) AS tasks,
         coalesce(sum(model_calls), 0) AS modelCalls,
         sum(CASE WHEN outcome = 'done' THEN 1 ELSE 0 END) AS done,
         sum(CASE WHEN outcome IN ('error', 'timeout') THEN 1 ELSE 0 END) AS failed,
         sum(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
         avg(CASE WHEN outcome = 'done' THEN duration_ms END) AS avgDoneMs
       FROM usage_log ${where} AND ${TASK}
       GROUP BY kind, detail, provider, variant, model
       ORDER BY modelCalls DESC, tasks DESC`,
    ),
    query(
      `SELECT id, started_at AS startedAt, ended_at AS endedAt, ip, country, job_id AS jobId, kind, detail,
         revision, provider, variant, effort, question, pages, solutions, model, channel,
         model_calls AS modelCalls, outcome, duration_ms AS durationMs, error
       FROM usage_log ${where} ORDER BY id DESC LIMIT ${MAX_RECENT_ROWS}`,
    ),
    // The jobs whose PDF was served since the range began: asked after their
    // task, from any IP (a shared link opens elsewhere), so by time alone.
    db
      .prepare("SELECT DISTINCT job_id AS jobId FROM usage_log WHERE kind = 'pdf' AND outcome = 'done' AND started_at >= ?")
      .bind(since),
  ]);

  type RecentRow = Omit<UsageReport["recent"][number], "pdf">;
  const served = new Set((pdfs.results as Array<{ jobId: string | null }>).map((row) => row.jobId));
  const rows = recent.results as RecentRow[];
  const kept = new Set(
    (
      await Promise.all(
        [...new Set(rows.filter((row) => row.kind !== "pdf" && row.jobId && served.has(row.jobId)).map((row) => row.jobId!))].map(
          async (jobId) => ((await pdfKept(jobId).catch(() => false)) ? jobId : null),
        ),
      )
    ).filter(Boolean),
  );

  return {
    generatedAt: now,
    filter: { days: filter.days, ip: filter.ip, question: filter.question },
    totals: (totals.results[0] ?? {}) as UsageReport["totals"],
    daily: daily.results as UsageReport["daily"],
    byIp: byIp.results as UsageReport["byIp"],
    byPart: byPart.results as UsageReport["byPart"],
    recent: rows.map((row) => ({ ...row, pdf: row.kind !== "pdf" && Boolean(row.jobId && kept.has(row.jobId)) })),
  };
}
