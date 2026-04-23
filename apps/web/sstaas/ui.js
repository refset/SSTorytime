// Adds the few new bits of UI on top of upstream's index.html — done
// in JS rather than by editing main.js so upstream's SPA stays
// untouched and easy to merge with future upstream changes.
//
// What we add:
//  1. A small controls bar in <header> with GitHub sign-in + a target
//     form (owner/repo/branch/path), a re-index button, plus the
//     local-folder alternative.
//  2. Footer links: About / Privacy / Terms (with version stamps).
//  3. A modal overlay container used by footer links and the GitHub
//     device-flow prompt.

import { CONFIG } from "./config.js";
import {
  initAuth, signInWithToken, signOut, isSignedIn, onAuthChange, getUser,
} from "./auth.js";
import { reindex } from "./reindex.js";
import { parseN4L } from "./bridge.js";
import { getSessionId } from "./session.js";
import * as fh from "./folder-handle.js";

const TARGET_KEY = "sstaas-github-target";
const POLL_MS = 30_000;

// ---- Markup injection ----

const CONTROLS_HTML = `
  <div id="sstaas-controls">
    <button id="sstaas-signin" class="sstaas-btn">Sign in with GitHub</button>
    <button id="sstaas-signout" class="sstaas-btn" hidden>Sign out</button>

    <span id="sstaas-gh-who" class="sstaas-who" hidden></span>

    <span id="sstaas-gh-form" class="sstaas-gh-form" hidden>
      <input id="sstaas-gh-owner" class="sstaas-input" placeholder="owner" size="12" value="markburgess">
      <span class="sstaas-sep">/</span>
      <input id="sstaas-gh-repo" class="sstaas-input" placeholder="repo" size="14" value="SSTorytime">
      <input id="sstaas-gh-branch" class="sstaas-input" placeholder="branch (opt)" size="10" value="main">
      <input id="sstaas-gh-path" class="sstaas-input" placeholder="path (opt)" size="10" value="examples">
      <button id="sstaas-gh-load" class="sstaas-btn primary">Load</button>
    </span>

    <span id="sstaas-gh-row" class="sstaas-local-row" hidden>
      <span id="sstaas-gh-dot" class="sstaas-dot" title=""></span>
      <code id="sstaas-gh-label" class="sstaas-folder"></code>
      <button id="sstaas-reindex" class="sstaas-icon-btn" title="Re-list + re-fetch + re-parse">⟳</button>
      <button id="sstaas-gh-change" class="sstaas-icon-btn" title="Pick a different target">✎</button>
    </span>

    <!-- Local-folder binding. One of these two is visible at a time:
         the pick button, or the picked-folder row. -->
    <button id="sstaas-local-pick" class="sstaas-btn" title="Pick a local directory; every .n4l inside is parsed. No GitHub required.">Open local n4l directory</button>
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
    font-size: 0.78rem; word-break: break-all; max-width: 36ch;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sstaas-status { color: #555; font-size: 0.82rem; min-width: 12rem; white-space: pre-line; }
  .sstaas-who { color: #555; font-size: 0.82rem; }
  .sstaas-gh-form { display: inline-flex; align-items: center; gap: 0.25rem; }
  .sstaas-input {
    padding: 0.2rem 0.35rem; border: 1px solid #c8c8c4; border-radius: 3px;
    font-size: 0.82rem; background: #fff; color: inherit;
  }
  .sstaas-sep { color: #888; }

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
`;

// ---- Lifecycle ----

let isBridgeReadyRef = () => false;

