// Kimi upstream over the OpenAI-compatible chat-completions protocol.
// Default endpoint is Kimi Code (api.kimi.com/coding/v1); KIMI_API_URL can
// point at a Moonshot platform key's endpoint (api.moonshot.ai/v1) instead.

import {
  readSseDataLines,
  REFERENCE_IMAGES_MARKER,
  type UpstreamParams,
} from "./upstream";

const DEFAULT_KIMI_API_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_KIMI_MODEL = "kimi-for-coding";

export async function callKimi(params: UpstreamParams) {
  const apiKey = params.env.KIMI_API_KEY?.trim() || "";
  const baseUrl = (params.env.KIMI_API_URL?.trim() || DEFAULT_KIMI_API_URL).replace(/\/$/, "");
  const model = params.env.KIMI_MODEL?.trim() || DEFAULT_KIMI_MODEL;

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
    model,
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
    return await fetchChatCompletion(baseUrl, apiKey, requestBody, params);
  } catch (error) {
    // Some OpenAI-compatible endpoints reject response_format; the shared
    // repair pipeline copes with free-form JSON, so retry once without it.
    if (error instanceof Error && /response_format/i.test(error.message)) {
      const { response_format: _dropped, ...withoutFormat } = requestBody;
      return fetchChatCompletion(baseUrl, apiKey, withoutFormat, params);
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
      ...(params.wantStream ? { Accept: "text/event-stream" } : {}),
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
