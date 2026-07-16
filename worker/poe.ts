// Poe Responses API upstream for the codex/claude/gemini providers.

import type { ProviderKey } from "../shared/solution";
import {
  readSseDataLines,
  REFERENCE_IMAGES_MARKER,
  type UpstreamParams,
  type WorkerEnv,
} from "./upstream";

const POE_RESPONSES_URL = "https://api.poe.com/v1/responses";

const DEFAULT_MODELS: Record<Exclude<ProviderKey, "kimi">, string> = {
  codex: "GPT-5.2",
  claude: "Claude-Sonnet-4.6",
  gemini: "Gemini-3.1-Pro",
};

function modelFor(provider: Exclude<ProviderKey, "kimi">, env: WorkerEnv) {
  const override =
    provider === "codex"
      ? env.POE_CODEX_MODEL
      : provider === "claude"
        ? env.POE_CLAUDE_MODEL
        : env.POE_GEMINI_MODEL;
  return override?.trim() || DEFAULT_MODELS[provider];
}

export async function callPoe(provider: ProviderKey, params: UpstreamParams) {
  if (provider === "kimi") {
    throw new Error("kimi is not a Poe provider.");
  }
  const apiKey = params.env.POE_API_KEY?.trim() || "";

  const content: Array<Record<string, unknown>> = [
    { type: "input_text", text: params.prompt },
    ...params.images.map((url) => ({ type: "input_image", image_url: url })),
  ];
  if (params.referenceImages?.length) {
    content.push({ type: "input_text", text: REFERENCE_IMAGES_MARKER });
    content.push(
      ...params.referenceImages.map((url) => ({ type: "input_image", image_url: url })),
    );
  }

  const requestBody: Record<string, unknown> = {
    model: modelFor(provider, params.env),
    instructions: params.instructions,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: params.schemaName,
        strict: true,
        schema: params.schema,
      },
    },
  };

  return params.wantStream
    ? fetchStreamed(apiKey, requestBody, params.signal, params.onDelta)
    : fetchNonStreamed(apiKey, requestBody, params.signal);
}

async function fetchNonStreamed(
  apiKey: string,
  requestBody: Record<string, unknown>,
  signal: AbortSignal,
) {
  const response = await fetch(POE_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return extractTextOutput(payload);
}

async function fetchStreamed(
  apiKey: string,
  requestBody: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (delta: string) => Promise<void>,
) {
  const response = await fetch(POE_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }
  if (!response.body) {
    throw new Error("Upstream returned no response body.");
  }

  let accumulated = "";
  let completedText = "";
  let upstreamError = "";

  for await (const data of readSseDataLines(response.body)) {
    if (data === "[DONE]") break;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof event.type === "string" ? event.type : "";

    if (type.endsWith(".delta") && typeof event.delta === "string") {
      accumulated += event.delta;
      await onDelta(event.delta);
    } else if (type === "response.completed" && event.response && typeof event.response === "object") {
      completedText = extractTextOutput(event.response as Record<string, unknown>);
    } else if (type === "response.failed" || type === "error") {
      upstreamError =
        readErrorMessage(event) || "The provider reported a stream failure.";
    }
  }

  if (!accumulated && !completedText && upstreamError) {
    throw new Error(upstreamError);
  }

  return completedText || accumulated;
}

function extractTextOutput(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const piece = part as Record<string, unknown>;
      if (typeof piece.text === "string" && piece.text.trim()) {
        texts.push(piece.text);
      }
    }
  }

  return texts.join("\n").trim();
}

function readErrorMessage(event: Record<string, unknown>) {
  const error = event.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (typeof event.message === "string") return event.message;
  const response = event.response;
  if (response && typeof response === "object") {
    const nested = (response as Record<string, unknown>).error;
    if (nested && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
  }
  return "";
}
