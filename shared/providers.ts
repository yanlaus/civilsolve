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
// medium and on the beam - see AGENTS.md. Kimi came back on 25 September as
// a reader and judge only, never a solver (REVIEW_ONLY_PROVIDERS).

export type ProviderKey =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "grok"
  | "mimo"
  | "minimax"
  | "kimi"
  | "muse";

/**
 * Every provider, in picker order - the order of the reader and judge lists.
 * Claude sits last because it costs the most per solve (below). The solver
 * cards use SOLVER_KEYS, which leaves out the review-only providers.
 */
export const PROVIDER_KEYS: ProviderKey[] = [
  "chatgpt",
  "gemini",
  "deepseek",
  "grok",
  "mimo",
  "minimax",
  "kimi",
  "muse",
  "claude",
];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as string[]).includes(value);
}

/**
 * Offered as a reader or reconciler in the interpretation pass and as the
 * cross-check judge, but never as a solver. Kimi (kimi-k2.7-code on OpenCode
 * Go) was dropped as a solver on 19 September 2026 - 0/4 on the B.8 fixture -
 * and came back in these two roles only, at the owner's request, on
 * 25 September.
 */
export const REVIEW_ONLY_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["kimi"]);

/** The solver cards, in picker order: every provider that is not review-only. */
export const SOLVER_KEYS: ProviderKey[] = PROVIDER_KEYS.filter(
  (key) => !REVIEW_ONLY_PROVIDERS.has(key),
);

export function isSolverKey(value: string): value is ProviderKey {
  return (SOLVER_KEYS as string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  mimo: "MiMo",
  minimax: "MiniMax",
  kimi: "Kimi",
  muse: "Muse Spark",
};

/**
 * Providers that cost nothing but fail often: badged "Free but unstable" in
 * the picker and shown last among the solution tabs, so a dependable answer
 * is what the page opens on. Gemini runs on the owner's free-tier Google key,
 * where gemini-3.8-flash declined most requests and gemini-3.5-flash kept
 * answering 503 "high demand" (22-23 September 2026).
 */
export const UNSTABLE_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["gemini"]);

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
 * Ticked by default in the upload form, in picker order. Several providers
 * may be selected and they solve at the same time (the account is on Workers
 * Paid; on the free plan concurrent streams got killed). Gemini Flash on
 * Google was right on both fixtures and is the cheapest route of any;
 * DeepSeek Flash is the lightest draw on the OpenCode Go plan and solved a
 * two-problem paper correctly on production; Muse Spark was 3/3 on the hard
 * fixture where it finished, for free. Three solvers give the answer
 * cross-check a majority to weigh, and still leave it room for a fourth.
 */
export const DEFAULT_SOLVERS: ProviderKey[] = ["gemini", "deepseek", "muse"];

/**
 * Default readers and judge for the optional interpretation pass. Two
 * different readers so they can disagree; the judge is a third model.
 * DeepSeek Flash and Muse Spark read; ChatGPT (gpt-5.6-luna on OpenCode Go,
 * the most reliable solver in the B.8 matrix) reconciles them. DeepSeek has
 * no pinned interpretation route, so it reads on its solve route - the same
 * deepseek-v4.1-flash that solves. It replaced Gemini as the first reader on
 * 25 September 2026, at the owner's request: Gemini's free-tier key fails
 * too often to be the default for a step every solve then waits on.
 */
export const DEFAULT_INTERPRETERS: [ProviderKey, ProviderKey] = ["deepseek", "muse"];
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
