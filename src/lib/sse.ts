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
