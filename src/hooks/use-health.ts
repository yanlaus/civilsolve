// Which providers the server can reach (GET /api/health), fetched once for
// the whole page: the upload form uses it for the solver cards and effort
// band, the solution panel for the providers it offers to add or to judge.
// Advisory only - if the probe fails the page still works and the Worker
// reports the real error per request.

import { useEffect, useState } from "react";
import type { HealthResponse, ProviderKey, ProviderStatus } from "../../shared/providers";

export type ProviderStatusMap = Record<ProviderKey, ProviderStatus>;

export function useHealth() {
  const [providerStatus, setProviderStatus] = useState<ProviderStatusMap | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((response) => (response.ok ? (response.json() as Promise<HealthResponse>) : null))
      .then((payload) => {
        if (!cancelled && payload?.providers) setProviderStatus(payload.providers);
      })
      .catch(() => {
        // Ignored on purpose - health is a hint, not a gate.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { providerStatus };
}
