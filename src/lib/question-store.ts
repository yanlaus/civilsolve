// The question behind each of the latest history entries (16 October 2026,
// the owner's request): its pages as they were sent, the student's notes and
// the lecture notes, so a question in the history can be solved again - in
// Careful, Quick or Custom - without uploading it again. Kept apart from the
// history entries (history-store.ts), which the History's list reads whole:
// these are megabytes. Only the latest MAX_SAVED_QUESTIONS are kept (the
// owner's pick); an older entry keeps its answers, but not its pages.
//
// Like the history, this never leaves the browser, and "Delete" and "Clear
// all" in the History remove it too. Everything is best effort - IndexedDB
// can be unavailable or full, and the history then works without it.

import type { SolveRequestBody } from "../../shared/stream-protocol";
import { inStore } from "./idb";

export const MAX_SAVED_QUESTIONS = 30;

/** The lecture notes as they were sent: their text and their page images. */
export type SavedReference = { referenceText: string; referenceImages: string[] };

export type SavedQuestion = {
  /** The run it was solved in: the history entry's savedAt. */
  savedAt: number;
  /** The question's pages, as JPEG data URLs (lib/attachments.ts). */
  images: string[];
  notes: string;
  reference?: SavedReference;
};

/** The question a run was sent: its pages, notes and lecture notes, from its request body. */
export function questionFromBody(savedAt: number, body: SolveRequestBody): SavedQuestion {
  const reference =
    body.referenceText || body.referenceImages?.length
      ? { referenceText: body.referenceText ?? "", referenceImages: body.referenceImages ?? [] }
      : undefined;
  return { savedAt, images: body.images, notes: body.notes, ...(reference ? { reference } : {}) };
}

/** Keeps the question of the run saved at `savedAt`, then drops the oldest beyond the limit. */
export async function saveQuestion(savedAt: number, body: SolveRequestBody): Promise<void> {
  if (!body.images.length) return;
  const question = questionFromBody(savedAt, body);
  try {
    await inStore("questions", "readwrite", (store) => store.put(question));
    const keys = await inStore<IDBValidKey[]>("questions", "readonly", (store) => store.getAllKeys());
    const excess = (keys as number[]).sort((a, b) => a - b).slice(0, Math.max(0, keys.length - MAX_SAVED_QUESTIONS));
    for (const key of excess) await inStore("questions", "readwrite", (store) => store.delete(key));
  } catch {
    // Full or unavailable: the entry keeps its answers, only not its pages.
  }
}

export async function loadQuestion(savedAt: number): Promise<SavedQuestion | null> {
  try {
    const question = await inStore<SavedQuestion | undefined>("questions", "readonly", (store) => store.get(savedAt));
    return question?.images?.length ? question : null;
  } catch {
    return null;
  }
}

/** Which history entries can still be solved again. */
export async function savedQuestionKeys(): Promise<Set<number>> {
  try {
    const keys = await inStore<IDBValidKey[]>("questions", "readonly", (store) => store.getAllKeys());
    return new Set(keys as number[]);
  } catch {
    return new Set();
  }
}

export async function deleteQuestion(savedAt: number): Promise<void> {
  try {
    await inStore("questions", "readwrite", (store) => store.delete(savedAt));
  } catch {
    // Nothing to delete.
  }
}

export async function clearQuestions(): Promise<void> {
  try {
    await inStore("questions", "readwrite", (store) => store.clear());
  } catch {
    // Nothing to clear.
  }
}

/** The question's pages as files, for the upload form to send again. */
export function questionFiles(question: SavedQuestion): File[] {
  return question.images.map((src, index) => {
    const [head, data] = src.split(",", 2);
    const type = /data:([^;]+)/.exec(head)?.[1] || "image/jpeg";
    const bytes = Uint8Array.from(atob(data ?? ""), (char) => char.charCodeAt(0));
    const extension = type === "image/png" ? "png" : "jpg";
    return new File([bytes], `question-page-${index + 1}.${extension}`, { type, lastModified: question.savedAt });
  });
}
