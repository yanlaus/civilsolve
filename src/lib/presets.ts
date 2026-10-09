// How a run is set up, in one choice (3 October 2026): a student picks
// "Careful" or "Quick" and the form fills in the solvers, the thinking
// level, the reading check and the cross-check; "Custom" is the full form,
// as it was before. Quick is the default (the owner's call, 3 October 2026 -
// Careful was for the first few hours): two calls, and the answer summary
// says whether its two answers agree; Careful is one tap away for a
// question where a misread diagram or a plausible wrong answer would cost.
// The page opens on Quick every time (the owner, 4 October 2026): the mode
// picked last is not remembered - it was, and a student who once picked
// Careful kept getting it.

import type { EffortKey } from "../../shared/prompt";
import { DEFAULT_SOLVERS, type ProviderKey } from "../../shared/providers";

export type SolveMode = "careful" | "quick" | "custom";

export type Preset = {
  /** The solvers, in picker order (each provider's default model). */
  providers: ProviderKey[];
  effort: EffortKey;
  /** Two readers and a reconciler check the reading before anyone solves. */
  verify: boolean;
  /**
   * The default judge cross-checks the solutions once they are in. Off in
   * both presets since 3 October 2026 (the owner's call): the cross-check
   * runs once, when the student taps it - before the answers are in too.
   */
  autoCheck: boolean;
};

export const PRESETS: Record<Exclude<SolveMode, "custom">, Preset> = {
  // The owner's default solvers, the reading checked by the default readers
  // and reconciler first; the cross-check (ChatGPT at high, the most
  // reliable judge measured - AGENTS.md) when the student asks for it.
  careful: { providers: DEFAULT_SOLVERS, effort: "high", verify: true, autoCheck: false },
  // Three solvers and nothing else: Claude Haiku and DeepSeek on the OpenCode
  // Go subscription, and Gemini (3.8 Flash) since 4 October 2026 (the
  // owner's call - a billed Flash call on the Vertex AI prepaid credit).
  // Claude Haiku replaced Muse Spark on 10 October 2026, as in
  // DEFAULT_SOLVERS.
  quick: { providers: ["haiku", "deepseek", "gemini"], effort: "high", verify: false, autoCheck: false },
};

export const MODES: Array<{ key: SolveMode; title: string; chinese: string; blurb: string }> = [
  {
    key: "careful",
    title: "Careful",
    chinese: "穩陣",
    blurb: "Checks the reading of the question first, then three models solve. Tap Cross-check to have a judge grade the answers.",
  },
  {
    key: "quick",
    title: "Quick",
    chinese: "快速",
    blurb: "Three models solve straight away, without checking the reading first. Fastest - compare their answers, or tap Cross-check.",
  },
  {
    key: "custom",
    title: "Custom",
    chinese: "自訂",
    blurb: "Pick the models, the thinking level, the reading check and the cross-check yourself.",
  },
];

/** The mode the page opens on, every time. */
export const DEFAULT_MODE: SolveMode = "quick";

/** The mode the page remembered until 4 October 2026, cleared from the browser. */
export function forgetSavedMode() {
  try {
    window.localStorage.removeItem("civilsolve:mode");
  } catch {
    // Nothing to clear.
  }
}
