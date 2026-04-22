// Adds the few new bits of UI on top of upstream's index.html — done
// in JS rather than by editing main.js so upstream's SPA stays
// untouched and easy to merge with future upstream changes.
//
// What we add:
//  1. A small controls bar in <header> with Sign-in / Pick-folder /
//     Re-index buttons and a status line.
//  2. Footer links: About / Privacy / Terms (with version stamps).
//  3. A modal overlay container used by those footer links.
//  4. An assets list panel (hidden until a folder is picked) showing
//     each Drive asset with a "keep offline" checkbox.

import { CONFIG } from "./config.js";
import { initAuth, signIn, signOut, isSignedIn, onAuthChange } from "./auth.js";
import * as drive from "./drive.js";
import * as assets from "./assets.js";
import { reindex, setKeepOffline } from "./reindex.js";
import { parseN4L } from "./bridge.js";
import { getSessionId } from "./session.js";
import * as fh from "./folder-handle.js";

const FOLDER_KEY = "sstaas-drive-folder-id";
const POLL_MS = 30_000;

// ---- Markup injection ----

const CONTROLS_HTML = `
  <div id="sstaas-controls">
    <button id="sstaas-signin" class="sstaas-btn">Sign in with Google</button>
    <button id="sstaas-signout" class="sstaas-btn" hidden>Sign out</button>
    <button id="sstaas-pick-folder" class="sstaas-btn" hidden>Choose Drive folder</button>
    <code id="sstaas-folder" class="sstaas-folder" hidden></code>
    <button id="sstaas-reindex" class="sstaas-btn primary" hidden>Re-index</button>

    <!-- Local-folder binding. One of these two is visible at a time:
         the pick button, or the picked-folder row. -->
    <button id="sstaas-local-pick" class="sstaas-btn" title="Pick a local directory; every .n4l inside is parsed. No Drive required.">Open local n4l directory</button>
    <input id="sstaas-local-fallback" type="file" webkitdirectory directory multiple hidden>

    <span id="sstaas-local-row" class="sstaas-local-row" hidden>
      <span id="sstaas-local-dot" class="sstaas-dot" title=""></span>
      <code id="sstaas-local-name" class="sstaas-folder"></code>
      <button id="sstaas-local-refresh" class="sstaas-icon-btn" title="Refresh: rescan folder + re-parse">⟳</button>
    </span>

    <span id="sstaas-status" class="sstaas-status"></span>
  </div>`;

const FOOTER_LINKS_HTML = `
  <div id="sstaas-footer-links">
    <a href="#" data-overlay="about">About</a>
    · <a href="#" data-overlay="terms">Terms (v${CONFIG.termsVersion})</a>
    · <a href="#" data-overlay="privacy">Privacy (v${CONFIG.privacyVersion})</a>
  </div>`;

const OVERLAY_HTML = `
  <div id="sstaas-overlay" hidden>
    <div id="sstaas-overlay-card">
      <button id="sstaas-overlay-close" aria-label="Close">×</button>
      <div id="sstaas-overlay-body"></div>
    </div>
  </div>`;

const ASSETS_HTML = `
  <aside id="sstaas-assets" hidden>
    <div class="sstaas-assets-header">
      <strong>Drive assets</strong>
      <span id="sstaas-assets-summary"></span>
      <button id="sstaas-assets-close" aria-label="Hide">×</button>
    </div>
    <div id="sstaas-assets-list"></div>
  </aside>`;

