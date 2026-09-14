// Per-provider solve state machine over the app-level SSE protocol.
// Fires one streaming POST per selected provider; each tab progresses
// independently (spinner -> live progress -> rendered solution).

import { useCallback, useRef, useState } from "react";
import { PROVIDER_KEYS, type ProviderKey } from "../../shared/providers";
import type { ProviderArtifact } from "../../shared/solution";
import type { SolveRequestBody } from "../../shared/stream-protocol";
import { fetchSseStream, readSseEvents } from "@/lib/sse";

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

    // A stream that ends with no `done` and no `error` was almost certainly
    // killed for exceeding the free plan's CPU budget while its siblings ran
    // (the isolate is terminated, so the Worker cannot even send an error).
    // Firing all providers again would just recreate the overload, so instead
    // the killed ones queue and retry ONE AT A TIME, and only after the whole
    // first wave has settled and the budget has refilled.
    let active = providers.length;
    const retryQueue: Array<() => Promise<void>> = [];
    let draining = false;

    const drainRetries = async () => {
      if (draining) return;
      draining = true;
      while (retryQueue.length > 0 && !abort.signal.aborted) {
        const job = retryQueue.shift();
        if (job) await job();
      }
      draining = false;
    };

    const onSettled = () => {
      active -= 1;
      if (active === 0) void drainRetries();
    };

    for (const provider of providers) {
      void (async () => {
        const outcome = await streamProvider(provider, body, abort.signal, update);
        if (outcome === "interrupted" && !abort.signal.aborted) {
          // Leave a settled, honest state until the retry actually starts,
          // rather than a frozen progress count.
          update(provider, {
            status: "waiting",
            message: "Interrupted by server load — will retry shortly.",
          });
          retryQueue.push(async () => {
            if (abort.signal.aborted) return;
            update(provider, {
              status: "waiting",
              message: "Interrupted by server load — retrying...",
            });
            const retry = await streamProvider(provider, body, abort.signal, update);
            if (retry === "interrupted" && !abort.signal.aborted) {
              update(provider, {
                status: "error",
                message:
                  "The server ran out of capacity for this provider. Try again, or run fewer providers at once.",
              });
            }
          });
        }
        onSettled();
      })();
    }
  }, []);

  return { runs, start, cancel };
}

/** How one attempt ended, so the caller can decide whether to retry. */
type StreamOutcome = "done" | "error" | "interrupted" | "aborted";

async function streamProvider(
  provider: ProviderKey,
  body: SolveRequestBody,
  signal: AbortSignal,
  update: (provider: ProviderKey, run: ProviderRun) => void,
): Promise<StreamOutcome> {
  let charsReceived = 0;

  try {
    const stream = await fetchSseStream(`/api/solve/${provider}`, body, signal);
    let outcome: StreamOutcome | null = null;

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
      } else if (
        event.name === "done" &&
        payload.solution &&
        typeof payload.solution === "object"
      ) {
        outcome = "done";
        update(provider, {
          status: "done",
          solution: payload.solution as ProviderArtifact,
        });
      } else if (event.name === "error" && typeof payload.message === "string") {
        outcome = "error";
        update(provider, { status: "error", message: payload.message });
      }
    }

    // No terminal event: the stream closed mid-flight. The caller may retry;
    // it owns the final state so a retry is not preceded by a flash of error.
    return outcome ?? "interrupted";
  } catch (error) {
    if (signal.aborted) return "aborted";
    update(provider, {
      status: "error",
      message: error instanceof Error ? error.message : "The solve request failed.",
    });
    return "error";
  }
}
