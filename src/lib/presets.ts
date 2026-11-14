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
import {
  DEFAULT_INTERPRETERS,
  DEFAULT_JUDGE,
  DEFAULT_SOLVERS,
  DEFAULT_VERIFIER,
  FLAGSHIP_PROVIDERS,
  type ModelChoice,
  type ModelVariant,
  type ProviderKey,
} from "../../shared/providers";

export type SolveMode = "careful" | "quick" | "custom";

/**
 * Which models a preset runs (16 October 2026, the owner's request): Smart,
 * the default - light, fast models - Expert, each brand's top model, since
 * 17 October 2026 China, cheap China models on the OpenCode Go plan, and
 * since 11 November 2026 Flagship, OpenAI's and Anthropic's flagships on
 * their own APIs. Like the mode, not remembered: the page opens on Smart.
 */
export type Tier = "smart" | "expert" | "china" | "flagship";

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
   * The judge cross-checks the solutions once they are all in. On in Careful
   * since 16 October 2026 (the owner's call; off in both presets from 3
   * October until then); off in Quick, where it runs once, when the student
   * taps it - before the answers are in too.
   */
  autoCheck: boolean;
  /** Who the cross-check goes to, by itself or on a tap; DEFAULT_JUDGE when unset. */
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
const EXPERT_SOLVERS: Pick<Preset, "providers" | "variants" | "effort" | "judge"> = {
  providers: ["kimi", "gemini", "grok"],
  variants: { kimi: "k3", gemini: "argon" },
  effort: "high",
  judge: EXPERT_JUDGE,
};

/**
 * China's judge: MiMo V2.6 Pro, the highest-scoring cheap China model (46 on
 * the Artificial Analysis index) and the most thorough verdict measured - in
 * 541 s. Failing - an error, or the 20-minute safety timeout - the verdict
 * goes to DeepSeek V4.1 Flash instead (JUDGE_FALLBACKS in shared/providers.ts).
 */
export const CHINA_JUDGE: ModelChoice = { provider: "mimo", variant: "pro" };

/**
 * China's solvers, the owner's picks of 17 October 2026 from the cheap China
 * models on OpenCode Go (Kimi K3 and the other dear ones left out): DeepSeek
 * V4.1 Flash, MiniMax M3 and Qwen3.7 Plus - each right on the pipe
 * bifurcation at high, in 126 s, 87 s and 133 s. GLM-5.3-Flash, right once in
 * three, only reads. MiniMax runs on its own API first while that plan lasts.
 */
const CHINA_SOLVERS: Pick<Preset, "providers" | "effort" | "judge"> = {
  providers: ["deepseek", "minimax", "qwen"],
  effort: "high",
  judge: CHINA_JUDGE,
};

/** Flagship's judge (the owner's pick): Claude Opus 5.5, at $4 / $20 per 1M tokens to Astra's $10 / $50. */
export const FLAGSHIP_JUDGE: ModelChoice = { provider: "opus" };

/**
 * Flagship's solvers, the owner's picks of 11 November 2026: GPT-6 Astra on
 * OpenAI's API and Claude Opus 5.5 on Anthropic's, each billed per token on
 * the owner's prepaid credit there - roughly US$0.5-1.5 and US$0.2-0.6 a
 * solve at high. They run here and nowhere else - never in Custom
 * (customPicks) - and only to read, solve and judge (FLAGSHIP_PROVIDERS).
 */
const FLAGSHIP_SOLVERS: Pick<Preset, "providers" | "effort" | "judge"> = {
  providers: ["astra", "opus"],
  effort: "high",
  judge: FLAGSHIP_JUDGE,
};