const STYLE = `
  #sstaas-controls {
    display: flex; gap: 0.4rem; align-items: center;
    padding: 0.4rem 0.75rem; background: #f6f6f2;
    border-bottom: 1px solid #ddd; font-size: 0.88rem;
    flex-wrap: wrap;
  }
  .sstaas-btn {
    padding: 0.3rem 0.7rem; border: 1px solid #c8c8c4; background: #fff;
    border-radius: 4px; cursor: pointer; font-size: 0.85rem; color: inherit;
  }
  .sstaas-btn:hover { background: #efefe9; }
  .sstaas-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .sstaas-btn.primary { border-color: #4a86c8; color: #1c4577; }
  .sstaas-folder {
    background: #eef; padding: 0.1rem 0.4rem; border-radius: 3px;
    font-size: 0.78rem; word-break: break-all; max-width: 28ch;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sstaas-status { color: #555; font-size: 0.82rem; min-width: 12rem; }

  .sstaas-local-row {
    display: inline-flex; align-items: center; gap: 0.35rem;
  }
  .sstaas-dot {
    width: 0.65rem; height: 0.65rem; border-radius: 50%;
    display: inline-block; background: #bbb;
    box-shadow: inset 0 0 0 1px rgba(0,0,0,0.08);
  }
  .sstaas-dot.green  { background: #3a9a3a; }
  .sstaas-dot.yellow { background: #e0b52a; }
  .sstaas-dot.red    { background: #b33030; }
  .sstaas-icon-btn {
    border: 1px solid #c8c8c4; background: #fff; color: #444;
    width: 1.6rem; height: 1.6rem; padding: 0;
    border-radius: 4px; cursor: pointer; font-size: 0.95rem;
    line-height: 1; display: inline-flex; align-items: center; justify-content: center;
  }
  .sstaas-icon-btn:hover { background: #efefe9; }
  .sstaas-icon-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  #sstaas-footer-links {
    margin-left: auto; font-size: 0.85rem; padding-right: 0.75rem;
  }
  #sstaas-footer-links a {
    color: inherit; text-decoration: none;
    border-bottom: 1px dotted #888;
  }
  #sstaas-footer-links a:hover { border-bottom-style: solid; }

  #sstaas-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.45);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  #sstaas-overlay[hidden] { display: none; }
  #sstaas-overlay-card {
    background: #fff; color: #222; border-radius: 8px;
    max-width: 640px; width: calc(100% - 2rem); max-height: calc(100vh - 4rem);
    overflow: auto; padding: 1.25rem 1.5rem 1.5rem; position: relative;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25); line-height: 1.55;
  }
  #sstaas-overlay-close {
    position: absolute; top: 0.5rem; right: 0.7rem; background: transparent;
    border: 0; font-size: 1.4rem; cursor: pointer; color: #888;
  }
  #sstaas-overlay-body h1 { font-size: 1.25rem; margin-top: 0; }
  #sstaas-overlay-body h2 { font-size: 1.05rem; margin-top: 1.2rem; }
  #sstaas-overlay-body code {
    background: #eee; padding: 0.05rem 0.3rem; border-radius: 3px;
  }

  #sstaas-assets {
    position: fixed; bottom: 0; right: 0; width: min(360px, 100vw);
    max-height: 50vh; background: #fff; border-top: 1px solid #ccc;
    border-left: 1px solid #ccc; box-shadow: -2px -2px 8px rgba(0,0,0,0.1);
    overflow: auto; z-index: 500; font-size: 0.85rem;
  }
  .sstaas-assets-header {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; background: #fafaf7;
    position: sticky; top: 0;
  }
  .sstaas-assets-header span { color: #888; font-size: 0.78rem; margin-left: auto; }
  #sstaas-assets-close {
    background: transparent; border: 0; font-size: 1.1rem;
    cursor: pointer; color: #888; margin-left: 0.4rem;
  }
  #sstaas-assets-list { padding: 0.3rem 0.6rem; }
  .sstaas-asset-row {
    display: grid; grid-template-columns: 1fr auto auto;
    align-items: center; gap: 0.4rem;
    padding: 0.2rem 0.3rem; border-radius: 3px;
  }
  .sstaas-asset-row:hover { background: #f6f6f2; }
  .sstaas-asset-row.archived { opacity: 0.55; }
  .sstaas-asset-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sstaas-asset-size { font-size: 0.75rem; color: #888; font-variant-numeric: tabular-nums; }
  .sstaas-asset-keep { display: inline-flex; align-items: center; gap: 0.25rem;
    font-size: 0.75rem; color: #555; cursor: pointer; }
  .sstaas-asset-keep input { margin: 0; }
  .sstaas-placeholder { color: #888; font-style: italic; }
`;

