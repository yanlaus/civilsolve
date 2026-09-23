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
 * How many times one request is restarted after losing its connection. Two:
 * a user may leave the page more than once during a long solve.
 */
export const MAX_RESUMES = 2;

/**
 * Nothing is stored server side, so a request whose connection dropped
 * cannot be picked up again - only made again. This waits until the page is
 * visible (a hidden tab would just lose the new connection too), reports
 * the restart through `onRestart`, and runs `attempt` again, up to
 * MAX_RESUMES times. Any other failure is rethrown untouched.
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
        onRestart("Connection lost while this page was in the background. Restarting when you return...");
        await whenVisible(signal);
        if (signal.aborted) throw error;
      }
      onRestart("Connection lost. Restarting...");
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

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/event-stream")) {
    const text = await response.text();
    let message = `The request failed (HTTP ${response.status}).`;
    try {
      const payload = JSON.parse(text) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      if (text.trim().startsWith("<")) {
        message = "The server returned an HTML page instead of a stream.";
      }
    }
    throw new Error(message);
  }

  if (!response.body) {
    throw new Error("The server returned no stream.");
  }

  return response.body;
}
