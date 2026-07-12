const API_URL = "https://api.zo.computer/zo/ask";
const REQUEST_TIMEOUT = 240000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 3000;

interface ZoRequestData {
  input: string;
  output_format?: Record<string, unknown>;
  conversation_id?: string;
  model_name?: string;
}

interface ZoResponse {
  output: unknown;
  conversation_id?: string;
  [key: string]: unknown;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number) {
  return RETRY_DELAY * 2 ** attempt;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      /aborted|timed out|timeout/i.test(error.message))
  );
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function normalizeZoOutputError(output: unknown) {
  if (typeof output !== "string") return null;
  const text = output.trim();
  if (!text) return null;

  const looksLikeError =
    /^error[:\s]/i.test(text) ||
    /all sessions are busy|temporarily unavailable|rate limit|try again/i.test(text);

  if (!looksLikeError) return null;

  const condensed = text.replace(/\s+/g, " ").trim();
  return {
    raw: condensed,
    retryable: /all sessions are busy|temporarily unavailable|rate limit/i.test(condensed),
    message: /all sessions are busy/i.test(condensed)
      ? "Zo Codex is temporarily busy right now. Please retry in a moment."
      : condensed,
  };
}

export async function callZo(
  input: string,
  options?: {
    outputFormat?: Record<string, unknown>;
    conversationId?: string;
    token?: string;
    modelName?: string;
  },
): Promise<ZoResponse> {
  const token = options?.token ?? process.env.ZO_CLIENT_IDENTITY_TOKEN;
  const modelName =
    options?.modelName ?? "byok:5cc41ec1-6b63-4f83-897a-2c15e958361d";

  if (!token) {
    throw new Error("ZO_CLIENT_IDENTITY_TOKEN is required");
  }

  const data: ZoRequestData = { input, model_name: modelName };
  if (options?.outputFormat) {
    data.output_format = options.outputFormat;
  }
  if (options?.conversationId) {
    data.conversation_id = options.conversationId;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => {
        controller.abort(
          new Error(
            `Zo model request timed out after ${Math.round(REQUEST_TIMEOUT / 1000)} seconds.`,
          ),
        );
      }, REQUEST_TIMEOUT);

      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          authorization: token,
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      if (response.ok) {
        const payload = (await response.json()) as ZoResponse;
        const outputError = normalizeZoOutputError(payload.output);
        if (!outputError) {
          return payload;
        }

        lastError = new Error(outputError.message);
        console.error(
          `Warning: Zo output error on attempt ${attempt + 1}/${MAX_RETRIES}: ${outputError.raw}`,
        );

        if (!outputError.retryable) {
          break;
        }
      } else {
        const errorText = await response.text();
        lastError = new Error(`HTTP ${response.status}: ${errorText}`);
        console.error(
          `Warning: Status ${response.status} on attempt ${attempt + 1}/${MAX_RETRIES}`,
        );

        if (!isRetryableStatus(response.status)) {
          break;
        }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(
        `Warning: Request failed on attempt ${attempt + 1}/${MAX_RETRIES}:`,
        error,
      );

      if (!isAbortError(lastError) && attempt === MAX_RETRIES - 1) {
        break;
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (attempt < MAX_RETRIES - 1) {
      await sleep(getRetryDelay(attempt));
    }
  }

  throw new Error(
    `All ${MAX_RETRIES} retry attempts failed. Last error: ${lastError?.message}`,
  );
}
