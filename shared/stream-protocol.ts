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
