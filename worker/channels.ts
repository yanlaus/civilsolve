// Upstream channel adapters.
//
// Every provider is reached through exactly one "channel" (Poe, OpenCode Go,
// Google), resolved from env at request time. Channels speak three different
// API dialects, so this module owns:
//
//   - route resolution (which channel/model/key/endpoint for a provider)
//   - request building per dialect, including the reasoning-effort parameter
//   - upstream stream/payload parsing per dialect
//
// worker/run.ts stays dialect-agnostic and only orchestrates.

import type { EffortKey } from "../shared/prompt";
import {
  CHANNEL_LABELS,
  isChannelKey,
  PROVIDER_LABELS,
  type ChannelKey,
  type ProviderKey,
  type ProviderStatus,
} from "../shared/providers";

export type Dialect = "responses" | "chat-completions" | "gemini";

export type WorkerEnv = {
  // --- Secrets: one per upstream account ---------------------------------
  POE_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  GOOGLE_API_KEY?: string;

  // --- Channel routing: which account serves each provider ---------------
  CHATGPT_CHANNEL?: string;
  CLAUDE_CHANNEL?: string;
  GEMINI_CHANNEL?: string;
  DEEPSEEK_CHANNEL?: string;
  GROK_CHANNEL?: string;
  MIMO_CHANNEL?: string;
  MINIMAX_CHANNEL?: string;
  MUSE_CHANNEL?: string;

  // --- Model overrides ---------------------------------------------------
  POE_CHATGPT_MODEL?: string;
  POE_CLAUDE_MODEL?: string;
  POE_GEMINI_MODEL?: string;
  OPENCODE_CHATGPT_MODEL?: string;
  OPENCODE_DEEPSEEK_MODEL?: string;
  OPENCODE_GROK_MODEL?: string;
  OPENCODE_MIMO_MODEL?: string;
  OPENCODE_MINIMAX_MODEL?: string;
  OPENCODE_MUSE_MODEL?: string;
  GOOGLE_GEMINI_MODEL?: string;
  INTERPRET_CHATGPT_MODEL?: string;
  INTERPRET_GEMINI_MODEL?: string;
  INTERPRET_CLAUDE_MODEL?: string;

  // --- Endpoint overrides (proxies) --------------------------------------
  POE_BASE_URL?: string;
  OPENCODE_BASE_URL?: string;
  GOOGLE_BASE_URL?: string;

  // --- Behaviour ---------------------------------------------------------
  // Comma-separated provider keys that should use a non-streamed upstream
  // fetch (still delivered over the same SSE response), e.g. "deepseek".
  NO_STREAM?: string;
  /** Superseded by NO_STREAM; still read so old configs keep working. */
  POE_NO_STREAM?: string;
};

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

// The five UI levels are NOT portable across model families:
//   - OpenAI-style endpoints take an enum, and only GPT-5.x accepts
//     "none"/"xhigh".
//   - Claude has no "off" enum value; thinking is disabled by omitting the
//     parameter entirely.
//   - Gemini takes an integer token budget, and Pro-tier models refuse a
//     budget of 0 (thinking cannot be switched off at all).
//
// A level with no entry in `values` means "send nothing, use the model
// default" rather than "send a value this model will reject".
export type EffortSpec =
  | { kind: "none" }
  | { kind: "enum"; values: Partial<Record<EffortKey, string>> }
  | { kind: "budget"; values: Partial<Record<EffortKey, number>> };

const OPENAI_EFFORT: EffortSpec = {
  kind: "enum",
  values: { none: "none", low: "low", medium: "medium", high: "high", max: "xhigh" },
};

// No "none": these families disable thinking by omitting the parameter.
// No "xhigh": it is unknown outside the GPT-5.x enum, so "max" clamps to "high".
const CLAMPED_EFFORT: EffortSpec = {
  kind: "enum",
  values: { low: "low", medium: "medium", high: "high", max: "high" },
};

// Gemini thinking budgets, in tokens. "none" is deliberately absent: Pro-tier
// models reject a 0 budget, so "None" falls back to the model default.
const GEMINI_BUDGET: EffortSpec = {
  kind: "budget",
  values: { low: 2048, medium: 8192, high: 16384, max: 32768 },
};

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

