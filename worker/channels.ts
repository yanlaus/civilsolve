// Upstream channel adapters.
//
// Every provider is reached through exactly one "channel" (Poe, Moonshot,
// MiniMax, Google), resolved from env at request time. Channels speak three
// different API dialects, so this module owns:
//
//   - route resolution (which channel/model/key/endpoint for a provider)
//   - request building per dialect, including the reasoning-effort parameter
//   - upstream stream/payload parsing per dialect
//
// worker/solve.ts stays dialect-agnostic and only orchestrates.

import { buildTutorPrompt, SOLVE_INSTRUCTIONS, type EffortKey } from "../shared/prompt";
import {
  CHANNEL_LABELS,
  isChannelKey,
  PROVIDER_LABELS,
  type ChannelKey,
  type ProviderKey,
  type ProviderStatus,
} from "../shared/providers";
import { solutionSchema } from "../shared/solution";

export type Dialect = "responses" | "chat-completions" | "gemini" | "anthropic";

export type WorkerEnv = {
  // --- Secrets: one per upstream account ---------------------------------
  POE_API_KEY?: string;
  KIMI_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  MINIMAX_API_KEY?: string;
  GOOGLE_API_KEY?: string;

  // --- Channel routing: which account serves each provider ---------------
  CHATGPT_CHANNEL?: string;
  CLAUDE_CHANNEL?: string;
  GEMINI_CHANNEL?: string;
  KIMI_CHANNEL?: string;
  MINIMAX_CHANNEL?: string;

  // --- Model overrides ---------------------------------------------------
  POE_CHATGPT_MODEL?: string;
  POE_CLAUDE_MODEL?: string;
  POE_GEMINI_MODEL?: string;
  GOOGLE_GEMINI_MODEL?: string;
  KIMI_CODE_MODEL?: string;
  MOONSHOT_KIMI_MODEL?: string;
  MINIMAX_MODEL?: string;

  // --- Endpoint overrides (mainland vs global hosts, proxies) ------------
  POE_BASE_URL?: string;
  KIMI_BASE_URL?: string;
  MOONSHOT_BASE_URL?: string;
  MINIMAX_BASE_URL?: string;
  GOOGLE_BASE_URL?: string;

  // --- Behaviour ---------------------------------------------------------
  // Comma-separated provider keys that should use a non-streamed upstream
  // fetch (still delivered over the same SSE response), e.g. "kimi,minimax".
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

// Anthropic extended-thinking budgets. Capped lower than Gemini because
// max_tokens must exceed the budget and these gateways cap total output.
const ANTHROPIC_BUDGET: EffortSpec = {
  kind: "budget",
  values: { low: 2048, medium: 8192, high: 16384, max: 24576 },
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
  effort: EffortSpec;
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

const ROUTES: Record<ProviderKey, Partial<Record<ChannelKey, RouteSpec>>> = {
  chatgpt: {
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
      defaultModel: "gemini-3.1-pro",
      urlVar: "GOOGLE_BASE_URL",
      defaultUrl: "https://generativelanguage.googleapis.com/v1beta",
      effort: GEMINI_BUDGET,
    },
  },
  kimi: {
    // Kimi Code subscription ("token plan"), Anthropic-protocol endpoint.
    kimi: {
      dialect: "anthropic",
      keyVar: "KIMI_API_KEY",
      modelVar: "KIMI_CODE_MODEL",
      // Tier-dependent: kimi-for-coding, kimi-for-coding-highspeed, k3, k3-256k.
      defaultModel: "kimi-for-coding",
      urlVar: "KIMI_BASE_URL",
      defaultUrl: "https://api.kimi.com/coding",
      effort: ANTHROPIC_BUDGET,
      // Thinking is always on for these models, and the gateway rejects any
      // forced tool_choice while it is: "tool_choice 'specified' is
      // incompatible with thinking enabled". So never offer forced tools -
      // the prompt plus the repair pipeline carry the JSON instead.
      structured: false,
    },
    // Moonshot open platform, pay-as-you-go. Different account and key.
    moonshot: {
      dialect: "chat-completions",
      keyVar: "MOONSHOT_API_KEY",
      modelVar: "MOONSHOT_KIMI_MODEL",
      // Must be a vision-capable model: the assignment arrives as images.
      defaultModel: "kimi-latest",
      urlVar: "MOONSHOT_BASE_URL",
      // Mainland host. Global deployments use https://api.moonshot.ai/v1/...
      defaultUrl: "https://api.moonshot.cn/v1/chat/completions",
      effort: CLAMPED_EFFORT,
    },
  },
  minimax: {
    minimax: {
      dialect: "anthropic",
      keyVar: "MINIMAX_API_KEY",
      modelVar: "MINIMAX_MODEL",
      // M3 reads images. Note that M2/M2.1 do not, and answer "I cannot view
      // the image" instead of failing - they would invent solutions. Verify
      // vision before changing this. "MiniMax-M3[1m]" selects 1M context.
      defaultModel: "MiniMax-M3",
      urlVar: "MINIMAX_BASE_URL",
      // Mainland host. International deployments use https://api.minimax.io.
      defaultUrl: "https://api.minimaxi.com/anthropic",
      effort: ANTHROPIC_BUDGET,
    },
  },
};

const DEFAULT_CHANNEL: Record<ProviderKey, ChannelKey> = {
  chatgpt: "poe",
  claude: "poe",
  gemini: "poe",
  kimi: "kimi",
  minimax: "minimax",
};

const CHANNEL_VAR: Record<ProviderKey, keyof WorkerEnv> = {
  chatgpt: "CHATGPT_CHANNEL",
  claude: "CLAUDE_CHANNEL",
  gemini: "GEMINI_CHANNEL",
  kimi: "KIMI_CHANNEL",
  minimax: "MINIMAX_CHANNEL",
};

export type Route = {
  provider: ProviderKey;
  channel: ChannelKey;
  dialect: Dialect;
  model: string;
  endpoint: string;
  apiKey: string;
  effort: EffortSpec;
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

export function resolveRoute(provider: ProviderKey, env: WorkerEnv): Route {
  const { channel, problem: channelProblem } = channelFor(provider, env);
  const spec = ROUTES[provider][channel];

  if (!spec) {
    const supported = Object.keys(ROUTES[provider]).join(", ");
    return {
      provider,
      channel,
      dialect: "responses",
      model: "",
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
  return {
    provider,
    channel,
    dialect: spec.dialect,
    model: readVar(env, spec.modelVar) || spec.defaultModel,
    endpoint: readVar(env, spec.urlVar) || spec.defaultUrl,
    apiKey,
    effort: spec.effort,
    streaming: spec.streaming !== false,
    structured: spec.structured !== false,
    label: `${PROVIDER_LABELS[provider]} (via ${CHANNEL_LABELS[channel]})`,
    configured: Boolean(apiKey),
    problem:
      channelProblem || (apiKey ? "" : `${spec.keyVar} is not configured on the server.`),
  };
}

/** Health payload for one provider. Never exposes key values. */
export function routeStatus(provider: ProviderKey, env: WorkerEnv): ProviderStatus {
  const route = resolveRoute(provider, env);
  return {
    channel: route.channel,
    model: route.model,
    configured: route.configured && !route.problem,
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
 * rejects them (see the downgrade ladder in solve.ts). Not every bot on every
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

const SCHEMA_NAME = "civil_solution";

function enumEffort(route: Route, effort: EffortKey) {
  return route.effort.kind === "enum" ? route.effort.values[effort] : undefined;
}

function budgetEffort(route: Route, effort: EffortKey) {
  return route.effort.kind === "budget" ? route.effort.values[effort] : undefined;
}

/** Gemini responseSchema is an OpenAPI subset that rejects additionalProperties. */
function geminiSchema(): Record<string, unknown> {
  const { additionalProperties: _unsupported, ...rest } = solutionSchema;
  return { ...rest, propertyOrdering: [...solutionSchema.required] };
}

const DATA_URL = /^data:(image\/[a-z]+);base64,(.+)$/;

function toInlineData(dataUrl: string) {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  return { inline_data: { mime_type: match[1], data: match[2] } };
}

function toAnthropicImage(dataUrl: string) {
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
}

/** Room for the answer itself, on top of any extended-thinking budget. */
const ANTHROPIC_ANSWER_TOKENS = 8192;

export function buildRequest(
  route: Route,
  caps: Capabilities,
  images: string[],
  notes: string,
  effort: EffortKey,
  stream: boolean,
): UpstreamRequest {
  // Whether this exact request makes the upstream itself hold the shape. When
  // it does not - a relaxed rung, or a gateway that cannot force tools - the
  // prompt has to carry the contract instead.
  const schemaEnforced =
    caps.schema === "strict" && (route.dialect !== "anthropic" || route.structured);
  const prompt = buildTutorPrompt(notes, effort, { enforceShape: !schemaEnforced });

  if (route.dialect === "anthropic") {
    const budget = caps.reasoning ? budgetEffort(route, effort) : undefined;

    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    for (const image of images) {
      const block = toAnthropicImage(image);
      if (block) content.push(block);
    }

    const body: Record<string, unknown> = {
      model: route.model,
      // Required by the Messages API, and it must exceed the thinking budget.
      max_tokens: (budget ?? 0) + ANTHROPIC_ANSWER_TOKENS,
      system: SOLVE_INSTRUCTIONS,
      messages: [{ role: "user", content }],
    };

    // The Messages API has no response_format. Structured output comes from a
    // forced tool call, where the gateway allows one.
    if (caps.schema === "strict" && route.structured) {
      body.tools = [
        {
          name: SCHEMA_NAME,
          description: "Return the worked solution using exactly these fields.",
          input_schema: solutionSchema,
        },
      ];
      body.tool_choice = { type: "tool", name: SCHEMA_NAME };
    }
    if (budget !== undefined) {
      body.thinking = { type: "enabled", budget_tokens: budget };
    }
    if (stream) body.stream = true;

    return {
      url: `${route.endpoint.replace(/\/$/, "")}/v1/messages`,
      headers: {
        // Both gateways also accept `Authorization: Bearer`, but x-api-key is
        // the canonical Anthropic header and works on both.
        "x-api-key": route.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(body),
    };
  }

  if (route.dialect === "gemini") {
    const generationConfig: Record<string, unknown> = {};
    if (caps.schema === "strict") {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = geminiSchema();
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

    const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
    return {
      url: `${route.endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(route.model)}:${method}`,
      headers: {
        // Header auth, never a query parameter - keys must not land in URLs.
        "x-goog-api-key": route.apiKey,
        "Content-Type": "application/json",
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SOLVE_INSTRUCTIONS }] },
        contents: [{ role: "user", parts }],
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      }),
    };
  }

  if (route.dialect === "chat-completions") {
    const chatBody: Record<string, unknown> = {
      model: route.model,
      messages: [
        { role: "system", content: SOLVE_INSTRUCTIONS },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ],
    };
    if (caps.schema === "strict") {
      chatBody.response_format = {
        type: "json_schema",
        json_schema: { name: SCHEMA_NAME, strict: true, schema: solutionSchema },
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
        ...(stream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify(chatBody),
    };
  }

  // dialect === "responses" (Poe)
  const body: Record<string, unknown> = {
    model: route.model,
    instructions: SOLVE_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((url) => ({ type: "input_image", image_url: url })),
        ],
      },
    ],
  };
  if (caps.schema === "strict") {
    body.text = {
      format: { type: "json_schema", name: SCHEMA_NAME, strict: true, schema: solutionSchema },
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
      ...(stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** SSE payload that ends the stream, if the dialect uses one. */
export function streamTerminator(dialect: Dialect) {
  return dialect === "gemini" || dialect === "anthropic" ? null : "[DONE]";
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

  if (dialect === "anthropic") {
    if (event.type !== "content_block_delta") return "";
    const delta = asRecord(event.delta);
    // Only text_delta. thinking_delta and signature_delta carry the model's
    // reasoning, which must never be concatenated into the answer.
    return readString(delta, "type") === "text_delta" ? readString(delta, "text") : "";
  }

  return geminiText(event);
}

/**
 * Fragment of a forced structured result, streamed separately from prose.
 * Anthropic sends a tool call's arguments as `input_json_delta` fragments; the
 * same response may also contain plain text blocks, so the two are collected
 * apart and the structured one wins.
 */
export function extractStructuredDelta(
  dialect: Dialect,
  event: Record<string, unknown>,
): string {
  if (dialect !== "anthropic") return "";
  if (event.type !== "content_block_delta") return "";
  const delta = asRecord(event.delta);
  return readString(delta, "type") === "input_json_delta"
    ? readString(delta, "partial_json")
    : "";
}

/** Final text from a completed (streamed or non-streamed) payload. */
export function extractFinalText(dialect: Dialect, payload: Record<string, unknown>): string {
  if (dialect === "gemini") {
    return geminiText(payload).trim();
  }

  if (dialect === "anthropic") {
    const blocks = asArray(payload.content);
    // A forced tool call is the structured answer; a response can carry both a
    // prose block and the tool block, and the tool block is authoritative.
    for (const block of blocks) {
      const record = asRecord(block);
      if (record?.type === "tool_use" && asRecord(record.input)) {
        return JSON.stringify(record.input);
      }
    }
    const texts: string[] = [];
    for (const block of blocks) {
      const record = asRecord(block);
      // "thinking" and "redacted_thinking" blocks are reasoning, not answer.
      if (record?.type === "text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
    return texts.join("").trim();
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
 * Error reported inside an otherwise successful payload or stream event.
 * MiniMax in particular answers HTTP 200 with a non-zero `base_resp.status_code`.
 */
export function extractPayloadError(dialect: Dialect, payload: Record<string, unknown>): string {
  const error = asRecord(payload.error);
  if (error) {
    const message = readString(error, "message");
    if (message) return message;
  }

  const baseResp = asRecord(payload.base_resp);
  if (baseResp && typeof baseResp.status_code === "number" && baseResp.status_code !== 0) {
    return readString(baseResp, "status_msg") || `Upstream error ${baseResp.status_code}.`;
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
