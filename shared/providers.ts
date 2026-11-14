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
  | "haiku"
  | "qwen"
  | "glm"
  | "astra"
  | "opus";

/**
 * Every provider, in picker order - the order of the solver cards, the
 * reader and judge lists, the solution tabs (Muse Spark's first -
 * SOLUTION_ORDER) and the letters the judge sees.
 * The two dearest (Grok, Claude) close the solvers. The solver cards use
 * SOLVER_KEYS, which leaves out the review-only providers.
 */
export const PROVIDER_KEYS: ProviderKey[] = [
  // The owner's order (26 September 2026): nine cards, three by three.
  // Muse returns to its card on 11 October 2026. The old Haiku key remains
  // last for saved runs; new picks use Claude's Haiku variant instead.
  "chatgpt",
  "muse",
  "deepseek",
  "kimi",
  "mimo",
  "minimax",
  "gemini",
  "grok",
  "claude",
  "haiku",
  // The China tier's own (17 October 2026): no solver card, not in the
  // reader and judge lists (TIER_ONLY_PROVIDERS).
  "qwen",
  "glm",
  // The Flagship tier's own (11 November 2026), on the vendors' official
  // APIs: GPT-6 Astra on OpenAI's, Claude Opus 5.5 on Anthropic's. No solver
  // card and not in the reader and judge lists: never in Custom
  // (TIER_ONLY_PROVIDERS). Astra first, so the judge sees it as Solution A.
  "astra",
  "opus",
];

/**
 * The solution tabs' order, which the study notes' "Start from" follows too:
 * Muse Spark's first, then picker order (restored on 11 October 2026).
 */
export const SOLUTION_ORDER: ProviderKey[] = [
  "muse",
  ...PROVIDER_KEYS.filter((key) => key !== "muse"),
];

export function isProviderKey(value: string): value is ProviderKey {
  return (PROVIDER_KEYS as string[]).includes(value);
}

/**
 * Providers that never solve: the worker refuses a solve for them. GLM-5.3-
 * Flash since 17 October 2026 - the China tier's first reader, which got the
 * pipe bifurcation right once in three solves.
 */
export const REVIEW_ONLY_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["glm"]);

/** Accepted for saved runs and retries, but no longer offered as a separate pick. */
export const LEGACY_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["haiku"]);

/**
 * Providers only one tier runs: the China tier's (17 October 2026, the
 * owner's call) - Qwen3.7 Plus solves and GLM-5.3-Flash reads there - and
 * the Flagship tier's GPT-6 Astra and Claude Opus 5.5 (11 November 2026).
 * None has a solver card or a place in the reader and judge lists, and a
 * list a run's own pick is missing from adds it (choicesWith). Custom shows
 * a China model only while a China preset left it picked; it never offers
 * the Flagship models, not even carried over from Flagship (customPicks in
 * src/lib/presets.ts) - Custom offered them on 13 November 2026 only, and
 * the owner took that back the next day.
 */
export const TIER_ONLY_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["qwen", "glm", "astra", "opus"]);

/**
 * What a model can be asked to do: read the question (the interpretation
 * pass - a reader or the reconciler), solve it, judge the answers, or one of
 * the extras - study notes, answers to a student's questions, the comparison
 * of the answers, drawings - or tell which course subject a question belongs
 * to (`classify`). The same words as the worker's task kinds.
 */
export type ModelPurpose = "interpret" | "solve" | "judge" | "study" | "ask" | "align" | "visualize" | "classify";

/**
 * The Flagship tier's models read, solve and judge, and nothing else (13
 * November 2026, the owner's call): every extra would be another per-token
 * call on the vendors' own APIs. They run in the Flagship tier only
 * (TIER_ONLY_PROVIDERS; never in Custom), no list offers them for anything
 * else (choicesWith), the worker refuses them the rest (servesPurpose in
 * buildTask), and the study notes and the questions under a Flagship
 * solution start from another model.
 */
export const FLAGSHIP_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(["astra", "opus"]);

const FLAGSHIP_PURPOSES: ReadonlySet<ModelPurpose> = new Set<ModelPurpose>(["interpret", "solve", "judge"]);

/** Whether a provider may be asked for this purpose. */
export function servesPurpose(provider: ProviderKey, purpose: ModelPurpose) {
  return !FLAGSHIP_PROVIDERS.has(provider) || FLAGSHIP_PURPOSES.has(purpose);
}

/** The solver cards, in picker order: every provider that is not review-only. */
export const SOLVER_KEYS: ProviderKey[] = PROVIDER_KEYS.filter(
  (key) => !REVIEW_ONLY_PROVIDERS.has(key) && !LEGACY_PROVIDERS.has(key) && !TIER_ONLY_PROVIDERS.has(key),
);

