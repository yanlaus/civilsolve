// Provider + channel registry. Pure data shared by the Worker and the client.
//
// A "provider" is what the user picks in the UI (ChatGPT, Claude, ...).
// A "channel" is the upstream account/API the key comes from (Poe, Moonshot,
// MiniMax, Google). One provider can be reachable over several channels; the
// Worker resolves which one to use from env (see worker/channels.ts).

export type ProviderKey = "chatgpt" | "claude" | "gemini" | "kimi" | "minimax";

export const PROVIDER_KEYS: ProviderKey[] = [
  "chatgpt",
  "claude",
  "gemini",
  "kimi",
  "minimax",
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
};

export type ChannelKey = "poe" | "kimi" | "moonshot" | "minimax" | "google";

export const CHANNEL_KEYS: ChannelKey[] = ["poe", "kimi", "moonshot", "minimax", "google"];

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(value);
}

/** Human-readable name of the account the key comes from. */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  poe: "Poe",
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
};

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
