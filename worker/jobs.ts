// TaskJob: a Durable Object that runs one task (a solve, an interpretation
// step, or a cross-check) to the end whether or not anyone is still
// listening, and keeps the answer so the browser can come back for it.
//
// Why: on a phone, putting the browser in the background makes the OS cut
// the page's connections. In a plain Worker the task dies with the client
// (Cloudflare cancels a request ~30 s after its client goes away). A Durable
// Object can stay alive while its own outbound fetch is in flight, so the
// model call finishes, the result is stored, and the
// page re-attaches with GET /api/jobs/:id when it comes back.
//
// What is stored, and for how long: the task's final event only - the
// solution, reading or verdict as text, or the error message - plus its
// kind, provider, creation time and its question's fingerprint. The uploaded
// images are held in memory for the run and never written to this object's
// storage; since 19 October 2026 the job writes them to R2 instead, once per
// question, for as long as the question's answers or PDFs are kept
// (worker/questions.ts). Everything here is deleted by an
// alarm JOB_RETENTION_MS after the job finishes (or, if it never does, after
// the longest possible run plus that). Whoever holds the job id - a random
// UUID the browser keeps in localStorage - can read the result until then.
// Muse and ChatGPT on OpenCode start from alarm(); pending input stays in memory.
// Its timeout is capped below the alarm handler's 15-minute wall limit.
//
// Each job also writes its row of the usage log (worker/usage.ts) when it
// starts, and completes it when the task ends - metadata only, in D1.

import { DurableObject } from "cloudflare:workers";
import { MAX_TIMEOUT_MS } from "../shared/stream-protocol";
import { resolveRoute, type WorkerEnv } from "./channels";
import {
  encodeEvent,
  encodeHeartbeat,
  runTask,
  SSE_HEADERS,
  taskTimeoutFor,
  type TaskEvent,
  type TaskOutcome,
  type TaskSink,
  type RunTaskParams,
} from "./run";
import { buildTask, isTaskKind } from "./tasks";
import { storeQuestionPages } from "./questions";
import { describeRequest, forwardedClient, logTaskEnd, logTaskStart } from "./usage";

/** How long a finished job's result is kept. */
export const JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

const TERMINAL_TYPES = new Set(["done", "error"]);

/** Statuses kept for a page that re-attaches; a run has a handful at most. */
const MAX_STATUSES = 40;

type Listener = WritableStreamDefaultWriter<Uint8Array>;