export function isSolverKey(value: string): value is ProviderKey {
  return isProviderKey(value) && !REVIEW_ONLY_PROVIDERS.has(value);
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
  haiku: "Claude Haiku",
  qwen: "Qwen",
  glm: "GLM",
  astra: "GPT-6 Astra",
  opus: "Claude Opus 5.5",
};

/**
 * Models one provider offers under a single card, the first being the
 * default: the card gets a switch, and the reader and judge lists one entry
 * each. Gemini since 26 September 2026, on Google Vertex AI - since 14
 * November 2026 (the owner's call) Gemini 4: 4 Hydrogen, the fast one (the
 * route's own chain, falling back to 3.8 Flash, the "Flash" pick until
 * then), or 4 Carbon, the strongest (falling back to 3.1 Pro Preview, the
 * "Pro" pick until then) - and since 15 October 2026 (the owner's request) 4
 * Argon, `gemini-4-argon-contributor` on OpenCode Go. The keys "flash" and
 * "pro" stay, for the runs and history saved with them. Kimi since
 * 15 October 2026 (the owner's request): K2.7 Code, as before, or K3. The
 * worker maps a variant onto a model in variantOverride (worker/channels.ts).
 */
export type ModelVariant = "flash" | "pro" | "argon" | "haiku" | "opus" | "k2.7" | "k3";

export const PROVIDER_VARIANTS: Partial<
  Record<ProviderKey, ReadonlyArray<{ key: ModelVariant; label: string; shortLabel: string }>>
> = {
  gemini: [
    { key: "flash", label: "4 Hydrogen", shortLabel: "4 Hydrogen" },
    { key: "pro", label: "4 Carbon", shortLabel: "4 Carbon" },
    { key: "argon", label: "4 Argon", shortLabel: "4 Argon" },
  ],
  claude: [
    { key: "haiku", label: "Haiku", shortLabel: "Haiku" },
    { key: "opus", label: "Opus", shortLabel: "Opus" },
  ],
  kimi: [
    { key: "k2.7", label: "K2.7 Code", shortLabel: "K2.7 Code" },
    { key: "k3", label: "K3", shortLabel: "K3" },
  ],
  // V2.6 Pro since 17 October 2026: the China tier's judge. It is also a pick
  // on the MiMo card - right on the pipe bifurcation, but in 453 s.
  mimo: [
    { key: "flash", label: "V2.6 Flash", shortLabel: "Flash" },
    { key: "pro", label: "V2.6 Pro", shortLabel: "Pro" },
  ],
};

export function isVariantOf(provider: ProviderKey, value: unknown): value is ModelVariant {
  return Boolean(PROVIDER_VARIANTS[provider]?.some((variant) => variant.key === value));
}

/** "Gemini (4 Carbon)" - a provider's name with the model picked, when it offers several. */
export function providerDisplayName(provider: ProviderKey, variant?: ModelVariant) {
  // Before variants existed, "claude" always meant Opus. Preserve old records.
  if (provider === "claude") return variant === "haiku" ? "Claude Haiku" : "Claude Opus";
  const label = PROVIDER_VARIANTS[provider]?.find((entry) => entry.key === variant)?.label;
  return label ? `${PROVIDER_LABELS[provider]} (${label})` : PROVIDER_LABELS[provider];
}

/**
 * A pick in the reader and judge lists: a provider, and the model when it
 * offers several. `choiceKey` is its value in a <select>: "gemini:pro".
 */
export type ModelChoice = { provider: ProviderKey; variant?: ModelVariant };

/** Translate stored single-model picks into the current model menu. */
export function canonicalChoice(choice: ModelChoice): ModelChoice {
  if (choice.provider === "haiku") return { provider: "claude", variant: "haiku" };
  if (choice.provider === "claude" && !choice.variant) return { provider: "claude", variant: "opus" };
  return choice;
}

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
export const MODEL_CHOICES: ModelChoice[] = PROVIDER_KEYS.filter(
  (key) => !LEGACY_PROVIDERS.has(key) && !TIER_ONLY_PROVIDERS.has(key),
).flatMap((provider) =>
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
  "qwen",
  "glm",
]);

