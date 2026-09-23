// Provider + channel registry. Pure data shared by the Worker and the client.
//
// A "provider" is what the user picks in the UI (ChatGPT, Claude, ...).
// A "channel" is the upstream account/API the key comes from (Poe, OpenCode
// Go, Google). One provider can be reachable over several channels; the
// Worker resolves which one to use from env (see worker/channels.ts).
//
// Kimi, MiniMax and Qwen were removed on 19 September 2026: across two full
// runs of the B.8 fixture (Kimi 0/4, Qwen 0/8, MiniMax 1/4) they never gave a
// reliable answer. Kimi and Qwen are still out; their routes, the Kimi Code /
// Moonshot / MiniMax channels and the Anthropic-protocol dialect they alone
// used are in git history. MiniMax came back on 22 September on a different
// route (OpenCode Go, minimax-m3) after re-testing correct on B.8 at low and
// medium and on the beam - see AGENTS.md.

export type ProviderKey =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "grok"
  | "mimo"
  | "minimax"
  | "muse";

/** Picker order. Claude sits last because it costs the most per solve (below). */
export const PROVIDER_KEYS: ProviderKey[] = [
  "chatgpt",
  "gemini",
  "deepseek",
  "grok",
  "mimo",
  "minimax",
  "muse",
  "claude",
];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  mimo: "MiMo",
  minimax: "MiniMax",
  muse: "Muse Spark",
};

/**
 * Models badged as China models in the picker, at the owner's choice: MiMo
 * is Xiaomi's and MiniMax is MiniMax's, both reached on their mainland
 * deployments. DeepSeek is Chinese too and was badged for one day, but the
 * owner asked for the label on these two only. This is a provenance label,
 * not a quality or cost one.
 */
export const CHINA_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "mimo",
  "minimax",
]);

/**
 * Providers whose upstream account bills noticeably more per solve than the
 * rest. The picker shows a badge so the cost is visible before a solve, not
 * after. Claude runs as Opus on Poe, the priciest bot there by a wide margin;
 * Grok is the heaviest draw per solve on the owner's OpenCode Go plan.
 */
export const HIGHER_CREDIT_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "grok",
  "claude",
]);

/**
 * Providers that draw the least from their upstream account, badged likewise.
 * DeepSeek Flash is the lightest draw per solve on the OpenCode Go plan;
 * `muse-spark-1.3-contributor` is free because it is a data-collecting
 * "contributor" tier: the workspace must opt in, and what is sent - the
 * assignment images included - may be used to train it. MiMo (`mimo-v2.5`,
 * OpenCode Zen's free tier) is unbadged: neither notably dear nor notably
 * cheap on that plan.
 */
export const LOWER_CREDIT_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "deepseek",
  "muse",
]);

/**
 * Ticked by default in the upload form. Several providers may be selected
 * and they solve at the same time (the account is on Workers Paid; on the
 * free plan concurrent streams got killed). Gemini Flash on Google was right
 * on both fixtures and is the cheapest route of any; Muse Spark was 3/3 on
 * the hard fixture where it finished, for free. Two solvers is also what the
 * answer cross-check needs.
 */
export const DEFAULT_SOLVERS: ProviderKey[] = ["gemini", "muse"];

/**
 * Default readers and judge for the optional interpretation pass. Two
 * different readers so they can disagree; the judge is a third model.
 * Gemini and Muse Spark read (same reasoning as the solvers above); ChatGPT
 * (gpt-5.6-luna on OpenCode Go, the most reliable solver in the B.8 matrix)
 * reconciles them.
 */
export const DEFAULT_INTERPRETERS: [ProviderKey, ProviderKey] = ["gemini", "muse"];
export const DEFAULT_VERIFIER: ProviderKey = "chatgpt";

/**
 * Default judge for the optional answer cross-check: the selected solvers
 * solve, ChatGPT grades every solution against the images. The judge should
 * be the strongest model at hand rather than one of the solvers, and Luna at
 * "high" was the most reliable cell in the B.8 matrix.
 */
export const DEFAULT_JUDGE: ProviderKey = "chatgpt";

export type ChannelKey = "poe" | "opencode" | "google" | "minimax";

export const CHANNEL_KEYS: ChannelKey[] = ["poe", "opencode", "google", "minimax"];

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(value);
}

/** Human-readable name of the account the key comes from. */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  poe: "Poe",
  opencode: "OpenCode Go",
  google: "Google AI",
  minimax: "MiniMax",
};

/** Per-provider status reported by GET /api/health (never includes key values). */
export type ProviderStatus = {
  channel: ChannelKey;
  model: string;
  configured: boolean;
  /** Present when the route pins its reasoning level regardless of the user's choice. */
  forcedEffort?: string;
  /** Present when the route raises low choices to a floor. */
  minEffort?: string;
  /** Present when the route refuses levels above this one. */
  maxEffort?: string;
  /** Present when the route switches to these models, in order, if `model` fails. */
  fallbackModels?: string[];
  /** Present when the provider moves to these channels, in order, if `channel` refuses or fails. */
  fallbackChannels?: ChannelKey[];
};

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
