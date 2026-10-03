// How a run is set up, in one choice (3 October 2026): a student picks
// "Careful" or "Quick" and the form fills in the solvers, the thinking
// level, the reading check and the cross-check; "Custom" is the full form,
// as it was before. Quick is the default (the owner's call, 3 October 2026 -
// Careful was for the first few hours): two calls, and the answer summary
// says whether its two answers agree; Careful is one tap away for a
// question where a misread diagram or a plausible wrong answer would cost.

import type { EffortKey } from "../../shared/prompt";
import { DEFAULT_SOLVERS, type ProviderKey } from "../../shared/providers";

export type SolveMode = "careful" | "quick" | "custom";

export type Preset = {
  /** The solvers, in picker order (each provider's default model). */
  providers: ProviderKey[];
  effort: EffortKey;
  /** Two readers and a reconciler check the reading before anyone solves. */
  verify: boolean;
  /** The default judge cross-checks the solutions once they are in. */
  autoCheck: boolean;
};

export const PRESETS: Record<Exclude<SolveMode, "custom">, Preset> = {
  // The owner's default solvers, the reading checked by the default readers
  // and reconciler, and ChatGPT judging at high: the most reliable set-up
  // measured (AGENTS.md).
  careful: { providers: DEFAULT_SOLVERS, effort: "high", verify: true, autoCheck: true },
  // The two lightest draws on the OpenCode Go subscription, nothing else.
  quick: { providers: ["muse", "deepseek"], effort: "high", verify: false, autoCheck: false },
};

export const MODES: Array<{ key: SolveMode; title: string; chinese: string; blurb: string }> = [
  {
    key: "careful",
    title: "Careful",
    chinese: "穩陣",
    blurb: "Checks the reading of the question, solves with three models, then a judge cross-checks the answers. Slowest, most reliable.",
  },
  {
    key: "quick",
    title: "Quick",
    chinese: "快速",
    blurb: "Two models solve straight away. Fastest and lightest on credit - compare their answers yourself.",
  },
  {
    key: "custom",
    title: "Custom",
    chinese: "自訂",
    blurb: "Pick the models, the thinking level, the reading check and the cross-check yourself.",
  },
];

const MODE_KEY = "civilsolve:mode";

export function loadMode(): SolveMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    return saved === "quick" || saved === "custom" || saved === "careful" ? saved : "quick";
  } catch {
    return "quick";
  }
}

export function saveMode(mode: SolveMode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Only the preference is lost.
  }
}
