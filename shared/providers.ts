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
// a reader and judge, and on 26 September as a solver too. Gemini was reader
// and judge only for part of 26 September, while its free Google AI Studio
// key failed; it came back that day as a solver on Google Vertex AI, on the
// owner's prepaid Google Cloud credit, as Flash or Pro (PROVIDER_VARIANTS).

export type ProviderKey =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "grok"
  | "mimo"
  | "minimax"
  | "kimi"
  | "muse"
  | "haiku";

/**
 * Every provider, in picker order - the order of the solver cards, the
 * reader and judge lists, the solution tabs (Claude Haiku's first -
 * SOLUTION_ORDER) and the letters the judge sees.
 * The two dearest (Grok, Claude) close the solvers. The solver cards use
 * SOLVER_KEYS, which leaves out the review-only providers.
 */
export const PROVIDER_KEYS: ProviderKey[] = [
  // The owner's order (26 September 2026): nine cards, three by three.
  // Muse Spark before DeepSeek since 2 October 2026, at the owner's request;
  // Claude Haiku in Muse Spark's card since 10 October 2026, and Muse Spark,
  // review-only from then, last.
  "chatgpt",
  "haiku",
  "deepseek",
  "kimi",
  "mimo",
  "minimax",
  "gemini",
  "grok",
  "claude",
  "muse",
];

/**
 * The solution tabs' order, which the study notes' "Start from" follows too:
 * Claude Haiku's first, always, then picker order. Muse Spark's was first
 * from 30 September 2026; on 10 October 2026 Meta's country limit on its
 * free tier (students abroad got 403s) took it out of every default - for
 * part of that day ChatGPT's, then Claude Haiku's, the default solver in its
 * place (the owner's calls).
 */
export const SOLUTION_ORDER: ProviderKey[] = [
  "haiku",
  ...PROVIDER_KEYS.filter((key) => key !== "haiku"),
];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as string[]).includes(value);
}

/**
 * Offered as a reader or reconciler in the interpretation pass and as the
 * cross-check judge, but never as a solver: no card, and /api/solve refuses
 * them. Kimi was here from 25 September 2026, and Gemini for part of
 * 26 September while its free Google key failed; both solve now. Muse Spark
 * since 10 October 2026, when Claude Haiku took its card (the owner's call):
 * Meta serves its free tier in some countries only (AGENTS.md).
 */
export const REVIEW_ONLY_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["muse"]);

/** The solver cards, in picker order: every provider that is not review-only. */
export const SOLVER_KEYS: ProviderKey[] = PROVIDER_KEYS.filter(
  (key) => !REVIEW_ONLY_PROVIDERS.has(key),
);

