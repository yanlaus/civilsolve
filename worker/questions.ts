// The question's pages, kept on the server (19 October 2026, the owner's
// request; until then uploads were never stored). A task's TaskJob writes
// the question's pages - and the lecture notes sent with it - to the R2
// bucket "civilsolve-pdfs" under question/<fingerprint>/ (p01.jpg..., the
// notes n01.jpg...), once per question: the fingerprint is the usage log's
// (worker/usage.ts), so every task of one question shares one copy.
//
// How long: as long as the question's answers or PDFs. A QuestionStore - one
// Durable Object per question - deletes the pages 24 hours after the last
// task that used them finished (JOB_RETENTION_MS, plus the longest a task
// can run); a PDF made of any of its answers keeps them for good instead,
// like the PDF itself (GET /api/pdf/:id calls keep()). The owner reads them
// on the usage page (GET /api/admin/question/...).

import { DurableObject } from "cloudflare:workers";
import { MAX_TIMEOUT_MS } from "../shared/stream-protocol";
import type { WorkerEnv } from "./channels";

/** Answers are kept 24 hours after they finish (JOB_RETENTION_MS in jobs.ts). */
const ANSWER_RETENTION_MS = 24 * 60 * 60 * 1000;

/** How long after a task starts its question's pages are kept: its answer's 24 hours, after the longest run. */
export const QUESTION_RETENTION_MS = ANSWER_RETENTION_MS + MAX_TIMEOUT_MS;

/** A write that has not reported back in this long is taken to have failed. */
const WRITE_GRACE_MS = 5 * 60 * 1000;

/** A question's fingerprint (usage.ts): 16 hex digits. */
export const QUESTION_PATTERN = /^[0-9a-f]{16}$/;

/** A stored page: p01.jpg... for the question, n01.jpg... for the lecture notes. */
export const PAGE_NAME_PATTERN = /^[pn]\d{2}\.(jpg|png|webp)$/;

export function questionPrefix(fingerprint: string) {
  return `question/${fingerprint}/`;
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** A page's data URL as bytes, or null when it is not a JPEG, PNG or WebP. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; type: string; extension: string } | null {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2].replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, type: match[1], extension: EXTENSIONS[match[1]] };
}

type QuestionState = {
  /** How many question pages and lecture-notes pages are written. */
  pages: number;
  notes: number;
  /** Their total size, counted against PdfBudget's storage cap once kept. */
  bytes: number;
  /** Kept for good: a PDF of one of its answers was made. */
  kept: boolean;
  /**
   * When a write of the question pages, or of the lecture notes, began that
   * has not reported back yet - apart, so a reading sent without the notes
   * does not stop a solve sent with them from writing them.
   */
  writingPages?: number;
  writingNotes?: number;
  /** When the pages will be deleted, unless kept. */
  deleteAt?: number;
};

const EMPTY: QuestionState = { pages: 0, notes: 0, bytes: 0, kept: false };

export class QuestionStore extends DurableObject<WorkerEnv> {
  private async read(): Promise<QuestionState> {
    return (await this.ctx.storage.get<QuestionState>("state")) ?? { ...EMPTY };
  }

  /**
   * A task of this question started: pushes the deletion back, and says
   * which of its pages still need writing - none while another task is
   * writing them, so three solvers started at once write one copy.
   */
  async touch(fingerprint: string, pages: number, notes: number): Promise<{ pages: boolean; notes: boolean }> {
    const state = await this.read();
    const now = Date.now();
    const busy = (since?: number) => since !== undefined && now - since < WRITE_GRACE_MS;
    const write = {
      pages: !busy(state.writingPages) && pages > state.pages,
      notes: !busy(state.writingNotes) && notes > state.notes,
    };
    if (write.pages) state.writingPages = now;
    if (write.notes) state.writingNotes = now;
    if (!state.kept) {
      state.deleteAt = now + QUESTION_RETENTION_MS;
      await this.ctx.storage.setAlarm(state.deleteAt);
    }
    await this.ctx.storage.put({ fingerprint, state });
    return write;
  }