type RouteSpec = {
  dialect: Dialect;
  keyVar: keyof WorkerEnv;
  modelVar: keyof WorkerEnv;
  defaultModel: string;
  urlVar: keyof WorkerEnv;
  defaultUrl: string;
  /** Appended to the (possibly overridden) URL, for channels sharing one base. */
  pathSuffix?: string;
  effort: EffortSpec;
  /**
   * Pins the reasoning level regardless of what the user picked. Used for a
   * deliberately "always max" configuration of a model.
   */
  forceEffort?: EffortKey;
  /**
   * Floor on the reasoning level. For a model that is fine above a certain
   * effort but misreads diagrams below it, this keeps the cheap setting from
   * producing a confidently wrong answer.
   */
  minEffort?: EffortKey;
  /**
   * Ceiling on the reasoning level. For a model whose top levels think so
   * long that the request dies before an answer arrives, this keeps a level
   * the route cannot finish out of reach.
   */
  maxEffort?: EffortKey;
  /**
   * Set false when the upstream cannot stream and honour structured output at
   * the same time. Streaming only buys progress updates; a parseable answer
   * matters more, so such a channel always uses the non-streamed path.
   */
  streaming?: boolean;
  /**
   * Set false when the upstream cannot be forced to emit structured output.
   * The request then relies on the prompt plus the repair pipeline in
   * shared/solution.ts, instead of burning round trips discovering this.
   */
  structured?: boolean;
};

const POE_SPEC = {
  dialect: "responses" as const,
  keyVar: "POE_API_KEY" as const,
  urlVar: "POE_BASE_URL" as const,
  defaultUrl: "https://api.poe.com/v1/responses",
};

// OpenCode Go: one key, one base URL, three protocols. Which protocol a model
// speaks is fixed by the gateway (https://opencode.ai/docs/go/), so each route
// names its dialect and the path suffix; only the base is env-overridable.
const OPENCODE_SPEC = {
  keyVar: "OPENCODE_API_KEY" as const,
  urlVar: "OPENCODE_BASE_URL" as const,
  defaultUrl: "https://opencode.ai/zen/go/v1",
};

