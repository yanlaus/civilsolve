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

  const start = useCallback(
    (providers: ProviderKey[], body: SolveRequestBody) => {
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

      void (async () => {
        // Providers run one at a time. On the free plan every provider is a
        // per-token stream that draws CPU for its whole duration, so anything
        // above one at a time can drain the budget and get a stream killed.
        const interrupted: ProviderKey[] = [];
        await runPool(providers, 1, async (provider) => {
          const outcome = await streamProvider(provider, body, abort.signal, update);
          if (outcome === "interrupted" && !abort.signal.aborted) {
            // A stream that closed with no `done` and no `error` was almost
            // certainly a CPU kill (the isolate is gone, so the Worker cannot
            // send an error). Leave an honest waiting state and retry later.
            update(provider, {
              status: "waiting",
              message: "Interrupted by server load — will retry shortly.",
            });
            interrupted.push(provider);
          }
        });

        // Retries run strictly one at a time, on a budget the finished wave
        // has let refill, so they never recreate the overload.
        await runPool(interrupted, 1, async (provider) => {
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
                "The server ran out of capacity for this provider. Try again, or run fewer at once.",
            });
          }
        });
      })();
    },
    [],
  );

  return { runs, start, cancel };
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight at once.
 * Resolves when every item has been processed.
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: lanes }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
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
