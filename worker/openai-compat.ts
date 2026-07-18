// Shared upstream for providers speaking the OpenAI chat-completions
// protocol (Kimi Code / Moonshot, MiniMax). Endpoint, model, and key come
// from per-provider env config resolved in upstream.ts.

import {
  readSseDataLines,
  REFERENCE_IMAGES_MARKER,
  type UpstreamParams,
} from "./upstream";

export type OpenAiCompatConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export async function callOpenAiCompat(
  config: OpenAiCompatConfig,
  params: UpstreamParams,
) {
  const baseUrl = config.baseUrl.replace(/\/$/, "");

  const userContent: Array<Record<string, unknown>> = [
    { type: "text", text: params.prompt },
    ...params.images.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  if (params.referenceImages?.length) {
    userContent.push({ type: "text", text: REFERENCE_IMAGES_MARKER });
    userContent.push(
      ...params.referenceImages.map((url) => ({ type: "image_url", image_url: { url } })),
    );
  }

  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: [
      {
        role: "system",
        content: `${params.instructions}\nThe JSON object must match this schema exactly:\n${JSON.stringify(params.schema)}`,
      },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  };

  try {
    return await fetchChatCompletion(baseUrl, config.apiKey, requestBody, params);
  } catch (error) {
    // Some OpenAI-compatible endpoints reject response_format; the shared
    // repair pipeline copes with free-form JSON, so retry once without it.
    if (error instanceof Error && /response_format/i.test(error.message)) {
      const { response_format: _dropped, ...withoutFormat } = requestBody;
      return fetchChatCompletion(baseUrl, config.apiKey, withoutFormat, params);
    }
    throw error;
  }
}

async function fetchChatCompletion(
  baseUrl: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  params: UpstreamParams,
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Workers' fetch sends no UA by default; some WAF rules reject
      // anonymous datacenter traffic. Identify the app truthfully.
      "User-Agent": "CivilSolve/1.0 (Cloudflare Worker; +https://civilsolve.yanlaus.workers.dev)",
      Accept: params.wantStream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(
      params.wantStream ? { ...requestBody, stream: true } : requestBody,
    ),
    signal: params.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  if (!params.wantStream) {
    const payload = (await response.json()) as Record<string, unknown>;
    return extractChatText(payload);
  }

  if (!response.body) {
    throw new Error("Upstream returned no response body.");
  }

  let accumulated = "";
  let upstreamError = "";

  for await (const data of readSseDataLines(response.body)) {
    if (data === "[DONE]") break;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
    if (choice && typeof choice === "object") {
      const delta = (choice as Record<string, unknown>).delta;
      if (delta && typeof delta === "object") {
        const text = (delta as Record<string, unknown>).content;
        if (typeof text === "string" && text) {
          accumulated += text;
          await params.onDelta(text);
        }
      }
    }

    const error = event.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message) {
        upstreamError = message;
      }
    }
  }

  if (!accumulated && upstreamError) {
    throw new Error(upstreamError);
  }

  return accumulated;
}

function extractChatText(payload: Record<string, unknown>) {
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (choice && typeof choice === "object") {
    const message = (choice as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") {
        return content.trim();
      }
    }
  }
  return "";
}
