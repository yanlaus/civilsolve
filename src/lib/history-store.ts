// The questions a student has solved, kept in this browser for revision
// (3 October 2026): each run's question (a small picture of its first page),
// every solver's solution as text, the verdict and the study notes - the
// answers on the server are deleted after 24 hours, these are not. It never
// leaves the device (AGENTS.md); "Delete" and "Clear all" in the history
// remove it. At most MAX_ENTRIES, the oldest dropped first.

import type { StudyKind, StudyResult } from "../../shared/study";
import type { ModelVariant, ProviderKey } from "../../shared/providers";
import type { ProviderArtifact } from "../../shared/solution";
import { inStore, updateRecord } from "./idb";

export type HistorySolution = {
  artifact: ProviderArtifact;
  variant?: ModelVariant;
  /** The model id that answered, when the run said. */
  model?: string;
  /** The job that held it: its PDF link (GET /api/pdf/:id) works for good once made. */
  jobId?: string;
};

export type HistoryEntry = {
  /** The run's id (SavedRun.savedAt), and when it started. */
  savedAt: number;
  updatedAt: number;
  title: string;
  /** The first page, small: a JPEG data URL of about 10 KB. */
  thumbnail?: string;
  notes?: string;
  interpretation?: string;
  solutions: Partial<Record<ProviderKey, HistorySolution>>;
  verdict?: {
    judge: ProviderKey;
    variant?: ModelVariant;
    correct: ProviderKey[];
    graded: ProviderKey[];
    finalAnswer: string;
    jobId?: string;
  };
  study?: Partial<Record<StudyKind, { study: StudyResult; jobId?: string }>>;
};

const MAX_ENTRIES = 100;

/** Merges what the run has now into its entry (nothing already kept is dropped), then trims the oldest. */
export async function saveEntry(
  savedAt: number,
  merge: (current: HistoryEntry | undefined) => HistoryEntry | null,
): Promise<void> {
  try {
    await updateRecord<HistoryEntry>("history", savedAt, merge);
    const keys = await inStore<IDBValidKey[]>("history", "readonly", (store) => store.getAllKeys());
    const excess = (keys as number[]).sort((a, b) => a - b).slice(0, Math.max(0, keys.length - MAX_ENTRIES));
    for (const key of excess) await inStore("history", "readwrite", (store) => store.delete(key));
  } catch {
    // The history is a convenience; the page works without it.
  }
}

/** Every entry, newest first. */
export async function listEntries(): Promise<HistoryEntry[]> {
  try {
    const entries = await inStore<HistoryEntry[]>("history", "readonly", (store) => store.getAll());
    return entries.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

export async function deleteEntry(savedAt: number): Promise<void> {
  try {
    await inStore("history", "readwrite", (store) => store.delete(savedAt));
  } catch {
    // Nothing to delete.
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await inStore("history", "readwrite", (store) => store.clear());
  } catch {
    // Nothing to clear.
  }
}

/** A small JPEG of a page, for the history's list: about 240 px on its longer side. */
export function makeThumbnail(dataUrl: string, maxSide = 240): Promise<string | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        if (!context) return resolve(undefined);
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = dataUrl;
  });
}