  /** A write finished: what is now stored. */
  async written(pages: number | null, notes: number | null, bytes: number) {
    const state = await this.read();
    if (pages !== null) {
      state.pages = pages;
      delete state.writingPages;
    }
    if (notes !== null) {
      state.notes = notes;
      delete state.writingNotes;
    }
    state.bytes += Math.max(0, bytes);
    await this.ctx.storage.put("state", state);
  }

  /** A write failed: the next task tries again. */
  async failed(pages: boolean, notes: boolean) {
    const state = await this.read();
    if (pages) delete state.writingPages;
    if (notes) delete state.writingNotes;
    await this.ctx.storage.put("state", state);
  }

  /**
   * A PDF of one of the question's answers was made: its pages are kept for
   * good too. Returns the bytes newly kept (0 when they already were).
   */
  async keep(): Promise<number> {
    const state = await this.read();
    if (state.kept) return 0;
    state.kept = true;
    delete state.deleteAt;
    await this.ctx.storage.put("state", state);
    await this.ctx.storage.deleteAlarm();
    return state.bytes;
  }

  /** For the usage page: whether the pages are kept for good, else when they go. */
  async info(): Promise<{ kept: boolean; deleteAt: number | null }> {
    const state = await this.read();
    return { kept: state.kept, deleteAt: state.kept ? null : (state.deleteAt ?? null) };
  }

  /** 24 hours after the last task: the pages are deleted, unless kept. */
  async alarm() {
    const state = await this.read();
    if (state.kept) return;
    const fingerprint = await this.ctx.storage.get<string>("fingerprint");
    const bucket = this.env.PDFS;
    if (bucket && fingerprint && QUESTION_PATTERN.test(fingerprint)) {
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ prefix: questionPrefix(fingerprint), cursor });
        if (listed.objects.length) await bucket.delete(listed.objects.map((object) => object.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    await this.ctx.storage.deleteAll();
  }
}

/**
 * Writes a task's question pages and lecture notes to R2, unless they are
 * there already, and pushes their deletion back. Best effort: a failure is
 * reported to the Worker's logs and never touches the task.
 */
export async function storeQuestionPages(
  env: WorkerEnv,
  fingerprint: string,
  pages: string[],
  notes: string[],
): Promise<void> {
  const bucket = env.PDFS;
  const stores = env.QUESTIONS;
  if (!bucket || !stores || !QUESTION_PATTERN.test(fingerprint) || !pages.length) return;
  const store = stores.get(stores.idFromName(fingerprint));
  const write = await store.touch(fingerprint, pages.length, notes.length);
  if (!write.pages && !write.notes) return;
  let bytes = 0;
  try {
    const metadata = { pages: String(pages.length), notes: String(notes.length) };
    const put = async (prefix: "p" | "n", list: string[]) => {
      for (const [index, dataUrl] of list.entries()) {
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded) continue;
        const name = `${prefix}${String(index + 1).padStart(2, "0")}.${decoded.extension}`;
        await bucket.put(`${questionPrefix(fingerprint)}${name}`, decoded.bytes, {
          httpMetadata: { contentType: decoded.type },
          customMetadata: metadata,
        });
        bytes += decoded.bytes.byteLength;
      }
    };
    if (write.pages) await put("p", pages);
    if (write.notes) await put("n", notes);
    await store.written(write.pages ? pages.length : null, write.notes ? notes.length : null, bytes);
  } catch (error) {
    console.warn("question pages not stored", error instanceof Error ? error.message : error);
    await store.failed(write.pages, write.notes).catch(() => {});
  }
}

/** The pages' counts the usage page shows, from the first page's metadata - or null when none is stored. */
export async function storedQuestion(bucket: R2Bucket, fingerprint: string): Promise<{ pages: number; notes: number } | null> {
  if (!QUESTION_PATTERN.test(fingerprint)) return null;
  const listed = await bucket.list({ prefix: questionPrefix(fingerprint), limit: 100 });
  if (!listed.objects.length) return null;
  const names = listed.objects.map((object) => object.key.slice(questionPrefix(fingerprint).length));
  return {
    pages: names.filter((name) => name.startsWith("p")).length,
    notes: names.filter((name) => name.startsWith("n")).length,
  };
}
