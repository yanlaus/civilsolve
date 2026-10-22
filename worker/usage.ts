// The usage log (18 October 2026, the owner's request): who used the app,
// when, for which question and which part of the page - a solution, a
// reading, the cross-check, study notes, a question about a solution, the
// answer comparison, a PDF - with which model, how many upstream calls it
// took and how it ended. One row per task in the D1 database
// "civilsolve-usage" (binding USAGE, table usage_log - migrations/), written
// when the task starts and completed when it ends.
//
// Metadata only: never the pages, notes, prompts or answers. A question is
// recognised by a fingerprint of its pages, not by the pages. Rows - IP
// addresses included - are kept for good (the owner's call). Read them in the
// Cloudflare dashboard's D1 console (README, "Usage log").
//
// Best effort throughout: a log write that fails is reported to the Worker's
// logs and never fails, delays or changes a task.

import type { WorkerEnv } from "./channels";
import type { TaskOutcome } from "./run";

export type UsageKind = "solve" | "interpret" | "judge" | "study" | "ask" | "align" | "visualize" | "pdf";

export type UsageOutcome = TaskOutcome["outcome"] | "running" | "rejected" | "rate-limited";

/** Who asked, as the Worker saw them. Handed to a TaskJob in these headers. */
export type UsageClient = { ip: string | null; country: string | null };

export const CLIENT_IP_HEADER = "x-usage-ip";
export const CLIENT_COUNTRY_HEADER = "x-usage-country";

/** The client of a request reaching the Worker from the internet. */
export function clientOf(request: Request): UsageClient {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  return {
    ip: request.headers.get("cf-connecting-ip"),
    country: typeof cf?.country === "string" ? cf.country : null,
  };
}

/** The client a Worker passed on to a TaskJob (never set by a browser: see clientHeaders). */
export function forwardedClient(request: Request): UsageClient {
  return {
    ip: request.headers.get(CLIENT_IP_HEADER),
    country: request.headers.get(CLIENT_COUNTRY_HEADER),
  };
}

export function clientHeaders(client: UsageClient): Record<string, string> {
  const headers: Record<string, string> = {};
  if (client.ip) headers[CLIENT_IP_HEADER] = client.ip;
  if (client.country) headers[CLIENT_COUNTRY_HEADER] = client.country;
  return headers;
}

/** What a request asked for, read from its body - nothing of its content kept. */
export type UsageRequest = {
  kind: UsageKind;
  detail: string | null;
  revision: boolean;
  provider: string | null;
  variant: string | null;
  effort: string | null;
  question: string | null;
  pages: number | null;
  notesPages: number | null;
  solutions: number | null;
};

const READING_STEPS: Record<string, string> = { interpret: "read", verify: "reconcile", revise: "revise" };

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 40) : null;
}

/**
 * Which question: the first 16 hex digits of a SHA-256 over its pages, in
 * order. Every task of one run is sent the same pages - the readings, the
 * solutions, the cross-check, the notes, the questions - so they share it,
 * and so does the same question solved again.
 */
export async function questionFingerprint(images: string[]): Promise<string | null> {
  if (!images.length) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(images.join("\n")));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function describeRequest(
  kind: UsageKind,
  provider: string | null,
  body: Record<string, unknown> | null,
): Promise<UsageRequest> {
  const images = strings(body?.images);
  const solutions = kind === "align" ? strings(body?.answers) : strings(body?.solutions);
  let detail: string | null = null;
  if (kind === "interpret") detail = READING_STEPS[String(body?.mode ?? "interpret")] ?? "read";
  if (kind === "study") detail = text(body?.kind);
  // A deck drawn, or one board of it drawn again.
  if (kind === "visualize") detail = body?.fix ? "fix" : body?.purpose === "diagrams" ? "diagrams" : "draw";
  return {
    kind,
    detail,
    revision: Boolean(body?.revision),
    provider,
    variant: text(body?.variant),
    effort: text(body?.effort),
    question: await questionFingerprint(images),
    pages: body ? images.length : null,
    notesPages: body ? strings(body.referenceImages).length : null,
    solutions: solutions.length || null,
  };
}