// ---- Lifecycle ----

let isBridgeReadyRef = () => false;

export async function injectUI({ isBridgeReady } = {}) {
  isBridgeReadyRef = isBridgeReady ?? (() => false);

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // Insert controls bar at the very top of <body> (before <page>).
  const page = document.querySelector("page");
  if (page) page.insertAdjacentHTML("beforebegin", CONTROLS_HTML);
  else document.body.insertAdjacentHTML("afterbegin", CONTROLS_HTML);

  // Footer links: append into the existing footer.
  const footer = document.querySelector("footer");
  if (footer) footer.insertAdjacentHTML("beforeend", FOOTER_LINKS_HTML);

  // Overlay + assets panel live at end of body.
  document.body.insertAdjacentHTML("beforeend", OVERLAY_HTML);
  document.body.insertAdjacentHTML("beforeend", ASSETS_HTML);

  // Overlay click handlers.
  document.querySelectorAll("[data-overlay]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); showOverlay(a.dataset.overlay); })
  );
  document.getElementById("sstaas-overlay-close").addEventListener("click", hideOverlay);
  document.getElementById("sstaas-overlay").addEventListener("click", (e) => {
    if (e.target.id === "sstaas-overlay") hideOverlay();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("sstaas-overlay").hidden) hideOverlay();
  });

  // Assets panel close.
  document.getElementById("sstaas-assets-close").addEventListener("click", () => {
    document.getElementById("sstaas-assets").setAttribute("hidden", "");
  });

  // Drive controls.
  try { await initAuth(); }
  catch (err) {
    console.warn("auth init skipped:", err.message);
    setStatus("Sign-in unavailable (no OAuth client ID configured)");
  }

  document.getElementById("sstaas-signin").addEventListener("click", () => signIn());
  document.getElementById("sstaas-signout").addEventListener("click", () => {
    signOut();
    localStorage.removeItem(FOLDER_KEY);
    refresh();
  });
  document.getElementById("sstaas-pick-folder").addEventListener("click", async () => {
    const id = await drive.pickFolderManual();
    if (!id) return;
    localStorage.setItem(FOLDER_KEY, id);
    refresh();
  });
  document.getElementById("sstaas-reindex").addEventListener("click", () => runReindex());

  // Local folder bindings.
  document.getElementById("sstaas-local-pick").addEventListener("click", onLocalPick);
  document.getElementById("sstaas-local-fallback").addEventListener("change", (e) => {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) onLocalFallback(files);
  });
  document.getElementById("sstaas-local-refresh").addEventListener("click", onLocalRefresh);

  onAuthChange(refresh);
  refresh();

  // Try to restore a previously-bound folder for this session.
  restoreLocalFolder().catch((e) => console.warn("restore folder:", e.message));
  // Poll to turn the dot yellow when files on disk change.
  setInterval(() => pollForChanges().catch(() => {}), POLL_MS);
}

function refresh() {
  const signedIn = isSignedIn();
  const folder = localStorage.getItem(FOLDER_KEY);
  show("sstaas-signin", !signedIn);
  show("sstaas-signout", signedIn);
  show("sstaas-pick-folder", signedIn && !folder);
  show("sstaas-reindex", signedIn && !!folder);
  const fEl = document.getElementById("sstaas-folder");
  if (fEl) {
    if (folder) { fEl.textContent = folder; fEl.removeAttribute("hidden"); }
    else fEl.setAttribute("hidden", "");
  }
  if (signedIn && folder) refreshAssetsPanel(folder).catch((e) => console.warn("assets:", e.message));
  else show("sstaas-assets", false);
}