const ROUTES: Record<ProviderKey, Partial<Record<ChannelKey, RouteSpec>>> = {
  chatgpt: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "responses",
      pathSuffix: "/responses",
      modelVar: "OPENCODE_CHATGPT_MODEL",
      defaultModel: "gpt-5.6-luna",
      effort: OPENAI_EFFORT,
      // Luna is offered at "high" or "max" only: the user's pick is honoured
      // at those two levels and anything lower is raised to "high". "max" maps
      // to reasoning.effort "xhigh", which the gateway accepts.
      minEffort: "high",
    },
    poe: {
      ...POE_SPEC,
      modelVar: "POE_CHATGPT_MODEL",
      // Bot names come from GET https://api.poe.com/v1/models. Newest GPT-5.x
      // there is 5.4; `gpt-5.4-pro` is the stronger, slower sibling.
      defaultModel: "gpt-5.4",
      effort: OPENAI_EFFORT,
    },
  },
  claude: {
    poe: {
      ...POE_SPEC,
      modelVar: "POE_CLAUDE_MODEL",
      // Newest Opus on Poe. There is no Opus 5 bot there yet.
      defaultModel: "claude-opus-4.8",
      effort: CLAMPED_EFFORT,
    },
  },
  gemini: {
    poe: {
      ...POE_SPEC,
      modelVar: "POE_GEMINI_MODEL",
      defaultModel: "gemini-3.1-pro",
      effort: CLAMPED_EFFORT,
    },
    google: {
      dialect: "gemini",
      keyVar: "GOOGLE_API_KEY",
      modelVar: "GOOGLE_GEMINI_MODEL",
      // Real ids come from GET /v1beta/models. The Pro tier is preview-suffixed;
      // "gemini-3.1-pro" does not resolve.
      defaultModel: "gemini-3.1-pro-preview",
      urlVar: "GOOGLE_BASE_URL",
      defaultUrl: "https://generativelanguage.googleapis.com/v1beta",
      effort: GEMINI_BUDGET,
    },
  },
  deepseek: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "chat-completions",
      pathSuffix: "/chat/completions",
      modelVar: "OPENCODE_DEEPSEEK_MODEL",
      // Reads diagrams although OpenCode Go only documents
      // "deepseek-v4-flash-vision-exp" as vision. Measured on the B.8 fixture:
      // 4/5 correct (its one miss at "none") against 5/8 for -vision-exp,
      // and right at "high" where -vision-exp was 0/2. Probed with the
      // workspace's China-hosted-models opt-in ON; whether it needs that is
      // untested. "deepseek-v4-pro" and "deepseek-v4-flash" are text-only.
      defaultModel: "deepseek-v4.1-flash",
      effort: CLAMPED_EFFORT,
    },
  },
  grok: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "responses",
      pathSuffix: "/responses",
      modelVar: "OPENCODE_GROK_MODEL",
      defaultModel: "grok-4.6",
      effort: CLAMPED_EFFORT,
    },
  },
  mimo: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "chat-completions",
      pathSuffix: "/chat/completions",
      modelVar: "OPENCODE_MIMO_MODEL",
      // OpenCode Zen's free MiMo tier: the Zen catalogue lists it as
      // "mimo-v2.6-flash-free" and the Go gateway serves the same tier as
      // "mimo-v2.6-flash" (the paid sibling is "mimo-v2.6-pro"). Verified to
      // read the diagram: asked for the values shown in the B.8 image it
      // returned all six. Was "mimo-v2.5" until 22 September 2026.
      defaultModel: "mimo-v2.6-flash",
      effort: CLAMPED_EFFORT,
    },
  },
  minimax: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "chat-completions",
      pathSuffix: "/chat/completions",
      modelVar: "OPENCODE_MINIMAX_MODEL",
      // Back on 22 September 2026 after being dropped on 19 September (1/4 on
      // the B.8 fixture on its own API, where it thought itself out of tokens
      // at "high"). This is a different route: MiniMax's own channel is gone,
      // it runs on the Go subscription now, and "minimax-m3" is a newer model
      // than the "MiniMax-M2" that failed. Verified to read the diagram: all
      // six values from the B.8 image. "minimax-m2.7" and "minimax-m2.5" are
      // listed by the gateway but answer 503 "Endpoint is unavailable".
      // It wraps its reasoning in <think> tags inside the message content;
      // stripThinkTags in shared/solution.ts removes them before parsing.
      defaultModel: "minimax-m3",
      effort: CLAMPED_EFFORT,
      // Capped at "medium": at "high" it wrote 95,000 characters of thinking
      // and hit the 280 s safety timeout on both B.8 runs, where "low" and
      // "medium" answered correctly in 23-127 s.
      maxEffort: "medium",
    },
  },
  muse: {
    opencode: {
      ...OPENCODE_SPEC,
      dialect: "responses",
      pathSuffix: "/responses",
      modelVar: "OPENCODE_MUSE_MODEL",
      // The free "contributor" tier of Muse Spark: the workspace must opt in
      // to its data collection first, or the gateway answers 403
      // DataPolicyError. The docs' "-free" suffixed id is not supported on
      // the Go gateway. Verified to read the diagram after the opt-in: all
      // six values from the B.8 image.
      defaultModel: "muse-spark-1.3-contributor",
      effort: CLAMPED_EFFORT,
    },
  },
};

const DEFAULT_CHANNEL: Record<ProviderKey, ChannelKey> = {
  chatgpt: "opencode",
  claude: "poe",
  gemini: "poe",
  deepseek: "opencode",
  grok: "opencode",
  mimo: "opencode",
  minimax: "opencode",
  muse: "opencode",
};

const CHANNEL_VAR: Record<ProviderKey, keyof WorkerEnv> = {
  chatgpt: "CHATGPT_CHANNEL",
  claude: "CLAUDE_CHANNEL",
  gemini: "GEMINI_CHANNEL",
  deepseek: "DEEPSEEK_CHANNEL",
  grok: "GROK_CHANNEL",
  mimo: "MIMO_CHANNEL",
  minimax: "MINIMAX_CHANNEL",
  muse: "MUSE_CHANNEL",
};

export type Route = {
  provider: ProviderKey;
  channel: ChannelKey;
  dialect: Dialect;
  model: string;
  /**
   * Models to switch to, in order, when an attempt on `model` fails in a way
   * worth retrying (503, 429, a dropped stream, a useless fragment). Comes
   * from a comma-separated model var: "gemini-3.8-flash,gemini-3.5-flash"
   * tries 3.8 first and 3.5 if it does not answer. Switching model does not
   * spend the transient-retry budget - the fallback gets a fresh start.
   */
  fallbackModels: string[];
  endpoint: string;
  apiKey: string;
  effort: EffortSpec;
  /** Pinned reasoning level, overriding the user's choice. */
  forceEffort?: EffortKey;
  /** Floor on the reasoning level. */
  minEffort?: EffortKey;
  /** Ceiling on the reasoning level. */
  maxEffort?: EffortKey;
  /** False when the upstream cannot stream and keep structured output. */
  streaming: boolean;
  /** False when the upstream cannot be forced to emit structured output. */
  structured: boolean;
  /** "Claude (via Poe)" - used in every user-facing message. */
  label: string;
  configured: boolean;
  /** Non-empty when the route itself is misconfigured. */
  problem: string;
};