export const PRESETS: Record<Exclude<SolveMode, "custom">, Record<Tier, Preset>> = {
  careful: {
    // The owner's default solvers, the reading checked by the default readers
    // and reconciler first, and the cross-check (ChatGPT at high, the most
    // reliable judge measured - AGENTS.md) once the answers are in: 7 calls.
    smart: { providers: DEFAULT_SOLVERS, effort: "high", verify: true, autoCheck: true },
    // Grok 4.7 and Gemini 4 Argon read, Kimi K3 reconciles, Claude Opus
    // cross-checks once the answers are in.
    expert: {
      ...EXPERT_SOLVERS,
      verify: true,
      autoCheck: true,
      readers: [{ provider: "grok" }, { provider: "gemini", variant: "argon" }],
      reconciler: { provider: "kimi", variant: "k3" },
    },
    // GLM-5.3-Flash and MiniMax M3 read (both right on the beam diagram, in
    // 8 s and 7 s), DeepSeek reconciles (15 s), and MiMo V2.6 Pro
    // cross-checks once the answers are in.
    china: {
      ...CHINA_SOLVERS,
      verify: true,
      autoCheck: true,
      readers: [{ provider: "glm" }, { provider: "minimax" }],
      reconciler: { provider: "deepseek" },
    },
    // Astra and Opus 5.5 read, Astra reconciles, both solve, and Opus 5.5
    // cross-checks once the answers are in: 6 calls.
    flagship: {
      ...FLAGSHIP_SOLVERS,
      verify: true,
      autoCheck: true,
      readers: [{ provider: "astra" }, { provider: "opus" }],
      reconciler: { provider: "astra" },
    },
  },
  quick: {
    // Three solvers and nothing else: Muse Spark and Claude Haiku on the
    // OpenCode Go subscription (Haiku in DeepSeek's place since 17 October
    // 2026), and Gemini (4 Hydrogen since 14 November 2026, 3.8 Flash
    // before) on the Vertex AI prepaid credit.
    smart: { providers: DEFAULT_SOLVERS, effort: "high", verify: false, autoCheck: false },
    expert: { ...EXPERT_SOLVERS, verify: false, autoCheck: false },
    china: { ...CHINA_SOLVERS, verify: false, autoCheck: false },
    flagship: { ...FLAGSHIP_SOLVERS, verify: false, autoCheck: false },
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
  {
    key: "china",
    title: "China",
    chinese: "中國",
    blurb: "Cheap China models: DeepSeek, MiniMax M3 and Qwen3.7 Plus solve, and MiMo V2.6 Pro cross-checks - thoroughly, but it can take about 10 minutes (DeepSeek takes over if it fails).",
  },
  {
    key: "flagship",
    title: "Flagship",
    chinese: "旗艦",
    blurb: "OpenAI's and Anthropic's flagships on their official APIs: GPT-6 Astra and Claude Opus 5.5 solve, and Opus 5.5 cross-checks.",
  },
];

/**
 * What a question costs on a tier billed per token, by mode, shown under its
 * blurb: estimates for one to three pages at high (11 November 2026).
 */
export const TIER_COST: Partial<Record<Tier, Record<Exclude<SolveMode, "custom">, string>>> = {
  flagship: { quick: "US$0.7–2", careful: "US$2–5" },
};

/** The models a form has picked: what Custom starts from. */
export type FormPicks = {
  providers: ProviderKey[];
  readers: [ModelChoice, ModelChoice];
  reconciler: ModelChoice;
  judge: ModelChoice;
};

/**
 * What Custom starts from when the student leaves a preset for it: the
 * preset's picks (the owner, 16 October 2026), with the Flagship tier's
 * models taken out - Custom never offers GPT-6 Astra or Claude Opus 5.5 (14
 * November 2026, the owner's call). Each one goes for the default in its
 * place: the Smart solvers when no solver is left, the default readers,
 * reconciler and judge.
 */
export function customPicks(picks: FormPicks): FormPicks {
  const flagship = (choice: ModelChoice) => FLAGSHIP_PROVIDERS.has(choice.provider);
  const providers = picks.providers.filter((key) => !FLAGSHIP_PROVIDERS.has(key));
  return {
    providers: providers.length ? providers : [...DEFAULT_SOLVERS],
    readers: [
      flagship(picks.readers[0]) ? DEFAULT_INTERPRETERS[0] : picks.readers[0],
      flagship(picks.readers[1]) ? DEFAULT_INTERPRETERS[1] : picks.readers[1],
    ],
    reconciler: flagship(picks.reconciler) ? DEFAULT_VERIFIER : picks.reconciler,
    judge: flagship(picks.judge) ? DEFAULT_JUDGE : picks.judge,
  };
}

/** The tier the page opens on, every time. */
export const DEFAULT_TIER: Tier = "smart";

export const MODES: Array<{ key: SolveMode; title: string; chinese: string; blurb: string }> = [
  {
    key: "careful",
    title: "Careful",
    chinese: "穩陣",
    blurb: "Checks the reading of the question first, then three models solve, and a judge grades their answers once they are all in.",
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
