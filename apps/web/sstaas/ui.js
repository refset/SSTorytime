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

const FOLDER_KEY = "sstaas-drive-folder-id";

// ---- Markup injection ----

const CONTROLS_HTML = `
  <div id="sstaas-controls">
    <button id="sstaas-signin" class="sstaas-btn">Sign in with Google</button>
    <button id="sstaas-signout" class="sstaas-btn" hidden>Sign out</button>
    <button id="sstaas-pick-folder" class="sstaas-btn" hidden>Choose Drive folder</button>
    <code id="sstaas-folder" class="sstaas-folder" hidden></code>
    <button id="sstaas-reindex" class="sstaas-btn primary" hidden>Re-index</button>
    <label for="sstaas-open-local" class="sstaas-btn" title="Pick a local directory; every .n4l inside is parsed. No Drive required.">Open local n4l directory</label>
    <input id="sstaas-open-local" type="file" webkitdirectory directory multiple hidden>
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
  document.getElementById("sstaas-open-local").addEventListener("change", (e) => {
    const input = e.target;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) runOpenLocal(files);
  });

  onAuthChange(refresh);
  refresh();
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

async function runOpenLocal(files) {
  if (!isBridgeReadyRef()) { alert("PGlite/WASM still loading."); return; }
  // webkitdirectory hands us everything under the picked folder
  // (recursively) — filter to *.n4l so we don't try to parse binaries
  // or dot-files.
  const n4ls = files.filter((f) => /\.n4l$/i.test(f.name));
  if (n4ls.length === 0) {
    setStatus(`No .n4l files found in the picked directory (${files.length} total files).`);
    return;
  }
  setStatus(`Reading ${n4ls.length} .n4l file(s)…`);
  const payload = {};
  try {
    for (const f of n4ls) {
      // webkitRelativePath is "<dir>/...path/file.n4l"; use it as the
      // key so two files with the same basename in different subfolders
      // don't clobber each other.
      const key = f.webkitRelativePath || f.name;
      payload[key] = await f.text();
    }
    setStatus(`Parsing ${n4ls.length} file(s) — this takes a few seconds per file…`);
    const out = await parseN4L(payload);
    setStatus(
      `Parsed ${out.parsed?.length ?? 0} file(s). ` +
      `Nodes: ${out.n1Directory + out.n2Directory + out.n3Directory + out.lt128 + out.lt1024 + out.gt1024}, ` +
      `arrows: ${out.arrowTotal}.`
    );
  } catch (err) {
    console.error("open-local failed", err);
    setStatus("Open local failed: " + err.message);
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