/**
 * Providers whose upstream account bills noticeably more per solve than the
 * rest. The picker shows a badge so the cost is visible before a solve, not
 * after. Claude runs as Opus on Poe, the priciest bot there by a wide margin;
 * Grok is the heaviest draw per solve on the owner's OpenCode Go plan after
 * Gemini 4 Argon ($4 / $20 per 1M tokens to Grok's $2 / $6, about 1,060
 * requests a month on its own cap - October 2026) and Kimi K3 ($3 / $15,
 * about 490 a month, to K2.7 Code's $0.95 / $4 and 6,750). The Flagship
 * tier's two are billed per token on the vendors' prepaid API credit: GPT-6
 * Astra at $10 / $50 per 1M tokens, Claude Opus 5.5 at $4 / $20.
 */
export const HIGHER_CREDIT_PROVIDERS: ReadonlySet<ProviderKey> = new Set<ProviderKey>([
  "grok",
  "astra",
  "opus",
]);

export function usesMoreCredit(provider: ProviderKey, variant?: ModelVariant) {
  return (
    HIGHER_CREDIT_PROVIDERS.has(provider) ||
    (provider === "claude" && variant !== "haiku") ||
    (provider === "gemini" && variant === "argon") ||
    (provider === "kimi" && variant === "k3")
  );
}

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
 * The Smart tier's solvers, in picker order: Muse Spark, Gemini (4 Hydrogen
 * since 14 November 2026, 3.8 Flash before)
 * and Claude (Haiku, the card's first model) - Claude Haiku in DeepSeek's
 * place since 17 October 2026 (the owner's call; DeepSeek solves in the China
 * tier). Muse came back after alarm dispatch on 11 October 2026.
 */
export const DEFAULT_SOLVERS: ProviderKey[] = ["muse", "gemini", "claude"];

/**
 * A judge that, when it fails - an error, or the 20-minute safety timeout -
 * hands the cross-check to another, once: MiMo V2.6 Pro, the China judge,
 * judged the pipe bifurcation in 541 s; DeepSeek V4.1 Flash in 78-137 s.
 * Cloudflare puts no time limit on it (it is not an alarm route), so it gets
 * no tighter limit of its own (the owner, 17 October 2026).
 */
export const JUDGE_FALLBACKS: Partial<Record<string, ModelChoice>> = {
  "mimo:pro": { provider: "deepseek" },
};

/**
 * Default readers and judge for the optional interpretation pass. Two
 * different readers so they can disagree. ChatGPT and Gemini Flash read;
 * ChatGPT (Luna on OpenCode Go - gpt-6-luna since 15 October 2026, and
 * gpt-5.6-luna before it, the most reliable solver in the B.8
 * matrix) reconciles them too - a separate call, but no longer a third
 * model. The readers were DeepSeek Flash and Muse Spark from 25 September
 * 2026 (Gemini's free AI Studio key failed too often to be the default
 * then), Kimi and Gemini Flash from 26 September, MiMo took Kimi's place on
 * 27 September, Muse Spark took MiMo's on 3 October (on a one-page beam it
 * read in 21-35 s, MiMo in 18-28 s, both correct), and ChatGPT took Muse
 * Spark's on 10 October, when its free tier refused students abroad by
 * country - the owner's picks each time. Gemini is on Vertex AI and its
 * prepaid credit: each reading is a billed call - to Gemini 4 Hydrogen since
 * 14 November 2026, to 3.8 Flash before.
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

/**
 * Who tells which course subject a question belongs to (shared/subjects.ts,
 * 14 November 2026, the owner's choice), at "low", before anything is
 * solved: DeepSeek Flash again - a quick look at the pages, on the OpenCode Go
 * subscription.
 */
export const DEFAULT_CLASSIFIER: ModelChoice = { provider: "deepseek" };

/**
 * The upstream accounts. "openai" and "anthropic" (11 November 2026) are the
 * vendors' own APIs, on the owner's prepaid credit, for the Flagship tier.
 */
export type ChannelKey = "poe" | "opencode" | "google" | "google-backup" | "minimax" | "openai" | "anthropic";

export const CHANNEL_KEYS: ChannelKey[] = ["poe", "opencode", "google", "google-backup", "minimax", "openai", "anthropic"];

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
  openai: "OpenAI API",
  anthropic: "Anthropic API",
};

/** Per-provider status reported by GET /api/health (never includes key values). */
export type ModelStatus = {
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

export type ProviderStatus = ModelStatus & {
  /** Model ids retained for clients that predate per-variant route details. */
  variants?: Partial<Record<ModelVariant, string>>;
  /** A variant can use a different account, API dialect and effort band. */
  variantStatuses?: Partial<Record<ModelVariant, ModelStatus>>;
};

export function modelStatus(status: ProviderStatus | undefined, variant?: ModelVariant): ModelStatus | undefined {
  return (variant && status?.variantStatuses?.[variant]) || status;
}

export type HealthResponse = {
  providers: Record<ProviderKey, ProviderStatus>;
};