function report(what: string, error: unknown) {
  console.warn(`usage log: ${what} not written`, error instanceof Error ? error.message : error);
}

const COLUMNS =
  "started_at, ended_at, ip, country, job_id, kind, detail, revision, provider, variant, effort, " +
  "question, pages, notes_pages, solutions, model, channel, model_calls, outcome, duration_ms, error";
const PLACEHOLDERS = COLUMNS.split(",").map(() => "?").join(", ");

type Row = {
  startedAt: number;
  endedAt: number | null;
  client: UsageClient;
  jobId: string | null;
  request: UsageRequest;
  model: string | null;
  channel: string | null;
  modelCalls: number | null;
  outcome: UsageOutcome;
  error: string | null;
};

function values(row: Row) {
  const { request } = row;
  return [
    row.startedAt,
    row.endedAt,
    row.client.ip,
    row.client.country,
    row.jobId,
    request.kind,
    request.detail,
    request.revision ? 1 : 0,
    request.provider,
    request.variant,
    request.effort,
    request.question,
    request.pages,
    request.notesPages,
    request.solutions,
    row.model,
    row.channel,
    row.modelCalls,
    row.outcome,
    row.endedAt === null ? null : row.endedAt - row.startedAt,
    row.error ? row.error.slice(0, 300) : null,
  ];
}

/** A task that has started: its row, marked running. Resolves to the row's id. */
export async function logTaskStart(
  env: WorkerEnv,
  start: { startedAt: number; client: UsageClient; jobId: string | null; request: UsageRequest; model: string; channel: string },
): Promise<number | null> {
  if (!env.USAGE) return null;
  try {
    const row = await env.USAGE.prepare(`INSERT INTO usage_log (${COLUMNS}) VALUES (${PLACEHOLDERS}) RETURNING id`)
      .bind(...values({ ...start, endedAt: null, modelCalls: null, outcome: "running", error: null }))
      .first<{ id: number }>();
    return row?.id ?? null;
  } catch (error) {
    report("task start", error);
    return null;
  }
}

/** How the task ended, on the row its start wrote. */
export async function logTaskEnd(env: WorkerEnv, id: number | null, startedAt: number, outcome: TaskOutcome) {
  if (!env.USAGE || id === null) return;
  const endedAt = Date.now();
  try {
    await env.USAGE.prepare(
      "UPDATE usage_log SET ended_at = ?, duration_ms = ?, outcome = ?, model = ?, channel = ?, " +
        "model_calls = ?, effort = ?, error = ? WHERE id = ?",
    )
      .bind(
        endedAt,
        endedAt - startedAt,
        outcome.outcome,
        outcome.model,
        outcome.channel,
        outcome.modelCalls,
        outcome.effort,
        outcome.error ? outcome.error.slice(0, 300) : null,
        id,
      )
      .run();
  } catch (error) {
    report("task end", error);
  }
}

/**
 * A request that ended at once: turned away (rate limit, bad request) or a
 * PDF served. One complete row.
 */
export async function logRequest(
  env: WorkerEnv,
  entry: {
    startedAt: number;
    client: UsageClient;
    jobId?: string | null;
    request: UsageRequest;
    outcome: UsageOutcome;
    error?: string | null;
  },
) {
  if (!env.USAGE) return;
  try {
    await env.USAGE.prepare(`INSERT INTO usage_log (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
      .bind(
        ...values({
          startedAt: entry.startedAt,
          endedAt: Date.now(),
          client: entry.client,
          jobId: entry.jobId ?? null,
          request: entry.request,
          model: null,
          channel: null,
          modelCalls: 0,
          outcome: entry.outcome,
          error: entry.error ?? null,
        }),
      )
      .run();
  } catch (error) {
    report("request", error);
  }
}
