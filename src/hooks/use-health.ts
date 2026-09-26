// Which providers the server can reach (GET /api/health), fetched once for
// the whole page: the upload form uses it for the solver cards and effort
// band, the solution panel for the providers it offers to add or to judge.
// Advisory only - if the probe fails the page still works and the Worker
// reports the real error per request - except that a refused sign-in is
// worth saying at once, before anyone uploads anything.

import { useEffect, useState } from "react";
import type { HealthResponse, ProviderKey, ProviderStatus } from "../../shared/providers";

export type ProviderStatusMap = Record<ProviderKey, ProviderStatus>;

export function useHealth() {
  const [providerStatus, setProviderStatus] = useState<ProviderStatusMap | null>(null);
  /** Set when the server refused the page's sign-in (Cloudflare Access). */
  const [signInError, setSignInError] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then(async (response) => {
        if (response.status === 401 || response.status === 503) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          if (!cancelled && payload?.error) setSignInError(payload.error);
          return null;
        }
        return response.ok ? ((await response.json()) as HealthResponse) : null;
      })
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

  return { providerStatus, signInError };
}
