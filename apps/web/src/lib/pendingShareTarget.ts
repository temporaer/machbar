import type { WebShareTarget } from "./shareTarget";

const DATABASE_NAME = "machbar-share-targets";
const STORE_NAME = "pending-shares";
const DATABASE_VERSION = 1;

// Keep these identifiers aligned with the unbundled service worker in public/sw.js.

interface PendingShareRecord extends WebShareTarget {
  id: string;
  createdAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open pending shares."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = action(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Pending share access failed."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Pending share transaction failed."));
    });
  } finally {
    database.close();
  }
}

export async function readPendingShareTarget(
  id: string,
): Promise<WebShareTarget | null> {
  const record = await withStore<PendingShareRecord | undefined>(
    "readonly",
    (store) => store.get(id),
  );
  if (!record) return null;
  return {
    title: record.title,
    text: record.text,
    url: record.url,
    files: record.files,
  };
}

export async function deletePendingShareTarget(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
