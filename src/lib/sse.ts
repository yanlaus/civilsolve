// Minimal SSE parser over a fetch body. EventSource cannot POST, so streams
// are read manually; comment lines (heartbeats) are ignored.

export type SseEvent = { name: string; data: string };

/**
 * How long a stream may go without a single byte before it is treated as
 * lost. The server sends a heartbeat every 15 s, so this is three missed in a
 * row. It catches the connection a phone drops without telling the page -
 * a switch between Wi-Fi and mobile data, a tunnel - where the read would
 * otherwise wait forever and the tab spin with nothing coming. withResume
 * then re-attaches to the same job.
 */
export const STREAM_IDLE_MS = 45_000;

/** One read, or a StreamInterruptedError once `idleMs` passes without data. */
function readOrStall(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reader.cancel().catch(() => {});
      reject(new StreamInterruptedError(`No data from the server for ${idleMs / 1000} s.`));
    }, idleMs);
  });
  return Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
}

export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  idleMs = STREAM_IDLE_MS,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (!dataLines.length) {
      eventName = "";
      return null;
    }
    const event = { name: eventName || "message", data: dataLines.join("\n") };
    eventName = "";
    dataLines = [];
    return event;
  };

  try {
    while (true) {
      const { done, value } = await readOrStall(reader, idleMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (line === "") {
          const event = flush();
          if (event) yield event;
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        // lines starting with ":" are heartbeat comments — ignored
      }
    }
    const event = flush();
    if (event) yield event;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A stalled read may still be settling; the stream is abandoned anyway.
    }
  }
}

/**
 * A stream that ended without its terminal event: the connection went away
 * before the server finished, so the request is worth making again.
 */
export class StreamInterruptedError extends Error {}

/**
 * The server no longer has the job a page tried to re-attach to - the
 * object running it was reset mid-run. The only way on is to ask again from
 * scratch, which runs the model again, so withResume does that at most
 * MAX_RESTARTS times.
 */
export class JobLostError extends Error {}

// How each engine words a request whose connection went away: Safari "Load
// failed" / "The network connection was lost.", Chrome "Failed to fetch" /
// "network error", Firefox "NetworkError when attempting to fetch resource.",
// Node "fetch failed".
const CONNECTION_LOST =
  /load failed|failed to fetch|network ?error|network connection was lost|internet connection appears to be offline|fetch failed/i;

/**
 * True when a fetch or a stream read failed because the connection dropped,
 * not because the server answered with an error. On a phone this is what
 * backgrounding the browser does: iOS suspends the tab and cuts its sockets,
 * and the read throws "Load failed" when the page comes back.
 */
export function isConnectionLost(error: unknown): boolean {
  return (
    error instanceof StreamInterruptedError ||
    (error instanceof TypeError && CONNECTION_LOST.test(error.message))
  );
}

/** Resolves once the page is visible (at once if it already is) or `signal` aborts. */
export function whenVisible(signal: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      document.removeEventListener("visibilitychange", onChange);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const onChange = () => {
      if (document.visibilityState === "visible") finish();
    };
    document.addEventListener("visibilitychange", onChange);
    signal.addEventListener("abort", finish);
  });
}

/** Resolves once the browser reports a network (at once if it does) or `signal` aborts. */
function whenOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.removeEventListener("online", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    window.addEventListener("online", finish);
    signal.addEventListener("abort", finish);
  });
}

/** Waits `ms`, or less if `signal` aborts first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

/**
 * How long withResume keeps reconnecting before it gives up: two minutes of
 * failed attempts in a row. The clock starts over whenever a reconnection
 * gets through, and stops while the page is hidden or the browser is
 * offline, so a long solve survives any number of short outages.
 *
 * It used to be two attempts 1.5 s apart, and that gave up inside three
 * seconds: an iPhone switching between Wi-Fi and mobile data, or waking its
 * screen, takes longer than that to get its network back, so a user who
 * never left the page saw "the connection kept dropping" while the job was
 * running fine on the server (reproduced on production, 25 September 2026).
 */
export const RECONNECT_WINDOW_MS = 120_000;

/** The wait before the first reconnection; it doubles each time, up to the max. */
const FIRST_RECONNECT_DELAY_MS = 1_500;
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * How many times a task is asked for again from scratch because the server
 * lost its job (JobLostError). Each one runs the model again, so once.
 */
export const MAX_RESTARTS = 1;

/**
 * Runs `attempt` again after its connection dropped. The attempts in this
 * app open their stream with openTaskStream, so "again" means re-attaching
 * to the same server-side job - the model call kept running meanwhile -
 * which costs nothing, so it keeps trying until RECONNECT_WINDOW_MS passes
 * without one getting through (`handle.connections` counts the ones that
 * did). It waits for the page to be visible (a hidden tab would just lose
 * the new connection too) and for the browser to be online before each try,
 * and reports what it is doing through `onRestart`. Starting over, when the
 * server no longer has the job, happens at most MAX_RESTARTS times. Any
 * other failure is rethrown untouched.
 */
