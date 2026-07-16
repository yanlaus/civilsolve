// App-level SSE protocol for POST /api/solve/:provider and
// POST /api/interpret/:provider. The Worker translates upstream provider
// streams into these events so the client is agnostic to whether the
// upstream call streamed or not.

import type { EffortKey } from "./prompt";
import type { InterpretationResult } from "./interpretation";
import type { ProviderArtifact } from "./solution";

export type SolveRequestBody = {
  images: string[]; // data:image/...;base64,... (uploads + rasterized PDF pages)
  notes: string;
  effort: EffortKey;
  // Human-confirmed problem statement from the interpretation pipeline.
  interpretation?: string;
  // Lecture notes: extracted text and/or rasterized pages, sent for method
  // reference only (never solved).
  referenceText?: string;
  referenceImages?: string[];
};

export type InterpretRequestBody = {
  mode: "interpret" | "verify";
  images: string[];
  notes: string;
  // Verify mode: the two candidate interpretations to reconcile.
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
