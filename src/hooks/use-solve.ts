// Per-provider solve state machine over the app-level SSE protocol.
// Fires one streaming POST per selected provider; each tab progresses
// independently (spinner -> live progress -> rendered solution).

import { useCallback, useRef, useState } from "react";
import type { EffortKey } from "../../shared/prompt";
import { PROVIDER_KEYS, type ProviderKey } from "../../shared/providers";
import type { ProviderArtifact } from "../../shared/solution";
import type { SolveRequestBody } from "../../shared/stream-protocol";

export type ProviderRun =
  | { status: "idle" }
  | { status: "waiting"; message: string }
  | { status: "streaming"; charsReceived: number }
  | { status: "done"; solution: ProviderArtifact }
  | { status: "error"; message: string };

export type ProviderRuns = Record<ProviderKey, ProviderRun>;

const IDLE_RUNS = Object.fromEntries(
  PROVIDER_KEYS.map((key) => [key, { status: "idle" } as ProviderRun]),
) as ProviderRuns;

export function isRunActive(run: ProviderRun) {
  return run.status === "waiting" || run.status === "streaming";
}

export function useSolve() {
  const [runs, setRuns] = useState<ProviderRuns>(IDLE_RUNS);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRuns((current) => {
      const next = { ...current };
      for (const key of Object.keys(next) as ProviderKey[]) {
        if (isRunActive(next[key])) {
          next[key] = { status: "error", message: "Cancelled." };
        }
      }
      return next;
    });
  }, []);

  const start = useCallback(
    (providers: ProviderKey[], images: string[], notes: string, effort: EffortKey) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;

      setRuns(() => {
        const next: ProviderRuns = { ...IDLE_RUNS };
        for (const provider of providers) {
          next[provider] = { status: "waiting", message: "Submitting..." };
        }
        return next;
      });

      const update = (provider: ProviderKey, run: ProviderRun) => {
        setRuns((current) => ({ ...current, [provider]: run }));
      };

      const body: SolveRequestBody = { images, notes, effort };

      for (const provider of providers) {
        void streamProvider(provider, body, abort.signal, update);
      }
    },
    [],
  );

  return { runs, start, cancel };
}

async function streamProvider(
  provider: ProviderKey,
  body: SolveRequestBody,
  signal: AbortSignal,
  update: (provider: ProviderKey, run: ProviderRun) => void,
) {
  let charsReceived = 0;

  try {
    const response = await fetch(`/api/solve/${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const text = await response.text();
      let message = `The solve request failed (HTTP ${response.status}).`;
      try {
        const payload = JSON.parse(text) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        if (text.trim().startsWith("<")) {
          message = "The server returned an HTML page instead of a solution stream.";
        }
      }
      update(provider, { status: "error", message });
      return;
    }

    if (!response.body) {
      update(provider, { status: "error", message: "The server returned no stream." });
      return;
    }

    let finished = false;

    for await (const event of readSseEvents(response.body)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (event.name === "status" && typeof payload.message === "string") {
        if (charsReceived === 0) {
          update(provider, { status: "waiting", message: payload.message });
        }
      } else if (event.name === "delta" && typeof payload.text === "string") {
        charsReceived += payload.text.length;
        update(provider, { status: "streaming", charsReceived });
      } else if (event.name === "done" && payload.solution && typeof payload.solution === "object") {
        finished = true;
        update(provider, {
          status: "done",
          solution: payload.solution as ProviderArtifact,
        });
      } else if (event.name === "error" && typeof payload.message === "string") {
        finished = true;
        update(provider, { status: "error", message: payload.message });
      }
    }

    if (!finished) {
      update(provider, {
        status: "error",
        message: "The solution stream ended unexpectedly. Please try again.",
      });
    }
  } catch (error) {
    if (signal.aborted) return;
    update(provider, {
      status: "error",
      message: error instanceof Error ? error.message : "The solve request failed.",
    });
  }
}

type SseEvent = { name: string; data: string };

/**
 * Minimal SSE parser over a fetch body. EventSource cannot POST, so the
 * stream is read manually; comment lines (heartbeats) are ignored.
 */
async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
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