function readVar(env: WorkerEnv, name: keyof WorkerEnv) {
  const value = env[name];
  return typeof value === "string" ? value.trim() : "";
}

function channelFor(provider: ProviderKey, env: WorkerEnv) {
  const requested = readVar(env, CHANNEL_VAR[provider]).toLowerCase();
  if (!requested) {
    return { channel: DEFAULT_CHANNEL[provider], problem: "" };
  }
  if (!isChannelKey(requested)) {
    return {
      channel: DEFAULT_CHANNEL[provider],
      problem: `${CHANNEL_VAR[provider]} is set to "${requested}", which is not a known channel.`,
    };
  }
  return { channel: requested, problem: "" };
}

/**
 * Optional per-request route override. The interpretation pass uses it to pin
 * its providers to Poe top-tier models regardless of the solve-time channel.
 */
export type RouteOverride = { channel?: ChannelKey; model?: string };

export function resolveRoute(
  provider: ProviderKey,
  env: WorkerEnv,
  override?: RouteOverride,
): Route {
  const { channel, problem: channelProblem } = override?.channel
    ? { channel: override.channel, problem: "" }
    : channelFor(provider, env);
  const spec = ROUTES[provider][channel];

  if (!spec) {
    const supported = Object.keys(ROUTES[provider]).join(", ");
    return {
      provider,
      channel,
      dialect: "responses",
      model: "",
      fallbackModels: [],
      endpoint: "",
      apiKey: "",
      effort: { kind: "none" },
      streaming: false,
      structured: false,
      label: PROVIDER_LABELS[provider],
      configured: false,
      problem:
        channelProblem ||
        `${PROVIDER_LABELS[provider]} cannot be served over ${CHANNEL_LABELS[channel]}. Supported channels: ${supported}.`,
    };
  }

  const apiKey = readVar(env, spec.keyVar);
  // A model var may be a chain: primary first, fallbacks after.
  const [model, ...fallbackModels] = (
    override?.model ||
    readVar(env, spec.modelVar) ||
    spec.defaultModel
  )
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return {
    provider,
    channel,
    dialect: spec.dialect,
    model,
    fallbackModels,
    endpoint:
      (readVar(env, spec.urlVar) || spec.defaultUrl).replace(/\/$/, "") + (spec.pathSuffix || ""),
    apiKey,
    effort: spec.effort,
    forceEffort: spec.forceEffort,
    minEffort: spec.minEffort,
    maxEffort: spec.maxEffort,
    streaming: spec.streaming !== false,
    structured: spec.structured !== false,
    label: `${PROVIDER_LABELS[provider]} (via ${CHANNEL_LABELS[channel]})`,
    configured: Boolean(apiKey),
    problem:
      channelProblem || (apiKey ? "" : `${spec.keyVar} is not configured on the server.`),
  };
}

// Reading the diagram is a comprehension task where a misread poisons the
// solve, so the interpretation pass pins its providers to routes chosen for
// it rather than the solve-time channel. Only providers listed here are
// pinned; any other pick (DeepSeek, Muse Spark, ...) keeps its normal route.
//
// ChatGPT is pinned to gpt-5.6-luna on OpenCode Go - the default judge of
// the pass since 22 September 2026, at the owner's request (no Poe). It
// read on Poe's gpt-5.4-pro before that: correct, but the pro tier
// over-thinks a transcription task (~95 s vs ~5 s for Gemini) and bills the
// Poe account. To go back, set chatgpt to "poe" below and
// INTERPRET_CHATGPT_MODEL to a Poe bot id.
//
// Gemini reads on Google, free-tier Flash, with a model chain: 3.8-flash
// first, 3.5-flash when 3.8 is unavailable (it answered 503 "high demand" on
// four of six solves the day this was added; 3.5 was 3/3). If GOOGLE_API_KEY
// is not configured the reader falls back to the Poe pin so the pass keeps
// working.
const INTERPRET_MODEL_VAR: Partial<Record<ProviderKey, keyof WorkerEnv>> = {
  chatgpt: "INTERPRET_CHATGPT_MODEL",
  gemini: "INTERPRET_GEMINI_MODEL",
  claude: "INTERPRET_CLAUDE_MODEL",
};