function show(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

function setStatus(t) {
  const el = document.getElementById("sstaas-status");
  if (el) el.textContent = t;
}

// ---- Local folder state ----
//
// One of these is live at a time for a given session:
//   { handle, label, lastFingerprint }   (FSAA path — survives reloads)
//   { label, files, lastFingerprint }    (webkitdirectory fallback — in-memory only)
// lastFingerprint is whatever the folder looked like AT THE TIME of
// the last successful parse, so pollForChanges can decide fresh vs stale.
let localState = null;

function showLocalRow(on) {
  show("sstaas-local-pick", !on);
  show("sstaas-local-row", on);
}

function setDot(kind, tooltip) {
  const dot = document.getElementById("sstaas-local-dot");
  if (!dot) return;
  dot.classList.remove("green", "yellow", "red");
  if (kind) dot.classList.add(kind);
  dot.title = tooltip ?? "";
}

function setLocalName(label) {
  const el = document.getElementById("sstaas-local-name");
  if (el) el.textContent = label;
}

async function onLocalPick() {
  if (!isBridgeReadyRef()) { alert("PGlite/WASM still loading."); return; }
  if (fh.hasFSAA()) {
    let handle;
    try {
      handle = await fh.openPicker();
    } catch (err) {
      // User cancelled the picker — don't treat it as an error.
      if (err && err.name === "AbortError") return;
      console.error(err);
      setStatus("Folder pick failed: " + err.message);
      return;
    }
    // Persist the handle. Swallow errors (some environments can't
    // structured-clone a given handle, or have IDB disabled); the
    // in-session binding still works either way.
    try { await fh.store(getSessionId(), handle); }
    catch (err) { console.warn("[sstaas] couldn't persist folder handle:", err.message); }
    localState = { handle, label: fh.labelFromHandle(handle), lastFingerprint: "" };
    showLocalRow(true);
    setLocalName(localState.label);
    setDot("yellow", "Newly picked — press refresh to parse");
    await parseFromHandle();
  } else {
    // Fallback: trigger the <input webkitdirectory> picker.
    document.getElementById("sstaas-local-fallback").click();
  }
}

async function onLocalFallback(files) {
  const label = fh.labelFromFileList(files);
  localState = { files, label, lastFingerprint: "" };
  showLocalRow(true);
  setLocalName(label);
  setDot("yellow", "Newly picked — press refresh to parse");
  await parseFromFiles(files);
}

async function onLocalRefresh() {
  if (!localState) return;
  if (localState.handle) {
    await parseFromHandle();
  } else if (localState.files) {
    // In the webkitdirectory fallback we can't re-walk without a
    // fresh pick — the File objects we captured are static.
    await parseFromFiles(localState.files);
  }
}

async function restoreLocalFolder() {
  const sessionId = getSessionId();
  const handle = await fh.loadStoredHandle(sessionId);
  if (!handle) return;
  const perm = await fh.queryPermission(handle);
  localState = { handle, label: fh.labelFromHandle(handle), lastFingerprint: "" };
  showLocalRow(true);
  setLocalName(localState.label);
  if (perm === "granted") {
    setDot("yellow", "Restored — press refresh to parse");
    // Note: cannot auto-parse on load, because the graph lives in
    // PGlite and PGlite is in-memory — re-parsing is still needed
    // each time the tab opens. User presses refresh to populate.
  } else {
    setDot("red", "Permission needed — press refresh to re-grant");
  }
}

async function parseFromHandle() {
  if (!localState?.handle) return;
  const refreshBtn = document.getElementById("sstaas-local-refresh");
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const perm = await fh.queryPermission(localState.handle);
    if (perm !== "granted") {
      const granted = await fh.requestPermission(localState.handle);
      if (granted !== "granted") {
        setDot("red", "Permission denied");
        setStatus("Permission denied for " + localState.label);
        return;
      }
    }
    const files = await fh.scan(localState.handle);
    await parseScanResult(files);
  } catch (err) {
    console.error("parseFromHandle", err);
    setDot("red", "Error: " + err.message);
    setStatus("Refresh failed: " + err.message);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// Shared path: takes either an FSAA scan result or a webkitdirectory
// File[] (wrapped as {name, path, file}) and runs parseN4L over it.
async function parseScanResult(files) {
  if (files.length === 0) {
    setStatus("No .n4l files found in the picked directory.");
    setDot("red", "No .n4l files");
    return;
  }
  setStatus(`Reading ${files.length} .n4l file(s)…`);
  const payload = {};
  for (const f of files) payload[f.path] = await f.file.text();
  setStatus(`Parsing ${files.length} file(s) — this takes a few seconds per file…`);
  const out = await parseN4L(payload);
  const fp = await fh.fingerprintFiles(files);
  if (localState) localState.lastFingerprint = fp;
  const errs = out.errors ?? [];
  const dotColor = errs.length ? "yellow" : "green";
  const dotMsg = errs.length
    ? `Parsed ${out.parsed?.length ?? 0}/${files.length} (${errs.length} failed) at ${new Date().toLocaleTimeString()}`
    : `Parsed ${files.length} file(s) at ${new Date().toLocaleTimeString()}`;
  setDot(dotColor, dotMsg);
  const nodeTotal = out.n1Directory + out.n2Directory + out.n3Directory + out.lt128 + out.lt1024 + out.gt1024;
  let status = `Parsed ${out.parsed?.length ?? 0} file(s). Nodes: ${nodeTotal}, arrows: ${out.arrowTotal}.`;
  if (errs.length) {
    const lines = errs.slice(0, 5).map((e) => `  • ${e.File} (line ${e.Line}): ${e.Err}`);
    if (errs.length > 5) lines.push(`  • …and ${errs.length - 5} more`);
    status += ` Failed files:\n` + lines.join("\n");
    console.warn("[sstaas parse]", errs);
  }
  setStatus(status);
}

async function parseFromFiles(files) {
  const refreshBtn = document.getElementById("sstaas-local-refresh");
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const n4ls = files
      .filter((f) => /\.n4l$/i.test(f.name))
      .map((f) => ({ name: f.name, path: f.webkitRelativePath || f.name, file: f }));
    await parseScanResult(n4ls);
  } catch (err) {
    console.error("parseFromFiles", err);
    setDot("red", "Error: " + err.message);
    setStatus("Open local failed: " + err.message);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

// Polled by setInterval. Only meaningful on the FSAA path (the
// webkitdirectory fallback can't rescan without a fresh user pick).
async function pollForChanges() {
  if (!localState?.handle || !localState.lastFingerprint) return;
  const perm = await fh.queryPermission(localState.handle);
  if (perm !== "granted") return; // don't surprise-prompt the user from a timer
  const files = await fh.scan(localState.handle);
  const fp = await fh.fingerprintFiles(files);
  const dot = document.getElementById("sstaas-local-dot");
  if (!dot) return;
  if (fp !== localState.lastFingerprint) {
    setDot("yellow", "Files changed on disk since last parse — press refresh");
  } else if (!dot.classList.contains("green")) {
    // Don't flip back to green if we're in an error state.
    if (!dot.classList.contains("red")) setDot("green", "Up to date");
  }
}

async function runReindex() {
  if (!isBridgeReadyRef()) { alert("PGlite/WASM still loading."); return; }
  const folder = localStorage.getItem(FOLDER_KEY);
  if (!folder) return;
  const btn = document.getElementById("sstaas-reindex");
  btn.disabled = true;
  try {
    const out = await reindex(folder, { onProgress: ({ message }) => setStatus(message) });
    setStatus(
      `Done. fetched=${out.fetched} active=${out.activeFiles} archived=${out.archivedFiles}` +
      (out.parser ? ` (parser: ${out.parser.note ?? "ok"})` : "")
    );
    await refreshAssetsPanel(folder);
  } catch (err) {
    console.error("reindex failed", err);
    setStatus("Re-index failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---- Overlay (legal pages) ----

const overlayCache = {};
async function showOverlay(name) {
  const ov = document.getElementById("sstaas-overlay");
  const body = document.getElementById("sstaas-overlay-body");
  body.innerHTML = "<p>Loading…</p>";
  ov.removeAttribute("hidden");
  try {
    if (!overlayCache[name]) {
      const r = await fetch(`/sstaas/legal/${name}.html`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      overlayCache[name] = await r.text();
    }
    body.innerHTML = overlayCache[name];
  } catch (err) {
    body.innerHTML = `<p>Failed to load: ${err.message}</p>`;
  }
}
function hideOverlay() {
  document.getElementById("sstaas-overlay").setAttribute("hidden", "");
}

// ---- Assets panel ----

function fmtBytes(n) {
  if (n == null) return "";
  const x = Number(n);
  if (x < 1024) return x + " B";
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + " KB";
  return (x / (1024 * 1024)).toFixed(1) + " MB";
}

async function refreshAssetsPanel(folderId) {
  const panel = document.getElementById("sstaas-assets");
  const list = document.getElementById("sstaas-assets-list");
  const summary = document.getElementById("sstaas-assets-summary");
  if (!panel || !list) return;

  let meta;
  try { meta = await drive.readMeta(folderId); }
  catch (err) {
    list.innerHTML = `<p class="sstaas-placeholder">Couldn't read meta: ${err.message}</p>`;
    panel.removeAttribute("hidden");
    return;
  }

  const entries = Object.entries(meta.assets ?? {});
  const cacheStats = await assets.summarize();
  if (summary) {
    summary.textContent =
      `${entries.length} listed · ${cacheStats.count} cached (${fmtBytes(cacheStats.totalBytes)})`;
  }

  if (entries.length === 0) {
    list.innerHTML = `<p class="sstaas-placeholder">No assets in this folder.</p>`;
    panel.removeAttribute("hidden");
    return;
  }

  entries.sort((a, b) => {
    if (a[1].status !== b[1].status) return a[1].status === "active" ? -1 : 1;
    return (a[1].name ?? "").localeCompare(b[1].name ?? "");
  });

  list.innerHTML = "";
  for (const [id, entry] of entries) {
    const row = document.createElement("div");
    row.className = "sstaas-asset-row" + (entry.status !== "active" ? " archived" : "");
    row.title = `${entry.name} · ${entry.mimeType ?? "?"} · status=${entry.status}`
      + (entry.cachedAt ? ` · cached ${entry.cachedAt}` : "");

    const name = document.createElement("span");
    name.className = "sstaas-asset-name";
    name.textContent = entry.name + (entry.status !== "active" ? "  (archived)" : "");

    const size = document.createElement("span");
    size.className = "sstaas-asset-size";
    size.textContent = fmtBytes(entry.size);

    const keep = document.createElement("label");
    keep.className = "sstaas-asset-keep";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!entry.keepOffline;
    cb.disabled = entry.status !== "active";
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        await setKeepOffline(folderId, meta, id, cb.checked);
        await drive.writeMeta(folderId, meta);
        await refreshAssetsPanel(folderId);
      } catch (err) {
        console.error("keep-offline toggle failed", err);
        cb.checked = !cb.checked;
        alert("Toggle failed: " + err.message);
        cb.disabled = false;
      }
    });
    keep.appendChild(cb);
    keep.appendChild(document.createTextNode("offline"));

    row.append(name, size, keep);
    list.appendChild(row);
  }
  panel.removeAttribute("hidden");
}
