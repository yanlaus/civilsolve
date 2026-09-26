// The last run's request body - the prepared page images, notes, effort,
// confirmed interpretation and lecture notes - kept in this browser's
// IndexedDB, so the page can still retry a failed solver, add another one,
// or run the answer cross-check after it was reloaded or discarded. What the
// page shows of the confirmed interpretation beyond the English in the body
// (the Traditional Chinese, who read it) is kept with it, so the reading is
// still above the solutions after a reload.
//
// This never leaves the browser. The server still stores no uploads
// (AGENTS.md, "Answers only, for 24 hours - never uploads"); this is the
// user's own copy, on their own device, of what they uploaded. Only one run
// is kept: a new run replaces it, Clear and Stop delete it, and it is
// dropped 24 hours after it was stored, like the run record in run-store.ts.
// Everything is best effort - IndexedDB can be unavailable or full, and the
// page then works as before, only without those actions after a reload.

import type { SolveRequestBody } from "../../shared/stream-protocol";
import { RETENTION_MS } from "./run-store";

const DB_NAME = "civilsolve";
const STORE = "uploads";
const KEY = "last-run";

/**
 * The confirmed interpretation as the page shows it, beyond the English the
 * solvers got (the body's `interpretation`). Display only - never sent.
 */
export type InterpretationExtras = {
  /** The reconciler's Traditional Chinese version. */
  chinese?: string;
  /** Who read it: "DeepSeek (Flash) and Muse Spark, reconciled by ChatGPT". */
  credit?: string;
  /** Why it was not cross-checked, when one reader's reading went alone. */
  note?: string;
};

type StoredBody = {
  /** The run it belongs to: SavedRun.savedAt. */
  savedAt: number;
  storedAt: number;
  body: SolveRequestBody;
  extras?: InterpretationExtras;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB is blocked."));
  });
}

async function inStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps `body` as the body of the run saved at `savedAt`. */
export async function saveBody(
  savedAt: number,
  body: SolveRequestBody,
  extras?: InterpretationExtras,
): Promise<void> {
  try {
    const record: StoredBody = { savedAt, storedAt: Date.now(), body, ...(extras ? { extras } : {}) };
    await inStore("readwrite", (store) => store.put(record, KEY));
  } catch {
    // Without it, only the actions after a reload are lost.
  }
}

/** The body of the run saved at `savedAt`, if this browser still has it. */
export async function loadBody(
  savedAt: number,
): Promise<{ body: SolveRequestBody; extras?: InterpretationExtras } | null> {
  try {
    const record = await inStore<StoredBody | undefined>("readonly", (store) => store.get(KEY));
    if (!record) return null;
    const usable =
      record.savedAt === savedAt &&
      Date.now() - record.storedAt <= RETENTION_MS &&
      Array.isArray(record.body?.images) &&
      record.body.images.length > 0;
    if (!usable) {
      // Another run's images, or expired: nothing will ask for them again.
      void clearBody();
      return null;
    }
    return { body: record.body, extras: record.extras };
  } catch {
    return null;
  }
}

export async function clearBody(): Promise<void> {
  try {
    await inStore("readwrite", (store) => store.delete(KEY));
  } catch {
    // Nothing to clear.
  }
}
