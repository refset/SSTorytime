// Drive v3 REST helpers. Direct fetch — no gapi client library.

import { getToken } from "./auth.js";
import { CONFIG } from "./config.js";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

function authHeaders() {
  const t = getToken();
  if (!t) throw new Error("not signed in");
  return { Authorization: `Bearer ${t}` };
}

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers ?? {}), ...authHeaders() } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`drive ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

export async function listFolder(folderId) {
  const out = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,md5Checksum,size)",
      pageSize: "200",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await jsonFetch(`${DRIVE}/files?${params}`);
    out.push(...(data.files ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

export async function getFileText(fileId) {
  const r = await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`drive get ${r.status}`);
  return r.text();
}

export async function getFileBlob(fileId) {
  const r = await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`drive get ${r.status}`);
  return r.blob();
}

export async function findMetaFile(folderId) {
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and name = '${CONFIG.metaFileName}' and trashed = false`,
    fields: "files(id,name,modifiedTime)",
  });
  const data = await jsonFetch(`${DRIVE}/files?${params}`);
  return data.files?.[0] ?? null;
}

export async function readMeta(folderId) {
  const f = await findMetaFile(folderId);
  if (!f) return { version: 1, files: {}, assets: {} };
  try { return JSON.parse(await getFileText(f.id)); }
  catch { return { version: 1, files: {}, assets: {} }; }
}

export async function writeMeta(folderId, meta) {
  const existing = await findMetaFile(folderId);
  const metadata = {
    name: CONFIG.metaFileName,
    mimeType: "application/json",
    ...(existing ? {} : { parents: [folderId] }),
  };
  const boundary = "sstaas-" + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify(meta, null, 2) + `\r\n` +
    `--${boundary}--`;
  const url = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=multipart`
    : `${UPLOAD}/files?uploadType=multipart`;
  const r = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: { ...authHeaders(), "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!r.ok) throw new Error(`drive write meta ${r.status}: ${await r.text()}`);
  return r.json();
}

export function classifyFiles(files) {
  const n4l = [];
  const assets = [];
  const exts = CONFIG.n4lExtensions.map((e) => e.toLowerCase());
  for (const f of files) {
    if (f.name === CONFIG.metaFileName) continue;
    const lower = f.name.toLowerCase();
    if (exts.some((e) => lower.endsWith(e))) n4l.push(f);
    else assets.push(f);
  }
  return { n4l, assets };
}

// Folder selection. Picker API needs a Browser API key — until that's
// wired the user pastes a folder ID.
export async function pickFolderManual(promptFn = window.prompt) {
  const id = promptFn("Paste a Google Drive folder ID:");
  return id ? id.trim() : null;
}
