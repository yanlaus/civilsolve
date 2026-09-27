// The thinking levels one model's route offers, from /api/health: a route
// may pin its level (forcedEffort), put a floor under it (minEffort - ChatGPT
// runs at high or max) or a ceiling over it (maxEffort). A picker disables
// the levels outside the band, and a pick outside it moves to the nearest
// edge rather than being silently raised by the server.

import { EFFORT_KEYS, type EffortKey } from "../../shared/prompt";
import type { ProviderStatus } from "../../shared/providers";

export function effortBand(status?: ProviderStatus) {
  const floor = status?.forcedEffort ?? status?.minEffort;
  const ceiling = status?.forcedEffort ?? status?.maxEffort;
  const floorIndex = floor ? Math.max(0, EFFORT_KEYS.indexOf(floor as EffortKey)) : 0;
  const ceilingIndex = ceiling
    ? EFFORT_KEYS.indexOf(ceiling as EffortKey)
    : EFFORT_KEYS.length - 1;
  const top = ceilingIndex < 0 ? EFFORT_KEYS.length - 1 : ceilingIndex;
  const inBand = (key: EffortKey) => {
    const index = EFFORT_KEYS.indexOf(key);
    return index >= floorIndex && index <= top;
  };
  const clamp = (pick: EffortKey): EffortKey =>
    inBand(pick) ? pick : EFFORT_KEYS[Math.min(Math.max(EFFORT_KEYS.indexOf(pick), floorIndex), top)];
  return { inBand, clamp };
}
