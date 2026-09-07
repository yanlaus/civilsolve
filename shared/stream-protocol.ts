// App-level SSE protocol for POST /api/solve/:provider.
// The Worker translates upstream provider streams into these events so the
// client is agnostic to whether the upstream call streamed or not.

import type { EffortKey } from "./prompt";
import type { ProviderArtifact } from "./solution";

export type SolveRequestBody = {
  images: string[]; // data:image/...;base64,... (uploads + rasterized PDF pages)
  notes: string;
  effort: EffortKey;
};

export type SolveEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "done"; solution: ProviderArtifact }
  | { type: "error"; message: string };

export const MAX_IMAGES = 16;
export const MAX_NOTES_LENGTH = 4000;
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

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
export function estimateBodyBytes(images: string[], notes: string) {
  let total = 64; // {"images":[],"notes":"","effort":"medium"}
  for (const image of images) {
    total += image.length + 3; // quotes + separator
  }
  return total + notes.length * 3;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