export function isSolverKey(value: string): value is ProviderKey {
  return (SOLVER_KEYS as string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  chatgpt: "ChatGPT",
  // "Claude" until 11 October 2026: named for its model once Claude Haiku
  // had a card of its own (the owner's request).
  claude: "Claude Opus",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  mimo: "MiMo",
  minimax: "MiniMax",
  kimi: "Kimi",
  muse: "Muse Spark",
  haiku: "Claude Haiku",
};

/**
 * Models one provider offers under a single card, the first being the
 * default: the card gets a switch, and the reader and judge lists one entry
 * each. Gemini since 26 September 2026, on Google Vertex AI: 3.8 Flash (the
 * route's own chain, falling back to 3.5 Flash) or 3.1 Pro, which was 2/2 on
 * B.8 at "high" in 136-189 s. The worker maps a variant onto a model in
 * variantOverride (worker/channels.ts).
 */
export type ModelVariant = "flash" | "pro";

export const PROVIDER_VARIANTS: Partial<
  Record<ProviderKey, ReadonlyArray<{ key: ModelVariant; label: string }>>
> = {
  gemini: [
    { key: "flash", label: "3.8 Flash" },
    { key: "pro", label: "3.1 Pro" },
  ],
};

export function isVariantOf(provider: ProviderKey, value: unknown): value is ModelVariant {
  return Boolean(PROVIDER_VARIANTS[provider]?.some((variant) => variant.key === value));
}

/** "Gemini (3.1 Pro)" - a provider's name with the model picked, when it offers several. */
export function providerDisplayName(provider: ProviderKey, variant?: ModelVariant) {
  const label = PROVIDER_VARIANTS[provider]?.find((entry) => entry.key === variant)?.label;
  return label ? `${PROVIDER_LABELS[provider]} (${label})` : PROVIDER_LABELS[provider];
}

/**
 * A pick in the reader and judge lists: a provider, and the model when it
 * offers several. `choiceKey` is its value in a <select>: "gemini:pro".
 */
export type ModelChoice = { provider: ProviderKey; variant?: ModelVariant };

export function choiceKey(choice: ModelChoice) {
  return choice.variant ? `${choice.provider}:${choice.variant}` : choice.provider;
}

export function parseChoice(value: string): ModelChoice | null {
  const [provider, variant] = value.split(":");
  if (!isProviderKey(provider)) return null;
  if (variant === undefined) return { provider };
  return isVariantOf(provider, variant) ? { provider, variant } : null;
}

/** Every reader and judge pick, in picker order: one per model. */
export const MODEL_CHOICES: ModelChoice[] = PROVIDER_KEYS.flatMap((provider) =>
  PROVIDER_VARIANTS[provider]
    ? PROVIDER_VARIANTS[provider]!.map((variant) => ({ provider, variant: variant.key }))
    : [{ provider }],
);

/**
 * Models badged as China models in the picker, at the owner's choice: MiMo
 * is Xiaomi's, MiniMax is MiniMax's and Kimi is Moonshot AI's (added
 * 26 September 2026). DeepSeek is Chinese too and was badged for one day,
 * but the owner has not asked for the label on it. This is a provenance
 * label, not a quality or cost one.
 */
export const CHINA_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "kimi",
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
 * assignment images included - may be used to train it. MiMo (`mimo-v2.6-flash`,
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
 * Paid; on the free plan concurrent streams got killed). DeepSeek Flash is
 * the lightest draw on the OpenCode Go plan and solved a two-problem paper
 * correctly on production; Muse Spark was 3/3 on the hard fixture where it
 * finished, for free. Two is the fewest the answer cross-check can compare.
 * Kimi was ticked too for one day (26 September 2026, in Gemini's place) and
 * was unticked at the owner's request; it misread B.8 at "medium" on
 * production the same day, though it was 2/2 at "high". Gemini is ticked
 * since 1 October 2026, at the owner's request, on its card's default model
 * (3.8 Flash): billed per call, but both Google projects are capped at their
 * monthly AI Pro credit, and the second key backs the first up. Claude
 * Haiku (Haiku 5.5 at "xhigh" or "max", on the Go subscription) is ticked in
 * Muse Spark's place since 10 October 2026, at the owner's request: Muse
 * Spark's free tier answered students abroad "This model is not available in
 * your country." (AGENTS.md). ChatGPT stood in for part of that day; it is
 * no default solver now, so the default judge (ChatGPT) grades no solution
 * of its own.
 */
export const DEFAULT_SOLVERS: ProviderKey[] = ["haiku", "deepseek", "gemini"];

/**
 * Default readers and judge for the optional interpretation pass. Two
 * different readers so they can disagree. ChatGPT and Gemini Flash read;
 * ChatGPT (gpt-5.6-luna on OpenCode Go, the most reliable solver in the B.8
 * matrix) reconciles them too - a separate call, but no longer a third
 * model. The readers were DeepSeek Flash and Muse Spark from 25 September
 * 2026 (Gemini's free AI Studio key failed too often to be the default
 * then), Kimi and Gemini Flash from 26 September, MiMo took Kimi's place on
 * 27 September, Muse Spark took MiMo's on 3 October (on a one-page beam it
 * read in 21-35 s, MiMo in 18-28 s, both correct), and ChatGPT took Muse
 * Spark's on 10 October, when its free tier refused students abroad by
 * country - the owner's picks each time. Gemini is on Vertex AI and its
 * prepaid credit: each reading is a billed Flash call.
 */
export const DEFAULT_INTERPRETERS: [ModelChoice, ModelChoice] = [
  { provider: "chatgpt" },
  { provider: "gemini", variant: "flash" },
];
export const DEFAULT_VERIFIER: ModelChoice = { provider: "chatgpt" };

/**
 * Default judge for the optional answer cross-check: the selected solvers
 * solve, ChatGPT grades every solution against the images. The judge should
 * be the strongest model at hand rather than one of the solvers, and Luna at
 * "high" was the most reliable cell in the B.8 matrix.
 */
export const DEFAULT_JUDGE: ModelChoice = { provider: "chatgpt" };

/**
 * Who compares the answers with each other once every solver has answered
 * (shared/align.ts, since 9 October 2026), at "low": DeepSeek Flash, the
 * lightest draw on the OpenCode Go subscription. Measured on two sets of
 * three answers (a pipe bifurcation whose forces one answer gave the other
 * way, and a gate with one W different): it named both, in 19 s and 7 s.
 * Muse Spark named both too, a little faster, but its free tier keeps what
 * it is sent for training.
 */
export const DEFAULT_ALIGNER: ModelChoice = { provider: "deepseek" };

export type ChannelKey = "poe" | "opencode" | "google" | "google-backup" | "minimax";

export const CHANNEL_KEYS: ChannelKey[] = ["poe", "opencode", "google", "google-backup", "minimax"];

export function isChannelKey(value: string): value is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(value);
}

/** Human-readable name of the account the key comes from. */
export const CHANNEL_LABELS: Record<ChannelKey, string> = {
  poe: "Poe",
  opencode: "OpenCode Go",
  google: "Google Vertex AI",
  "google-backup": "Google Vertex AI, backup key",
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
  /** Present when the provider offers several models (PROVIDER_VARIANTS): the model each one runs. */
  variants?: Partial<Record<ModelVariant, string>>;
};

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