const INTERPRET_MODEL_DEFAULT: Partial<Record<ProviderKey, string>> = {
  chatgpt: "gpt-5.6-luna",
  gemini: "gemini-3.8-flash,gemini-3.5-flash",
  claude: "claude-opus-4.8",
};

/** Where each pinned reader runs. Gemini needs its key; see interpretOverride. */
const INTERPRET_CHANNEL: Partial<Record<ProviderKey, ChannelKey>> = {
  chatgpt: "opencode",
  gemini: "google",
  claude: "poe",
};

const INTERPRET_GEMINI_POE_FALLBACK = "gemini-3.1-pro";

export function interpretOverride(
  provider: ProviderKey,
  env: WorkerEnv,
): RouteOverride | undefined {
  const channel = INTERPRET_CHANNEL[provider];
  if (!channel) return undefined;
  if (provider === "gemini" && !readVar(env, "GOOGLE_API_KEY")) {
    return { channel: "poe", model: INTERPRET_GEMINI_POE_FALLBACK };
  }
  const varName = INTERPRET_MODEL_VAR[provider];
  const model = (varName && readVar(env, varName)) || INTERPRET_MODEL_DEFAULT[provider];
  return model ? { channel, model } : undefined;
}

/** Health payload for one provider. Never exposes key values. */
export function routeStatus(provider: ProviderKey, env: WorkerEnv): ProviderStatus {
  const route = resolveRoute(provider, env);
  return {
    channel: route.channel,
    model: route.model,
    configured: route.configured && !route.problem,
    ...(route.forceEffort ? { forcedEffort: route.forceEffort } : {}),
    ...(route.minEffort ? { minEffort: route.minEffort } : {}),
    ...(route.maxEffort ? { maxEffort: route.maxEffort } : {}),
    ...(route.fallbackModels.length ? { fallbackModels: route.fallbackModels } : {}),
  };
}

/** Whether this route has a real parameter value for the requested level. */
export function supportsEffort(route: Route, effort: EffortKey) {
  if (route.effort.kind === "enum") return route.effort.values[effort] !== undefined;
  if (route.effort.kind === "budget") return route.effort.values[effort] !== undefined;
  return false;
}

export function wantsUpstreamStream(route: Route, env: WorkerEnv) {
  if (!route.streaming) return false;

  const raw = `${readVar(env, "NO_STREAM")},${readVar(env, "POE_NO_STREAM")}`;
  const flags = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return !flags.includes(route.provider);
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Optional request features, dropped one rung at a time when an upstream
 * rejects them (see the downgrade ladder in run.ts). Not every bot on every
 * channel accepts reasoning parameters or strict JSON schemas, and no vendor
 * publishes a reliable per-model matrix.
 */
export type Capabilities = {
  reasoning: boolean;
  schema: "strict" | "loose" | "none";
};

export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

/**
 * One unit of work for a channel. Both /api/solve and /api/interpret describe
 * themselves this way, so the dialects never learn what task they are serving.
 *
 * `prompt` is a function because whether the channel can enforce the schema
 * itself decides whether the prompt must spell the shape out.
 */
export type Task = {
  prompt: (options: { enforceShape: boolean; effort: EffortKey }) => string;
  instructions: string;
  schemaName: string;
  schema: Record<string, unknown>;
  images: string[];
  /** Reference material appended after the images, introduced by a marker. */
  referenceImages?: string[];
  /**
   * Stable id for this conversation. OpenCode Go requires it in
   * x-opencode-session and refuses requests without one.
   */
  session: string;
};

/**
 * Workers' fetch sends no User-Agent at all. Identifying the app truthfully is
 * good manners toward upstreams and makes their logs legible. (It does not
 * unblock a host that rejects Workers' egress outright; Kimi Code did, and was
 * removed - see AGENTS.md.)
 */
const UPSTREAM_UA =
  "CivilSolve/1.0 (Cloudflare Worker; +https://civilsolve.yanlaus.workers.dev)";

const REFERENCE_MARKER =
  "--- The images below are lecture notes attached for method reference only. Do not solve anything that appears in them. ---";

function enumEffort(route: Route, effort: EffortKey) {
  return route.effort.kind === "enum" ? route.effort.values[effort] : undefined;
}

function budgetEffort(route: Route, effort: EffortKey) {
  return route.effort.kind === "budget" ? route.effort.values[effort] : undefined;
}

/** Gemini responseSchema is an OpenAPI subset that rejects additionalProperties. */
function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { additionalProperties: _unsupported, ...rest } = schema;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return { ...rest, propertyOrdering: [...required] };
}