export async function injectUI({ isBridgeReady } = {}) {
  isBridgeReadyRef = isBridgeReady ?? (() => false);

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  const page = document.querySelector("page");
  if (page) page.insertAdjacentHTML("beforebegin", CONTROLS_HTML);
  else document.body.insertAdjacentHTML("afterbegin", CONTROLS_HTML);

  const footer = document.querySelector("footer");
  if (footer) footer.insertAdjacentHTML("beforeend", FOOTER_LINKS_HTML);

  document.body.insertAdjacentHTML("beforeend", OVERLAY_HTML);

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

  await initAuth();

  document.getElementById("sstaas-signin").addEventListener("click", onSignIn);
  document.getElementById("sstaas-signout").addEventListener("click", () => {
    signOut();
    localStorage.removeItem(TARGET_KEY);
    refresh();
  });
  document.getElementById("sstaas-gh-load").addEventListener("click", onLoadTarget);
  document.getElementById("sstaas-gh-change").addEventListener("click", () => {
    localStorage.removeItem(TARGET_KEY);
    refresh();
  });
  document.getElementById("sstaas-reindex").addEventListener("click", () => runReindex());

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

  restoreLocalFolder().catch((e) => console.warn("restore folder:", e.message));
  setInterval(() => pollForChanges().catch(() => {}), POLL_MS);
}

// ---- GitHub flow ----

function loadTarget() {
  try { return JSON.parse(localStorage.getItem(TARGET_KEY) ?? "null"); }
  catch { return null; }
}

function onSignIn() {
  const tokenUrl = "https://github.com/settings/personal-access-tokens/new";
  showOverlayHTML(
    `<h1>Sign in with a GitHub token</h1>
     <p>GitHub's OAuth endpoints don't support CORS, so pure-browser apps
        like this one authenticate with a personal access token instead.</p>
     <ol>
       <li>Open <a href="${tokenUrl}" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</li>
       <li>Give it a short expiry (7–30 days is plenty).</li>
       <li>Under <em>Repository access</em>, pick the specific repos this app should read.</li>
       <li>Under <em>Repository permissions</em>, grant <code>Contents: Read-only</code>.</li>
       <li>Generate, copy, and paste the token below.</li>
     </ol>
     <p>The token is stored only in your browser's localStorage. Sign out to delete it.</p>
     <textarea id="sstaas-gh-token-input" rows="3"
               style="width:100%; box-sizing:border-box; font-family: ui-monospace, monospace; font-size: 0.85rem; padding: 0.4rem;"
               placeholder="github_pat_…"></textarea>
     <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem; align-items: center;">
       <button id="sstaas-gh-token-save" class="sstaas-btn primary">Save token</button>
       <span id="sstaas-gh-token-msg" style="color: #b33030; font-size: 0.85rem;"></span>
     </div>`
  );
  const input = document.getElementById("sstaas-gh-token-input");
  const msg   = document.getElementById("sstaas-gh-token-msg");
  const btn   = document.getElementById("sstaas-gh-token-save");
  input.focus();
  const submit = async () => {
    btn.disabled = true;
    msg.textContent = "";
    try {
      const user = await signInWithToken(input.value);
      hideOverlay();
      setStatus(`Signed in to GitHub as @${user.login}.`);
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  });
}

async function onLoadTarget() {
  const owner  = document.getElementById("sstaas-gh-owner").value.trim();
  const repo   = document.getElementById("sstaas-gh-repo").value.trim();
  const branch = document.getElementById("sstaas-gh-branch").value.trim() || null;
  const path   = document.getElementById("sstaas-gh-path").value.trim() || null;
  if (!owner || !repo) { setStatus("Owner and repo are required."); return; }
  const target = { owner, repo, branch, path };
  localStorage.setItem(TARGET_KEY, JSON.stringify(target));
  refresh();
  setDot("yellow", "Target loaded — press ⟳ to index", "sstaas-gh-dot");
  await runReindex();
}

