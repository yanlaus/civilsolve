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
import { DEFAULT_SOLVERS, type ModelChoice, type ModelVariant, type ProviderKey } from "../../shared/providers";

export type SolveMode = "careful" | "quick" | "custom";

/**
 * Which models a preset runs (16 October 2026, the owner's request): Smart,
 * the default - the light, fast models it always ran - or Expert, each
 * brand's top model. Like the mode, not remembered: the page opens on Smart.
 */
export type Tier = "smart" | "expert";

export type Preset = {
  /** The solvers, in picker order. */
  providers: ProviderKey[];
  /** The model of each solver that offers several; each provider's first otherwise. */
  variants?: Partial<Record<ProviderKey, ModelVariant>>;
  effort: EffortKey;
  /** Two readers and a reconciler check the reading before anyone solves. */
  verify: boolean;
  /** The two readers and the reconciler; the defaults (DEFAULT_INTERPRETERS, DEFAULT_VERIFIER) when unset. */
  readers?: [ModelChoice, ModelChoice];
  reconciler?: ModelChoice;
  /**
   * The default judge cross-checks the solutions once they are in. Off in
   * both presets since 3 October 2026 (the owner's call): the cross-check
   * runs once, when the student taps it - before the answers are in too.
   */
  autoCheck: boolean;
  /** Who that tap sends the cross-check to; DEFAULT_JUDGE when unset. */
  judge?: ModelChoice;
};

/** Expert's judge (the owner's pick): it grades the answers, it does not write one. */
export const EXPERT_JUDGE: ModelChoice = { provider: "claude", variant: "opus" };

/**
 * Expert's solvers, the owner's picks of 16 October 2026: Kimi K3, Gemini 4
 * Argon and Grok 4.7, all three on the OpenCode Go subscription - and no GPT
 * anywhere in Expert. Each draws on a small monthly allowance of its own
 * (about 490, 1,060 and 845 requests), and Grok is slow (236 s on the pipe
 * bifurcation; once nothing for 280 s).
 */
const EXPERT_SOLVERS: Pick<Preset, "providers" | "variants" | "effort" | "autoCheck" | "judge"> = {
  providers: ["kimi", "gemini", "grok"],
  variants: { kimi: "k3", gemini: "argon" },
  effort: "high",
  autoCheck: false,
  judge: EXPERT_JUDGE,
};

export const PRESETS: Record<Exclude<SolveMode, "custom">, Record<Tier, Preset>> = {
  careful: {
    // The owner's default solvers, the reading checked by the default readers
    // and reconciler first; the cross-check (ChatGPT at high, the most
    // reliable judge measured - AGENTS.md) when the student asks for it.
    smart: { providers: DEFAULT_SOLVERS, effort: "high", verify: true, autoCheck: false },
    // Grok 4.7 and Gemini 4 Argon read, Kimi K3 reconciles.
    expert: {
      ...EXPERT_SOLVERS,
      verify: true,
      readers: [{ provider: "grok" }, { provider: "gemini", variant: "argon" }],
      reconciler: { provider: "kimi", variant: "k3" },
    },
  },
  quick: {
    // Three solvers and nothing else: Muse Spark and DeepSeek on the OpenCode
    // Go subscription, and Gemini (3.8 Flash) since 4 October 2026 (the
    // owner's call - a billed Flash call on the Vertex AI prepaid credit).
    smart: { providers: DEFAULT_SOLVERS, effort: "high", verify: false, autoCheck: false },
    expert: { ...EXPERT_SOLVERS, verify: false },
  },
};

export const TIERS: Array<{ key: Tier; title: string; chinese: string; blurb: string }> = [
  {
    key: "smart",
    title: "Smart",
    chinese: "精明",
    blurb: "Light, fast models - the usual choice.",
  },
  {
    key: "expert",
    title: "Expert",
    chinese: "專家",
    blurb: "Each brand's top model: Kimi K3, Gemini 4 Argon and Grok 4.7, and Claude Opus to cross-check. Slower, and uses much more credit.",
  },
];

/** The tier the page opens on, every time. */
export const DEFAULT_TIER: Tier = "smart";

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
