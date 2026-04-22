// Local-folder binding. Uses the File System Access API
// (showDirectoryPicker) where available so we can persist the handle
// across reloads of the same session URL. Falls back to
// <input webkitdirectory> which is pickable but not persistable — the
// user has to re-pick after every reload on that path.
//
// Exposes:
//   hasFSAA() → bool
//   openPicker() → { handle, files: [{name, path, file}], fingerprint }
//   reopenFromSession(sessionId) → same shape, or null if nothing stored
//                                  or permission not yet granted
//   requestPermission(handle) → "granted" | "denied" | "prompt"
//   scan(handle) → [{name, path, file}]   walk all *.n4l files
//   fingerprintFiles(files) → string      stable id per file set
//   store(sessionId, handle) / clear(sessionId)
//
// The underlying IndexedDB DB is sstaas-folders, store handles.

const DB_NAME = "sstaas-folders";
const STORE = "handles";

export function hasFSAA() {
  return typeof window.showDirectoryPicker === "function";
}

// IndexedDB sometimes hangs on open in sandboxed / remote-debug
// contexts (we saw this under chrome-devtools-mcp, and the ROADMAP
// already notes PGlite's idb:// persistence failing to resolve in
// the same environment). Cap every open at 2s so a hung IDB fails
// fast and the rest of the UI stays responsive.
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb open blocked"));
    setTimeout(() => reject(new Error("idb open timeout")), 2000);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, "readwrite");
      const req = tx.objectStore(STORE).put(value, key);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error ?? new Error("idb put aborted"));
  });
}

async function idbDel(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function openPicker() {
  if (!hasFSAA()) {
    throw new Error("showDirectoryPicker not available in this browser");
  }
  const handle = await window.showDirectoryPicker({ mode: "read" });
  return handle;
}

export async function store(sessionId, handle) {
  await idbPut(sessionId, { handle, savedAt: Date.now() });
}

export async function clear(sessionId) {
  await idbDel(sessionId);
}

// Returns the stored DirectoryHandle or null. Does NOT request
// permission — call queryPermission / requestPermission separately.
export async function loadStoredHandle(sessionId) {
  if (!hasFSAA()) return null;
  const entry = await idbGet(sessionId);
  return entry?.handle ?? null;
}

export async function queryPermission(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return "denied";
  return handle.queryPermission({ mode: "read" });
}

export async function requestPermission(handle) {
  if (!handle || typeof handle.requestPermission !== "function") return "denied";
  return handle.requestPermission({ mode: "read" });
}

// scan walks the directory (recursive) and returns every *.n4l file
// it finds, each entry including a File object so callers can read
// the text + see size/lastModified.
export async function scan(handle) {
  const out = [];
  await walk(handle, "", out);
  return out;
}

async function walk(dir, prefix, out) {
  for await (const [name, entry] of dir.entries()) {
    if (name.startsWith(".")) continue; // skip dotfiles / .git etc.
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === "file") {
      // .n4l data files; also pick up .sst files living under an
      // SSTconfig/ subdirectory (upstream's per-dataset convention for
      // extending arrows/annotations/closures). Everything else is
      // ignored.
      const isN4L = /\.n4l$/i.test(name);
      const isConfig = /\.sst$/i.test(name) && /(^|\/)SSTconfig\//i.test(path);
      if (!isN4L && !isConfig) continue;
      const file = await entry.getFile();
      out.push({ name, path, file, kind: isConfig ? "config" : "n4l" });
    } else if (entry.kind === "directory") {
      await walk(entry, path, out);
    }
  }
}

// fingerprintFiles produces a stable short string summarising a file
// set. Two scans with identical (name, size, lastModified) produce
// the same fingerprint; any change (added, removed, edited file)
// produces a different one.
export async function fingerprintFiles(files) {
  const parts = files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.file.size}:${f.file.lastModified}`)
    .join("|");
  const enc = new TextEncoder().encode(parts);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Extract a friendly label from the handle or (fallback) from a
// webkitdirectory file list.
export function labelFromHandle(handle) {
  return handle?.name ?? "(folder)";
}

export function labelFromFileList(files) {
  const first = files[0];
  if (!first) return "(folder)";
  const rel = first.webkitRelativePath || first.name;
  const top = rel.split("/")[0];
  return top || "(folder)";
}