const DATA_URL = /^data:(image\/[a-z]+);base64,(.+)$/;

function toInlineData(dataUrl: string) {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  return { inline_data: { mime_type: match[1], data: match[2] } };
}

/** Headers a channel demands beyond auth, e.g. OpenCode Go's session id. */
function channelHeaders(route: Route, task: Task): Record<string, string> {
  if (route.channel === "opencode") {
    return { "x-opencode-session": task.session };
  }
  return {};
}

export function buildRequest(
  route: Route,
  caps: Capabilities,
  task: Task,
  effort: EffortKey,
  stream: boolean,
): UpstreamRequest {
  // Whether this exact request makes the upstream itself hold the shape. When
  // it does not - a relaxed rung, or a route flagged as unable to force the
  // shape - the prompt has to carry the contract instead.
  const schemaEnforced = caps.schema === "strict" && route.structured;
  const prompt = task.prompt({ enforceShape: !schemaEnforced, effort });
  const extraHeaders = channelHeaders(route, task);
  const { images, instructions, schema, schemaName } = task;
  const referenceImages = task.referenceImages || [];

  if (route.dialect === "gemini") {
    const generationConfig: Record<string, unknown> = {};
    if (caps.schema === "strict") {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = geminiSchema(schema);
    } else if (caps.schema === "loose") {
      generationConfig.responseMimeType = "application/json";
    }
    const budget = caps.reasoning ? budgetEffort(route, effort) : undefined;
    if (budget !== undefined) {
      generationConfig.thinkingConfig = { thinkingBudget: budget };
    }

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const image of images) {
      const inline = toInlineData(image);
      if (inline) parts.push(inline);
    }
    if (referenceImages.length) {
      parts.push({ text: REFERENCE_MARKER });
      for (const image of referenceImages) {
        const inline = toInlineData(image);
        if (inline) parts.push(inline);
      }
    }

    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${route.endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(route.model)}:${method}`,
      headers: {
        // Header auth, never a query parameter - keys must not land in URLs.
        "x-goog-api-key": route.apiKey,
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_UA,
        ...extraHeaders,
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: [{ role: "user", parts }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }),
    };
  }

  if (route.dialect === "chat-completions") {
    const chatBody: Record<string, unknown> = {
      model: route.model,
      messages: [
        { role: "system", content: instructions },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
            ...(referenceImages.length
              ? [
                  { type: "text", text: REFERENCE_MARKER },
                  ...referenceImages.map((url) => ({
                    type: "image_url",
                    image_url: { url },
                  })),
                ]
              : []),
          ],
        },
      ],
    };
    if (caps.schema === "strict") {
      chatBody.response_format = {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      };
    } else if (caps.schema === "loose") {
      chatBody.response_format = { type: "json_object" };
    }
    const chatEffort = caps.reasoning ? enumEffort(route, effort) : undefined;
    if (chatEffort) chatBody.reasoning_effort = chatEffort;
    if (stream) chatBody.stream = true;

    return {
      url: route.endpoint,
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": UPSTREAM_UA,
        ...extraHeaders,
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(chatBody),
    };
  }

  // dialect === "responses" (Poe)
  const body: Record<string, unknown> = {
    model: route.model,
    instructions,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((url) => ({ type: "input_image", image_url: url })),
          ...(referenceImages.length
            ? [
                { type: "input_text", text: REFERENCE_MARKER },
                ...referenceImages.map((url) => ({
                  type: "input_image",
                  image_url: url,
                })),
              ]
            : []),
        ],
      },
    ],
  };
  if (caps.schema === "strict") {
    body.text = {
      format: { type: "json_schema", name: schemaName, strict: true, schema },
    };
  } else if (caps.schema === "loose") {
    body.text = { format: { type: "json_object" } };
  }
  const responsesEffort = caps.reasoning ? enumEffort(route, effort) : undefined;
  if (responsesEffort) body.reasoning = { effort: responsesEffort };
  if (stream) body.stream = true;

  return {
    url: route.endpoint,
    headers: {
      Authorization: `Bearer ${route.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": UPSTREAM_UA,
      ...extraHeaders,
      ...(stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * True for a raw SSE payload that can be dropped without parsing: a frame
 * that can only ever carry the model's reasoning, never answer text, never
 * completion, never an error. On a thinking model these outnumber the answer
 * frames several to one, and JSON.parse on each is CPU the Worker is short of.
 *
 * Substring tests only. Anything ambiguous falls through to the full parse.
 */
export function isReasoningOnlyFrame(dialect: Dialect, data: string): boolean {
  if (dialect === "responses") {
    return /"type"\s*:\s*"response\.reasoning/.test(data);
  }
  if (dialect === "chat-completions") {
    // {"delta":{"reasoning_content":"..."}} - but never a frame that also has
    // answer content, an error object, or a real finish_reason (every chunk
    // carries `"finish_reason":null`; only a string value is a terminal, and
    // that must reach the parser).
    return (
      data.includes('"reasoning_content"') &&
      !/"content"\s*:\s*"/.test(data) &&
      !data.includes('"error"') &&
      !/"finish_reason"\s*:\s*"/.test(data)
    );
  }
  return false;
}

/**
 * Whether this frame is the upstream's own end-of-response marker. Tracked so
 * a stream that simply stops - no terminal, no error, nothing accumulated -
 * can be told apart from a completed-but-empty answer. Measured on OpenCode
 * Go (on a Kimi route since removed, but the gateway is the same): 20,725
 * characters of reasoning streamed over 128 s, then the connection closed
 * mid-word with no finish_reason and no [DONE]. That is a dropped connection,
 * not a model decision, and run.ts retries it at the same effort rather than
 * stepping down.
 */
export function isTerminalFrame(dialect: Dialect, event: Record<string, unknown>): boolean {
  if (dialect === "responses") {
    return (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    );
  }
  if (dialect === "chat-completions") {
    return Boolean(readString(asRecord(asArray(event.choices)[0]), "finish_reason"));
  }
  // gemini: a candidate carrying finishReason.
  return asArray(event.candidates).some((c) => Boolean(readString(asRecord(c), "finishReason")));
}

/** SSE payload that ends the stream, if the dialect uses one. */
export function streamTerminator(dialect: Dialect) {
  return dialect === "gemini" ? null : "[DONE]";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown> | null, key: string) {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** Concatenates the visible (non-thinking) text parts of a Gemini payload. */
function geminiText(payload: Record<string, unknown>) {
  const texts: string[] = [];
  for (const candidate of asArray(payload.candidates)) {
    const content = asRecord(asRecord(candidate)?.content);
    for (const part of asArray(content?.parts)) {
      const record = asRecord(part);
      if (!record) continue;
      // Thinking parts are flagged; they are never part of the answer.
      if (record.thought === true) continue;
      if (typeof record.text === "string") texts.push(record.text);
    }
  }
  return texts.join("");
}

/**
 * Text fragment carried by one upstream stream event, or "" when the event is
 * not visible output (reasoning summaries, tool-call arguments, bookkeeping).
 *
 * This filter matters: reasoning deltas concatenated into the answer corrupt
 * the JSON the parser expects, and they get more frequent the higher the
 * requested effort.
 */
export function extractDelta(dialect: Dialect, event: Record<string, unknown>): string {
  if (dialect === "responses") {
    // Only visible output. NOT every "*.delta" event: response.reasoning_
    // summary_text.delta and response.function_call_arguments.delta also
    // carry a string `delta`.
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return event.delta;
    }
    return "";
  }

  if (dialect === "chat-completions") {
    const choice = asRecord(asArray(event.choices)[0]);
    const delta = asRecord(choice?.delta);
    // `reasoning_content` is thinking, not answer text - deliberately ignored.
    return readString(delta, "content");
  }

  return geminiText(event);
}

/** Final text from a completed (streamed or non-streamed) payload. */
export function extractFinalText(dialect: Dialect, payload: Record<string, unknown>): string {
  if (dialect === "gemini") {
    return geminiText(payload).trim();
  }

  if (dialect === "chat-completions") {
    const choice = asRecord(asArray(payload.choices)[0]);
    const message = asRecord(choice?.message);
    const content = readString(message, "content");
    if (content.trim()) return content.trim();
    // Some servers return the streamed shape on the final frame.
    return readString(asRecord(choice?.delta), "content").trim();
  }

  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const texts: string[] = [];
  for (const item of asArray(payload.output)) {
    const record = asRecord(item);
    if (!record) continue;
    // Skip reasoning items outright; only message content holds the answer.
    if (typeof record.type === "string" && record.type !== "message") continue;
    for (const part of asArray(record.content)) {
      const piece = asRecord(part);
      if (!piece) continue;
      const type = typeof piece.type === "string" ? piece.type : "output_text";
      if (type !== "output_text") continue;
      if (typeof piece.text === "string" && piece.text.trim()) texts.push(piece.text);
    }
  }
  return texts.join("\n").trim();
}

/**
 * True when the model spent every output token it had on thinking and never
 * wrote an answer. Each dialect reports it differently:
 *
 *   responses         status "incomplete" with incomplete_details.reason
 *                     "max_output_tokens", no output_text in the response
 *   chat-completions  finish_reason "length" with no content
 *
 * Measured on OpenCode Go, where the worker sends no output cap and the
 * gateway's own default is the ceiling: a gpt-5.6-luna run that succeeded
 * used 16,343 output tokens, of which 11,912 were reasoning - 41 short of
 * 16,384. Any run that thinks slightly harder is cut mid-reasoning with no
 * message item at all. Raising the cap does not reliably help (on the
 * since-removed MiniMax route the model simply thought longer to fill the
 * room, and drifted to a wrong answer), so run.ts treats this as a signal to
 * retry one effort level down.
 *
 * A truncated answer is still an answer, so this requires the payload to carry
 * no usable content. A streamed terminal frame (a chat-completions chunk
 * carrying only `finish_reason`) has no content to inspect, and fetchStreamed
 * only consults this once nothing has accumulated, so the same guard holds on
 * both paths. A frame that does carry content is consumed by extractDelta
 * before this is ever reached.
 */
export function isThinkingExhausted(
  dialect: Dialect,
  payload: Record<string, unknown>,
): boolean {
  if (!hitOutputCap(dialect, payload)) return false;
  if (dialect === "responses") {
    return !extractFinalText("responses", asRecord(payload.response) ?? payload);
  }
  return !extractFinalText(dialect, payload);
}

/**
 * Whether this frame or payload says the model stopped because it ran out of
 * output tokens - regardless of whether any answer text came first. With no
 * text it is thinking exhaustion (above). With some text it is a truncated
 * answer, which run.ts hands to the task's parser: usable, it is delivered;
 * useless, the request is retried one effort level down, since less thinking
 * is what leaves room for the answer.
 */
export function hitOutputCap(dialect: Dialect, payload: Record<string, unknown>): boolean {
  if (dialect === "responses") {
    // Streamed: a `response.incomplete` event wrapping the response object.
    // Non-streamed: the response object itself.
    const response = asRecord(payload.response) ?? payload;
    return (
      readString(response, "status") === "incomplete" &&
      readString(asRecord(response.incomplete_details), "reason") === "max_output_tokens"
    );
  }
  if (dialect === "chat-completions") {
    return readString(asRecord(asArray(payload.choices)[0]), "finish_reason") === "length";
  }
  return false;
}

/**
 * Error reported inside an otherwise successful payload or stream event.
 * Some gateways answer HTTP 200 with the failure in the body.
 */
export function extractPayloadError(dialect: Dialect, payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  if (error) {
    const message = readString(error, "message");
    if (message) return message;
  }

  if (dialect === "responses") {
    if (payload.type === "response.failed" || payload.type === "error") {
      const nested = asRecord(asRecord(payload.response)?.error);
      return (
        readString(nested, "message") ||
        readString(payload, "message") ||
        "The provider reported a stream failure."
      );
    }
  }

  if (isThinkingExhausted(dialect, payload)) {
    return "the model used its whole token budget thinking and never wrote an answer.";
  }

  if (dialect === "gemini") {
    const feedback = asRecord(payload.promptFeedback);
    const blocked = readString(feedback, "blockReason");
    if (blocked) return `The provider blocked the request (${blocked}).`;
    for (const candidate of asArray(payload.candidates)) {
      const reason = readString(asRecord(candidate), "finishReason");
      if (reason && reason !== "STOP" && reason !== "MAX_TOKENS") {
        return `The provider stopped early (${reason}).`;
      }
    }
  }

  return "";
}

/** Payload carrying the finished response inside a stream, if any. */
export function extractCompleted(
  dialect: Dialect,
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (dialect !== "responses") return null;
  if (event.type !== "response.completed") return null;
  return asRecord(event.response);
}
