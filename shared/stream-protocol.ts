// App-level SSE protocol for POST /api/solve/:provider.
// The Worker translates upstream provider streams into these events so the
// client is agnostic to whether the upstream call streamed or not.

import type { InterpretationResult } from "./interpretation";
import type { EffortKey } from "./prompt";
import type { ProviderArtifact } from "./solution";

export type SolveRequestBody = {
  images: string[]; // data:image/...;base64,... (uploads + rasterized PDF pages)
  notes: string;
  effort: EffortKey;
  /** Human-confirmed problem statement from the optional interpretation pass. */
  interpretation?: string;
  /** Lecture notes, sent for method reference only — never solved. */
  referenceText?: string;
  referenceImages?: string[];
};

export type InterpretRequestBody = {
  mode: "interpret" | "verify";
  images: string[];
  notes: string;
  /** Verify mode: the two candidate interpretations to reconcile. */
  interpretations?: [string, string];
};

export type SolveEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; solution: ProviderArtifact }
  | { type: "error"; message: string };

export type InterpretEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; interpretation: InterpretationResult }
  | { type: "error"; message: string };

export const MAX_IMAGES = 16;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export const MAX_REFERENCE_IMAGES = 8;
export const MAX_REFERENCE_TEXT = 20_000;
export const MAX_INTERPRETATION_LENGTH = 8_000;

export const DATA_URL_PATTERN = /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

/**
 * Upper bound on the encoded request body, without building it.
 *
 * The browser sends one copy of this payload per selected provider, and the
 * Worker parses the whole thing before it can validate anything, so it is
 * worth refusing an oversized upload client-side rather than firing several
 * doomed requests.
 *
 * Data URLs are ASCII, so one character is one byte. Notes may be any script;
 * three bytes per character covers UTF-8 plus JSON escaping.
 */
export function estimateBodyBytes(body: {
  images: string[];
  notes: string;
  interpretation?: string;
  referenceText?: string;
  referenceImages?: string[];
}) {
  let total = 128; // envelope and field names
  for (const image of [...body.images, ...(body.referenceImages || [])]) {
    total += image.length + 3; // quotes + separator
  }
  const text = body.notes + (body.interpretation || "") + (body.referenceText || "");
  return total + text.length * 3;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