export class TaskJob extends DurableObject<WorkerEnv> {
  private jobId = "";
  private running = false;
  /**
   * Every `status` so far, each stamped with the time it happened, replayed
   * to a page that re-attaches mid-run: it shows the whole story - each retry,
   * each model switch - not just the latest line. Held in memory only; what
   * is stored is still the final event alone.
   */
  private statuses: TaskEvent[] = [];
  private terminal: TaskEvent | null = null;
  private startedAt = 0;
  private deadlineAt = 0;
  private expiresAt = 0;
  /** Request data stays in memory, including while awaiting alarm dispatch. */
  private pending: RunTaskParams | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly cancelled = new AbortController();
  /** This job's row in the usage log, and what to fill in if it ends before running. */
  private usageRow: Promise<number | null> | null = null;
  private usageBase: Omit<TaskOutcome, "outcome" | "modelCalls"> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/run") {
      return this.start(request, url, await request.text());
    }
    if (request.method === "GET" && url.pathname === "/attach") {
      return this.attach();
    }
    if (request.method === "GET" && url.pathname === "/result") {
      return this.result();
    }
    if (request.method === "DELETE" && url.pathname === "/cancel") {
      // Stop pressed in the page. The run ends with an "error: Cancelled."
      // event like any other failure, and that is what gets stored.
      if (this.running) {
        this.cancelled.abort();
        if (this.pending) {
          this.pending = null;
          await this.failBeforeStart("Cancelled.");
        }
      }
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  /** Dispatch once, then reuse the single alarm for retention cleanup. */
  async alarm() {
    if (this.pending) {
      const params = this.pending;
      // Consume before any await: alarm redelivery must not start a second call.
      this.pending = null;
      try {
        await this.ctx.storage.setAlarm(this.expiresAt);
        await this.logEnd(await runTask(this.hub(), params));
      } catch {
        await this.failBeforeStart("The background task could not start. Please try again.");
      }
      return;
    }

    // A late dispatch/redelivery must not erase a running task or its answer.
    // After an object reset there is no request body to replay: attach returns
    // the existing job-lost response, and this alarm only cleans up metadata.
    const expiresAt = this.expiresAt || await this.ctx.storage.get<number>("expiresAt");
    if (expiresAt && Date.now() < expiresAt) {
      await this.ctx.storage.setAlarm(this.expiresAt || expiresAt);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.jobId = "";
    this.statuses = [];
    this.terminal = null;
    this.running = false;
    this.expiresAt = 0;
  }

  private async failBeforeStart(message: string) {
    const sink = this.hub();
    await sink.event({ type: "error", message });
    await sink.close();
    if (this.usageBase) {
      await this.logEnd({
        ...this.usageBase,
        outcome: message === "Cancelled." ? "cancelled" : "error",
        modelCalls: 0,
        error: message,
      });
    }
  }

  /** Completes this job's usage-log row, once. */
  private async logEnd(outcome: TaskOutcome) {
    const row = this.usageRow;
    if (!row) return;
    this.usageRow = null;
    await logTaskEnd(this.env, await row, this.startedAt, outcome);
  }

  private async start(request: Request, url: URL, rawBody: string): Promise<Response> {
    const jobId = url.searchParams.get("jobId") ?? "";
    const kind = url.searchParams.get("kind") ?? "";
    const provider = url.searchParams.get("provider") ?? "";
    if (!jobId || !isTaskKind(kind)) {
      return Response.json({ error: "Malformed job request." }, { status: 400 });
    }
    if (this.running || this.terminal || (await this.ctx.storage.get("jobId"))) {
      return Response.json({ error: "This job has already started." }, { status: 409 });
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Request body must be JSON." }, { status: 400 });
    }
    const built = buildTask(kind, provider, body, this.env);
    if ("error" in built) return Response.json({ error: built.error }, { status: built.status });

    this.jobId = jobId;
    this.running = true;
    this.startedAt = Date.now();
    this.deadlineAt = this.startedAt + taskTimeoutFor(built.params);
    this.expiresAt = this.startedAt + MAX_TIMEOUT_MS + JOB_RETENTION_MS;
    const params = { ...built.params, signal: this.cancelled.signal, deadlineAt: this.deadlineAt };
    const route = resolveRoute(params.provider, this.env, params.routeOverride);
    if (route.startInAlarm) this.pending = params;
    // Not awaited: the log never holds up the task.
    this.usageBase = { model: route.model, channel: route.channel, effort: params.effort };
    const startedAt = this.startedAt;
    const described = describeRequest(kind, provider, body);
    // The question's pages and lecture notes, kept in R2 while its answers
    // or PDFs are (worker/questions.ts) - not in this object's storage,
    // which keeps only the question's fingerprint, for its PDF to keep them.
    const task = params.task;
    void described
      .then(async ({ question }) => {
        if (!question) return;
        await this.ctx.storage.put("question", question);
        await storeQuestionPages(this.env, question, task.images, task.referenceImages ?? []);
      })
      .catch(() => {});
    this.usageRow = described.then((described) =>
      logTaskStart(this.env, {
        startedAt,
        client: forwardedClient(request),
        jobId,
        request: described,
        model: route.model,
        channel: route.channel,
      }),
    ).catch(() => null);
    await this.ctx.storage.put({
      jobId,
      kind,
      provider,
      createdAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      expiresAt: this.expiresAt,
    });
    // The safety net: a job that never finishes is still deleted, one
    // retention period after the longest run it could have had.
    await this.ctx.storage.setAlarm(this.expiresAt);

    const response = await this.attach();
    if (route.startInAlarm) {
      try {
        await this.ctx.storage.setAlarm(Date.now());
      } catch {
        this.pending = null;
        await this.failBeforeStart("The background task could not be scheduled. Please try again.");
      }
    } else {
      // Not awaited: the task outlives this request and whoever sent it.
      void runTask(this.hub(), params).then((outcome) => this.logEnd(outcome));
    }
    return response;
  }

  /**
   * The stored final event, and when the alarm will delete it - for
   * GET /api/pdf/:id, which prints it (worker/pdf.ts). 404 until the job has
   * finished, and after it has been deleted.
   */
  private async result(): Promise<Response> {
    const terminal = this.terminal ?? (await this.ctx.storage.get<TaskEvent>("terminal")) ?? null;
    if (!terminal) {
      return Response.json(
        { error: "This result is no longer available - results are kept for 24 hours." },
        { status: 404 },
      );
    }
    const expiresAt = (await this.ctx.storage.getAlarm()) ?? Date.now() + JOB_RETENTION_MS;
    // Its question's fingerprint: a PDF made of this answer keeps the pages.
    const question = (await this.ctx.storage.get<string>("question")) ?? null;
    return Response.json({ terminal, expiresAt, question });
  }

  /**
   * An SSE stream of this job: the `job` event carrying its id and timing,
   * then either the stored result, or every status so far followed by
   * everything live.
   */
  private async attach(): Promise<Response> {
    const jobId = this.jobId || (await this.ctx.storage.get<string>("jobId")) || "";
    const terminal = this.terminal ?? (await this.ctx.storage.get<TaskEvent>("terminal")) ?? null;
    const startedAt = this.startedAt || (await this.ctx.storage.get<number>("createdAt")) || 0;
    const deadlineAt = this.deadlineAt || (await this.ctx.storage.get<number>("deadlineAt")) || 0;
    if (!jobId) {
      return Response.json(
        { error: "This result is no longer available - results are kept for 24 hours." },
        { status: 404 },
      );
    }
    if (!terminal && !this.running) {
      // Started, never finished, and not running now: the object was reset
      // mid-run. The page falls back to asking again.
      return Response.json({ error: "The server lost this job before it finished." }, { status: 404 });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const job: TaskEvent = { type: "job", id: jobId, now: Date.now() };
    if (startedAt) job.startedAt = startedAt;
    if (deadlineAt) job.deadlineAt = deadlineAt;
    void writer.write(encodeEvent(job)).catch(() => {});
    if (terminal) {
      void writer.write(encodeEvent(terminal)).catch(() => {});
      void writer.close().catch(() => {});
    } else {
      for (const status of this.statuses) void writer.write(encodeEvent(status)).catch(() => {});
      this.listeners.add(writer);
    }
    return new Response(readable, { headers: SSE_HEADERS });
  }

  /**
   * The sink runTask writes to. It never rejects - a listener that went away
   * is dropped, not propagated - which is what lets the task outlive the
   * page that started it.
   */
  private hub(): TaskSink {
    return {
      event: async (unstamped) => {
        // When it happened, on the server's clock: the page places replayed
        // statuses by it, and shows how long the task took.
        const event =
          unstamped.type === "delta" ? unstamped : { ...unstamped, at: Date.now() };
        if (event.type === "status" && this.statuses.length < MAX_STATUSES) {
          this.statuses.push(event);
        }
        if (TERMINAL_TYPES.has(event.type)) {
          if (this.terminal) return;
          this.terminal = event;
          this.running = false;
          this.pending = null;
          this.expiresAt = Date.now() + JOB_RETENTION_MS;
          try {
            await this.ctx.storage.put({ terminal: event, expiresAt: this.expiresAt });
            await this.ctx.storage.setAlarm(this.expiresAt);
          } catch {
            // Still delivered live below; only a later re-attach would miss it.
          }
        }
        this.broadcast(encodeEvent(event));
      },
      heartbeat: () => this.broadcast(encodeHeartbeat()),
      close: async () => {
        this.running = false;
        for (const listener of this.listeners) void listener.close().catch(() => {});
        this.listeners.clear();
      },
    };
  }

  private broadcast(chunk: Uint8Array) {
    for (const listener of this.listeners) {
      listener.write(chunk).catch(() => {
        this.listeners.delete(listener);
      });
    }
  }
}
