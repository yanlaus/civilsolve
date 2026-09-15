// Provider + channel registry. Pure data shared by the Worker and the client.
//
// A "provider" is what the user picks in the UI (ChatGPT, Claude, ...).
// A "channel" is the upstream account/API the key comes from (Poe, OpenCode
// Go, Kimi Code, ...). One provider can be reachable over several channels;
// the Worker resolves which one to use from env (see worker/channels.ts).

export type ProviderKey =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "kimi"
  | "minimax"
  | "deepseek"
  | "grok"
  | "qwen";

export const PROVIDER_KEYS: ProviderKey[] = [
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "minimax",
  "deepseek",
  "grok",
  "qwen",
];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  grok: "Grok",
  qwen: "Qwen",
};

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

export type ChannelKey = "poe" | "opencode" | "kimi" | "moonshot" | "minimax" | "google";

export const CHANNEL_KEYS: ChannelKey[] = [
  "poe",
  "opencode",
  "kimi",
  "moonshot",
  "minimax",
  "google",
];

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(value);
}

/** Human-readable name of the account the key comes from. */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  poe: "Poe",
  opencode: "OpenCode Go",
  kimi: "Kimi Code",
  moonshot: "Moonshot",
  minimax: "MiniMax",
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
};

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
