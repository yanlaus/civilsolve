// This app's IndexedDB in the browser - one database, so one version:
// - "uploads" (version 1): the last run's request body (upload-store.ts);
// - "history" (version 2, 3 October 2026): the questions solved, with their
//   answers as text (history-store.ts), keyed by the run's savedAt.
// Nothing here ever leaves the device. Each operation opens and closes its
// own connection, so a newer version in another tab is never blocked for
// long.

const DB_NAME = "civilsolve";
const DB_VERSION = 2;

export type StoreName = "uploads" | "history";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("uploads")) db.createObjectStore("uploads");
      if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "savedAt" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB is blocked."));
  });
}

/** Runs one request in a transaction on `store` and resolves with its result once committed. */
export async function inStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  operation: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = operation(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Reads, changes and writes one record of `store` in a single transaction. */
export async function updateRecord<T>(
  store: StoreName,
  key: IDBValidKey,
  change: (current: T | undefined) => T | null,
): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(store, "readwrite");
      const objectStore = transaction.objectStore(store);
      const read = objectStore.get(key);
      read.onsuccess = () => {
        const next = change(read.result as T | undefined);
        if (next) objectStore.put(next);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
