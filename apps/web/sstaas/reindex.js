// Re-index orchestrator. Diffs Drive folder against the
// .sstaas-index.json meta, fetches new/changed N4L files, hands them
// to the WASM parser (currently a stub), upserts a row per file into
// PGlite (n4l_files), reconciles asset cache state per keepOffline
// flags, and writes the meta back.

import * as drive from "./drive.js";
import * as assets from "./assets.js";
import { parseN4L } from "./bridge.js";
import { getDB } from "./db.js";

async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function summarize(meta) {
  const fs = Object.values(meta.files ?? {});
  return {
    activeFiles:   fs.filter((f) => f.status === "active").length,
    archivedFiles: fs.filter((f) => f.status === "archived").length,
    totalFiles:    fs.length,
  };
}

export async function reindex(folderId, { onProgress = () => {} } = {}) {
  onProgress({ stage: "list", message: "Listing Drive folder…" });
  const all = await drive.listFolder(folderId);
  const { n4l: n4lFiles, assets: assetFiles } = drive.classifyFiles(all);

  onProgress({ stage: "meta", message: `Reading meta (${n4lFiles.length} N4L, ${assetFiles.length} assets)…` });
  const meta = await drive.readMeta(folderId);
  meta.files ??= {};
  meta.assets ??= {};

  const seenN4L = new Set();
  const toFetch = [];
  for (const f of n4lFiles) {
    seenN4L.add(f.id);
    const prior = meta.files[f.id];
    const changed =
      !prior ||
      prior.status !== "active" ||
      prior.modifiedTime !== f.modifiedTime ||
      (f.md5Checksum && prior.md5Checksum !== f.md5Checksum);
    if (changed) toFetch.push(f);
  }
  for (const [id, entry] of Object.entries(meta.files)) {
    if (!seenN4L.has(id) && entry.status === "active") {
      entry.status = "archived";
      entry.archivedAt = new Date().toISOString();
      // Drop the N4L file row + its derived nodes/arrows/links.
      await getDB().exec(`DELETE FROM n4l_files WHERE drive_file_id = '${id.replace(/'/g, "''")}'`);
    }
  }

  let parseSummary = null;
  if (toFetch.length > 0) {
    onProgress({ stage: "fetch", message: `Fetching ${toFetch.length} N4L file(s)…` });
    const contents = {};
    for (let i = 0; i < toFetch.length; i++) {
      const f = toFetch[i];
      onProgress({ stage: "fetch", message: `Fetching ${i + 1}/${toFetch.length}: ${f.name}` });
      contents[f.name] = await drive.getFileText(f.id);
    }

    onProgress({ stage: "store", message: "Storing files into PGlite…" });
    const now = new Date().toISOString();
    for (const f of toFetch) {
      const text = contents[f.name];
      const sha = await sha256Hex(text);
      await getDB().query(
        `INSERT INTO n4l_files (drive_file_id, name, text, sha256, modified_time, indexed_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (drive_file_id) DO UPDATE
           SET name = EXCLUDED.name,
               text = EXCLUDED.text,
               sha256 = EXCLUDED.sha256,
               modified_time = EXCLUDED.modified_time,
               indexed_at = now()`,
        [f.id, f.name, text, sha, f.modifiedTime]
      );
      meta.files[f.id] = {
        name: f.name,
        status: "active",
        modifiedTime: f.modifiedTime,
        md5Checksum: f.md5Checksum ?? null,
        sha256: sha,
        lastIndexedAt: now,
      };
    }

    onProgress({ stage: "parse", message: "Running WASM parser…" });
    parseSummary = await parseN4L(contents);
    // The current Go side is a stub: it acks the files but doesn't yet
    // emit nodes/arrows/links. When it does, this is where we'd insert
    // them into the nodes/arrows/links tables.
  }

  await reconcileAssets(assetFiles, meta, onProgress);

  onProgress({ stage: "meta-write", message: "Writing meta back to Drive…" });
  await drive.writeMeta(folderId, meta);

  onProgress({ stage: "done", message: "Re-index complete." });
  return {
    fetched: toFetch.length,
    parser: parseSummary,
    ...summarize(meta),
  };
}

async function reconcileAssets(assetFiles, meta, onProgress) {
  const seen = new Set();
  for (const a of assetFiles) {
    seen.add(a.id);
    const prior = meta.assets[a.id] ?? {};
    meta.assets[a.id] = {
      name: a.name,
      mimeType: a.mimeType,
      size: a.size ?? null,
      modifiedTime: a.modifiedTime,
      md5Checksum: a.md5Checksum ?? null,
      status: "active",
      keepOffline: !!prior.keepOffline,
      lastSeenAt: new Date().toISOString(),
      cachedAt: prior.cachedAt ?? null,
    };
    if (meta.assets[a.id].keepOffline) {
      const cached = await assets.has(a.id);
      const stale = prior.modifiedTime && prior.modifiedTime !== a.modifiedTime;
      if (!cached || stale) {
        onProgress({ stage: "asset", message: `Caching offline: ${a.name}` });
        const blob = await drive.getFileBlob(a.id);
        await assets.put(a, blob);
        meta.assets[a.id].cachedAt = new Date().toISOString();
      }
    } else if (await assets.has(a.id)) {
      await assets.evict(a.id);
      meta.assets[a.id].cachedAt = null;
    }
  }
  for (const [id, entry] of Object.entries(meta.assets)) {
    if (!seen.has(id) && entry.status === "active") {
      entry.status = "archived";
      entry.archivedAt = new Date().toISOString();
      if (await assets.has(id)) await assets.evict(id);
      entry.cachedAt = null;
    }
  }
}

// Toggle keep-offline for one asset; updates cache + meta in place.
// Caller writes meta back to Drive after a batch of toggles.
export async function setKeepOffline(folderId, meta, assetId, keep) {
  const entry = meta.assets?.[assetId];
  if (!entry) throw new Error("unknown asset: " + assetId);
  entry.keepOffline = !!keep;
  if (keep) {
    if (!(await assets.has(assetId))) {
      const blob = await drive.getFileBlob(assetId);
      await assets.put({ id: assetId, name: entry.name, mimeType: entry.mimeType, size: entry.size }, blob);
    }
    entry.cachedAt = new Date().toISOString();
  } else {
    if (await assets.has(assetId)) await assets.evict(assetId);
    entry.cachedAt = null;
  }
  return entry;
}