export async function withResume<T>(
  attempt: () => Promise<T>,
  handle: JobHandle,
  signal: AbortSignal,
  onRestart: (message: string) => void,
): Promise<T> {
  let restarts = 0;
  let failures = 0;
  let outageStartedAt = 0;
  let delay = FIRST_RECONNECT_DELAY_MS;

  for (;;) {
    const connectionsBefore = handle.connections;
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof JobLostError) {
        if (restarts >= MAX_RESTARTS) throw error;
        restarts += 1;
      } else if (!isConnectionLost(error)) {
        throw error;
      }

      if (failures === 0 || handle.connections !== connectionsBefore) {
        // The first drop, or this attempt got through before dropping: a new
        // outage starts now.
        failures = 0;
        outageStartedAt = Date.now();
        delay = FIRST_RECONNECT_DELAY_MS;
      } else if (Date.now() - outageStartedAt >= RECONNECT_WINDOW_MS) {
        throw error;
      }
      failures += 1;

      let waited = false;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        onRestart("Connection lost while this page was in the background. Reconnecting when you return...");
        await whenVisible(signal);
        waited = true;
      }
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        onRestart("This device is offline. Reconnecting when the network is back...");
        await whenOnline(signal);
        waited = true;
      }
      if (signal.aborted) throw error;
      if (waited) {
        // Time spent away or offline is not time spent failing to reconnect.
        outageStartedAt = Date.now();
        delay = FIRST_RECONNECT_DELAY_MS;
      }

      onRestart(
        failures === 1 ? "Connection lost. Reconnecting..." : `Connection lost. Reconnecting (attempt ${failures})...`,
      );
      await pause(delay, signal);
      if (signal.aborted) throw error;
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }
}

/**
 * POSTs JSON to an SSE endpoint and validates the response is a stream.
 * Throws with the server's error message otherwise.
 */
export async function fetchSseStream(
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return streamOf(response);
}

/** The response's event stream, or an Error carrying the server's message. */
async function streamOf(response: Response): Promise<ReadableStream<Uint8Array>> {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    throw new Error(await errorMessage(response));
  }

  if (!response.body) {
    throw new Error("The server returned no stream.");
  }

  return response.body;
}

async function errorMessage(response: Response) {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    if (text.trim().startsWith("<")) {
      return "The server returned an HTML page instead of a stream.";
    }
  }
  return `The request failed (HTTP ${response.status}).`;
}

/**
 * A task's run on the server. Every task runs in a job of its own that
 * outlives the page (worker/jobs.ts); the stream opens with a `job` event
 * naming it. Knowing the id, a dropped connection re-attaches to the same
 * run instead of starting it over, and Stop can cancel it. `connections`
 * counts the streams that reached the page (each opens with that event),
 * which is how withResume tells a reconnection that got through from one
 * that did not. `timing` is what the job said about when it started,
 * on the server's clock, with `clockOffset` (this page's clock minus the
 * server's) to convert them.
 */
export type JobHandle = {
  id: string | null;
  connections: number;
  timing?: { startedAt?: number; clockOffset: number };
};

export function jobHandle(id: string | null = null): JobHandle {
  return { id, connections: 0 };
}

/**
 * Records the id from a stream's `job` event. Returns true when `event` was
 * that event, so the caller can skip it.
 */
export function takeJobEvent(
  handle: JobHandle,
  event: SseEvent,
  onJob?: (id: string) => void,
): boolean {
  if (event.name !== "job") return false;
  handle.connections += 1;
  try {
    const { id, startedAt, now } = JSON.parse(event.data) as Record<string, unknown>;
    if (typeof now === "number") {
      handle.timing = {
        clockOffset: Date.now() - now,
        ...(typeof startedAt === "number" ? { startedAt } : {}),
      };
    }
    if (typeof id === "string" && id) {
      handle.id = id;
      onJob?.(id);
    }
  } catch {
    // A malformed job event only costs the ability to re-attach.
  }
  return true;
}

/**
 * Opens a task's event stream: re-attaches to its job when the handle has
 * one, otherwise sends the request. `body` is null when there is nothing to
 * send - a run restored after the page reloaded - so only re-attaching works.
 *
 * A job the server no longer has (expired, or reset mid-run) clears the
 * handle. With a body that is a JobLostError, so withResume asks again from
 * scratch; without one it is the final answer.
 */
export async function openTaskStream(
  handle: JobHandle,
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  if (handle.id) {
    const response = await fetch(`/api/jobs/${handle.id}`, { signal });
    if (response.status === 404) {
      handle.id = null;
      const message = await errorMessage(response);
      if (body === null) throw new Error(message);
      throw new JobLostError(message);
    }
    return streamOf(response);
  }
  if (body === null) {
    throw new Error("This result is no longer available - results are kept for 24 hours.");
  }
  return fetchSseStream(url, body, signal);
}

/**
 * Stops a job's model call on the server. Fire-and-forget, and `keepalive`
 * so it still goes out when the page is being closed.
 */
export function cancelJob(handle: JobHandle) {
  if (!handle.id) return;
  void fetch(`/api/jobs/${handle.id}`, { method: "DELETE", keepalive: true }).catch(() => {});
}
