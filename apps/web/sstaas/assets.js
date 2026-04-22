// Offline asset cache: separate IndexedDB (sstaas-assets / blobs).
// Default model is stream-on-demand from Drive; opt-in keep-offline
// caches the blob and records keepOffline=true in the Drive meta.

import { getFileBlob } from "./drive.js";

const DB_NAME = "sstaas-assets";
const DB_VERSION = 1;
const STORE = "blobs";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode) {
  const db = await open();
  return db.transaction(STORE, mode).objectStore(STORE);
}

const pReq = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function has(id) {
  const s = await tx("readonly");
  return (await pReq(s.count(IDBKeyRange.only(id)))) > 0;
}

export async function get(id) {
  const s = await tx("readonly");
  const row = await pReq(s.get(id));
  return row ? row.blob : null;
}

export async function getBlobUrl(id) {
  const blob = await get(id);
  return blob ? URL.createObjectURL(blob) : null;
}

export async function put(driveFile, blob) {
  const s = await tx("readwrite");
  await pReq(
    s.put({
      id: driveFile.id,
      name: driveFile.name,
      mimeType: driveFile.mimeType ?? blob.type ?? "application/octet-stream",
      size: driveFile.size ?? blob.size,
      blob,
      cachedAt: new Date().toISOString(),
    })
  );
}

export async function evict(id) {
  const s = await tx("readwrite");
  await pReq(s.delete(id));
}

export async function summarize() {
  const s = await tx("readonly");
  const all = await pReq(s.getAll());
  const totalBytes = all.reduce((n, r) => n + (r.size ?? r.blob?.size ?? 0), 0);
  return { count: all.length, totalBytes };
}

// Returns a blob — from cache if present, otherwise streamed from
// Drive (NOT cached). Caller chooses whether to also `put(...)`.
export async function fetchOrStream(driveFile) {
  const cached = await get(driveFile.id);
  if (cached) return cached;
  return await getFileBlob(driveFile.id);
}