async function runReindex() {
  if (!isBridgeReadyRef()) { alert("PGlite/WASM still loading."); return; }
  const target = loadTarget();
  if (!target) return;
  const btn = document.getElementById("sstaas-reindex");
  btn.disabled = true;
  setDot("yellow", "Re-indexing…", "sstaas-gh-dot");
  const t0 = performance.now();
  try {
    const { out, fileCount, branch } = await reindex(target, {
      onProgress: ({ message }) => setStatus(message),
    });
    if (branch && !target.branch) {
      target.branch = branch;
      localStorage.setItem(TARGET_KEY, JSON.stringify(target));
      refresh();
    }
    if (fileCount === 0) {
      setDot("red", "No .n4l files at that path", "sstaas-gh-dot");
      return;
    }
    reportParseResult(out, fileCount, "sstaas-gh-dot", performance.now() - t0);
  } catch (err) {
    console.error("reindex failed", err);
    setDot("red", "Error: " + err.message, "sstaas-gh-dot");
    setStatus("Re-index failed: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

function targetLabel(t) {
  return `${t.owner}/${t.repo}${t.branch ? `@${t.branch}` : ""}${t.path ? `:${t.path}` : ""}`;
}

async function refreshGitHubWho() {
  const who = document.getElementById("sstaas-gh-who");
  if (!who) return;
  if (!isSignedIn()) { who.textContent = ""; return; }
  try {
    const u = await getUser();
    who.textContent = u ? `@${u.login}` : "";
  } catch (err) {
    who.textContent = "";
    console.warn("github user fetch:", err.message);
  }
}

// ---- Shared ----

function refresh() {
  const signedIn = isSignedIn();
  const target = loadTarget();
  show("sstaas-signin", !signedIn);
  show("sstaas-signout", signedIn);
  show("sstaas-gh-who", signedIn);
  show("sstaas-gh-form", signedIn && !target);
  show("sstaas-gh-row", signedIn && !!target);
  const fEl = document.getElementById("sstaas-gh-label");
  if (fEl && target) {
    fEl.textContent = targetLabel(target);
    fEl.title = targetLabel(target);
  }
  if (signedIn) refreshGitHubWho();
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

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

function setDot(kind, tooltip, dotId = "sstaas-local-dot") {
  const dot = document.getElementById(dotId);
  if (!dot) return;
  dot.classList.remove("green", "yellow", "red");
  if (kind) dot.classList.add(kind);
  dot.title = tooltip ?? "";
}

function reportParseResult(out, fileCount, dotId, elapsedMs) {
  const errs = out?.errors ?? [];
  const dotColor = errs.length ? "yellow" : "green";
  const dotMsg = errs.length
    ? `Parsed ${out.parsed?.length ?? 0}/${fileCount} (${errs.length} failed) at ${new Date().toLocaleTimeString()}`
    : `Parsed ${fileCount} file(s) at ${new Date().toLocaleTimeString()}`;
  setDot(dotColor, dotMsg, dotId);
  const nodeTotal =
    (out?.n1Directory ?? 0) + (out?.n2Directory ?? 0) + (out?.n3Directory ?? 0) +
    (out?.lt128 ?? 0) + (out?.lt1024 ?? 0) + (out?.gt1024 ?? 0);
  const timing = elapsedMs != null ? ` (${fmtDuration(elapsedMs)})` : "";
  let status = `Parsed ${out?.parsed?.length ?? 0} file(s). Nodes: ${nodeTotal}, arrows: ${out?.arrowTotal ?? 0}${timing}.`;
  if (errs.length) {
    const lines = errs.slice(0, 5).map((e) => `  • ${e.File} (line ${e.Line}): ${e.Err}`);
    if (errs.length > 5) lines.push(`  • …and ${errs.length - 5} more`);
    status += ` Failed files:\n` + lines.join("\n");
    console.warn("[sstaas parse]", errs);
  }
  setStatus(status);
}

// ---- Local folder state ----
//
// One of these is live at a time for a given session:
//   { handle, label, lastFingerprint }   (FSAA path — survives reloads)
//   { label, files, lastFingerprint }    (webkitdirectory fallback — in-memory only)
let localState = null;

function showLocalRow(on) {
  show("sstaas-local-pick", !on);
  show("sstaas-local-row", on);
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
      if (err && err.name === "AbortError") return;
      console.error(err);
      setStatus("Folder pick failed: " + err.message);
      return;
    }
    try { await fh.store(getSessionId(), handle); }
    catch (err) { console.warn("[sstaas] couldn't persist folder handle:", err.message); }
    localState = { handle, label: fh.labelFromHandle(handle), lastFingerprint: "" };
    showLocalRow(true);
    setLocalName(localState.label);
    setDot("yellow", "Newly picked — press refresh to parse");
    await parseFromHandle();
  } else {
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

async function parseScanResult(files) {
  const n4lFiles = files.filter((f) => (f.kind ?? "n4l") === "n4l");
  const cfgFiles = files.filter((f) => f.kind === "config");
  if (n4lFiles.length === 0) {
    setStatus("No .n4l files found in the picked directory.");
    setDot("red", "No .n4l files");
    return;
  }
  const cfgSuffix = cfgFiles.length
    ? ` (plus ${cfgFiles.length} SSTconfig file(s))`
    : "";
  setStatus(`Reading ${n4lFiles.length} .n4l file(s)${cfgSuffix}…`);
  const payload = {};
  for (const f of n4lFiles) payload[f.path] = await f.file.text();
  const configs = {};
  for (const f of cfgFiles) configs[f.path] = await f.file.text();
  setStatus(`Parsing ${n4lFiles.length} file(s) — this takes a few seconds per file…`);
  const t0 = performance.now();
  const out = await parseN4L(payload, cfgFiles.length ? configs : undefined, {
    onProgress: (msg) => setStatus(msg),
  });
  const fp = await fh.fingerprintFiles(files);
  if (localState) localState.lastFingerprint = fp;
  reportParseResult(out, n4lFiles.length, "sstaas-local-dot", performance.now() - t0);
}

async function parseFromFiles(files) {
  const refreshBtn = document.getElementById("sstaas-local-refresh");
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const picked = files
      .map((f) => {
        const path = f.webkitRelativePath || f.name;
        const isN4L = /\.n4l$/i.test(f.name);
        const isConfig = /\.sst$/i.test(f.name) && /(^|\/)SSTconfig\//i.test(path);
        if (!isN4L && !isConfig) return null;
        return { name: f.name, path, file: f, kind: isConfig ? "config" : "n4l" };
      })
      .filter(Boolean);
    await parseScanResult(picked);
  } catch (err) {
    console.error("parseFromFiles", err);
    setDot("red", "Error: " + err.message);
    setStatus("Open local failed: " + err.message);
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

async function pollForChanges() {
  if (!localState?.handle || !localState.lastFingerprint) return;
  const perm = await fh.queryPermission(localState.handle);
  if (perm !== "granted") return;
  const files = await fh.scan(localState.handle);
  const fp = await fh.fingerprintFiles(files);
  const dot = document.getElementById("sstaas-local-dot");
  if (!dot) return;
  if (fp !== localState.lastFingerprint) {
    setDot("yellow", "Files changed on disk since last parse — press refresh");
  } else if (!dot.classList.contains("green")) {
    if (!dot.classList.contains("red")) setDot("green", "Up to date");
  }
}

// ---- Overlay (legal pages + device-flow prompt) ----

const overlayCache = {};
async function showOverlay(name) {
  const ov = document.getElementById("sstaas-overlay");
  const body = document.getElementById("sstaas-overlay-body");
  body.innerHTML = "<p>Loading…</p>";
  ov.removeAttribute("hidden");
  try {
    if (!overlayCache[name]) {
      const r = await fetch(new URL(`./legal/${name}.html`, import.meta.url));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      overlayCache[name] = await r.text();
    }
    body.innerHTML = overlayCache[name];
  } catch (err) {
    body.innerHTML = `<p>Failed to load: ${err.message}</p>`;
  }
}
function showOverlayHTML(html) {
  const ov = document.getElementById("sstaas-overlay");
  const body = document.getElementById("sstaas-overlay-body");
  body.innerHTML = html;
  ov.removeAttribute("hidden");
}
function hideOverlay() {
  document.getElementById("sstaas-overlay").setAttribute("hidden", "");
}

