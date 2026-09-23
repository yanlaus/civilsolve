// Minimal SSE parser over a fetch body. EventSource cannot POST, so streams
// are read manually; comment lines (heartbeats) are ignored.

export type SseEvent = { name: string; data: string };

export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
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
      const { done, value } = await reader.read();
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
    reader.releaseLock();
  }
}

/**
 * A stream that ended without its terminal event: the connection went away
 * before the server finished, so the request is worth making again.
 */
export class StreamInterruptedError extends Error {}

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

/**
 * How many times one request reconnects after losing its connection. Two:
 * a user may leave the page more than once during a long solve.
 */
export const MAX_RESUMES = 2;

/**
 * Runs `attempt` again after its connection dropped, up to MAX_RESUMES
 * times. It first waits until the page is visible (a hidden tab would just
 * lose the new connection too) and reports that through `onRestart`. The
 * attempts in this app open their stream with openTaskStream, so "again"
 * means re-attaching to the same server-side job - the model call kept
 * running meanwhile - and only means starting over when the server no
 * longer has that job. Any other failure is rethrown untouched.
 */
export async function withResume<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal,
  onRestart: (message: string) => void,
): Promise<T> {
  for (let resumes = 0; ; resumes += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (signal.aborted || !isConnectionLost(error) || resumes >= MAX_RESUMES) throw error;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        onRestart("Connection lost while this page was in the background. Reconnecting when you return...");
        await whenVisible(signal);
        if (signal.aborted) throw error;
      }
      onRestart("Connection lost. Reconnecting...");
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
 * run instead of starting it over, and Stop can cancel it.
 */
export type JobHandle = { id: string | null };

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
  try {
    const { id } = JSON.parse(event.data) as { id?: unknown };
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
 * handle. With a body that is a StreamInterruptedError, so withResume asks
 * again from scratch; without one it is the final answer.
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
      throw new StreamInterruptedError(message);
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
