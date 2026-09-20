// Provider + channel registry. Pure data shared by the Worker and the client.
//
// A "provider" is what the user picks in the UI (ChatGPT, Claude, ...).
// A "channel" is the upstream account/API the key comes from (Poe, OpenCode
// Go, Google). One provider can be reachable over several channels; the
// Worker resolves which one to use from env (see worker/channels.ts).
//
// Kimi, MiniMax and Qwen were removed in September 2026: across two full runs
// of the B.8 fixture (Kimi 0/4, Qwen 0/8, MiniMax 1/4) they never gave a
// reliable answer. Their routes, the Kimi Code / Moonshot / MiniMax channels,
// and the Anthropic-protocol dialect they alone used are in git history.

export type ProviderKey = "chatgpt" | "claude" | "gemini" | "deepseek" | "grok" | "mimo" | "muse";

/** Picker order. Claude sits last because it costs the most per solve (below). */
export const PROVIDER_KEYS: ProviderKey[] = [
  "chatgpt",
  "gemini",
  "deepseek",
  "grok",
  "mimo",
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
  muse: "Muse Spark",
};

/**
 * Providers whose upstream account bills noticeably more per solve than the
 * rest. The picker shows a badge so the cost is visible before a solve, not
 * after. Claude runs as Opus on Poe, the priciest bot there by a wide margin.
 */
export const HIGHER_CREDIT_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["claude"]);

/**
 * Providers that cost nothing on their upstream account, badged likewise.
 * `mimo-v2.5` is OpenCode Zen's free MiMo tier ("available for a limited
 * time", and the docs say its data may be used for model improvement).
 * `muse-spark-1.3-contributor` is free because it is a data-collecting
 * "contributor" tier: the workspace must opt in, and what is sent - the
 * assignment images included - may be used to train it.
 */
export const FREE_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["mimo", "muse"]);

/**
 * Selected by default in the upload form. Only one provider runs per solve -
 * on the free plan each is a per-token stream that draws CPU for its whole
 * duration, so running several at once exhausts the CPU budget and the runtime
 * kills a stream. One at a time keeps every solve inside the budget.
 */
export const DEFAULT_PROVIDER: ProviderKey = "chatgpt";

/**
 * Default readers and judge for the optional interpretation pass. Two
 * different readers so they can disagree; the judge is a third model.
 */
export const DEFAULT_INTERPRETERS: [ProviderKey, ProviderKey] = ["chatgpt", "gemini"];
export const DEFAULT_VERIFIER: ProviderKey = "claude";

export type ChannelKey = "poe" | "opencode" | "google";

export const CHANNEL_KEYS: ChannelKey[] = ["poe", "opencode", "google"];

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(value);
}

/** Human-readable name of the account the key comes from. */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  poe: "Poe",
  opencode: "OpenCode Go",
  google: "Google AI",
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
  /** Present when the route switches to these models, in order, if `model` fails. */
  fallbackModels?: string[];
};

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
