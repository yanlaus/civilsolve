// Per-provider solve state machine over the app-level SSE protocol.
// Fires one streaming POST per selected provider; each tab progresses
// independently (spinner -> live progress -> rendered solution).

import { useCallback, useRef, useState } from "react";
import type { ProviderArtifact, ProviderKey } from "../../shared/solution";
import type { SolveRequestBody } from "../../shared/stream-protocol";
import { fetchSseStream, readSseEvents } from "@/lib/sse";

export type ProviderRun =
  | { status: "idle" }
  | { status: "waiting"; message: string }
  | { status: "streaming"; charsReceived: number }
  | { status: "done"; solution: ProviderArtifact }
  | { status: "error"; message: string };

export type ProviderRuns = Record<ProviderKey, ProviderRun>;

const IDLE_RUNS: ProviderRuns = {
  kimi: { status: "idle" },
  codex: { status: "idle" },
  claude: { status: "idle" },
  gemini: { status: "idle" },
};

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

  const start = useCallback((providers: ProviderKey[], body: SolveRequestBody) => {
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

    for (const provider of providers) {
      void streamProvider(provider, body, abort.signal, update);
    }
  }, []);

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
    const stream = await fetchSseStream(`/api/solve/${provider}`, body, signal);

    let finished = false;

    for await (const event of readSseEvents(stream)) {
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
