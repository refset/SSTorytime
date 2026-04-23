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
import { query as dbQuery } from "./db.js";
import { getSessionId } from "./session.js";
import * as fh from "./folder-handle.js";
import * as mcp from "./mcp-bridge.js";
import { BUILD } from "./build-info.js";

const TARGET_KEY = "sstaas-github-target";
const SOURCE_KEY = "sstaas-source-mode"; // "github" | "local" | null
const MCP_URL_KEY = "sstaas-mcp-url";
const MCP_ENABLED_KEY = "sstaas-mcp-enabled";
const DEFAULT_MCP_URL = "ws://localhost:8889/ws";
const POLL_MS = 30_000;

// ---- Source mode (github | local | none) ----
//
// Exactly one source drives the graph at a time. The choice is
// mirrored to the URL's ?source= param (+ owner/repo/branch/path for
// github) so a refresh is unambiguous. localStorage keeps the same
// info for when the user lands on the bare URL.

function parseUrlSource() {
  const p = new URLSearchParams(location.search);
  const s = p.get("source");
  if (s === "github") {
    const owner = p.get("owner") || "";
    const repo = p.get("repo") || "";
    if (!owner || !repo) return { mode: null };
    return {
      mode: "github",
      target: {
        owner, repo,
        branch: p.get("branch") || null,
        path: p.get("path") || null,
      },
    };
  }
  if (s === "local") return { mode: "local" };
  return { mode: null };
}

function writeUrlSource(mode, target) {
  const url = new URL(location.href);
  // Clear only the keys we own; preserve anything else (notably
  // upstream's ?search= param, which its AppRouter reads on load).
  for (const k of ["source", "owner", "repo", "branch", "path"]) {
    url.searchParams.delete(k);
  }
  if (mode === "github" && target) {
    url.searchParams.set("source", "github");
    url.searchParams.set("owner", target.owner);
    url.searchParams.set("repo", target.repo);
    if (target.branch) url.searchParams.set("branch", target.branch);
    if (target.path) url.searchParams.set("path", target.path);
  } else if (mode === "local") {
    url.searchParams.set("source", "local");
  }
  history.replaceState(null, "", url);
}

function getSource() {
  return localStorage.getItem(SOURCE_KEY);
}

function setSource(mode, target) {
  if (mode) localStorage.setItem(SOURCE_KEY, mode);
  else localStorage.removeItem(SOURCE_KEY);
  writeUrlSource(mode, target ?? (mode === "github" ? loadTarget() : null));
}

// ---- Markup injection ----

const CONTROLS_HTML = `
  <div id="sstaas-controls">
    <span class="sstaas-brand">
      <strong class="sstaas-brand-title">SSTorytime</strong>
      <a class="sstaas-brand-gh" href="https://github.com/refset/SSTorytime" target="_blank" rel="noopener" title="View the refset/SSTorytime fork on GitHub" aria-label="GitHub repository">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
    </span>

    <span id="sstaas-gh-who" class="sstaas-who" hidden>
      <span id="sstaas-gh-who-name"></span>
      <span class="sstaas-signout-wrap">(<a id="sstaas-signout" href="#" class="sstaas-signout-link">sign out</a>)</span>
    </span>

    <span id="sstaas-source-badge" class="sstaas-source-badge" data-mode="none">
      <span id="sstaas-source-value" class="sstaas-source-value">Load N4L from:</span>
      <button id="sstaas-signin" class="sstaas-source-choice">GitHub</button>
      <button id="sstaas-local-pick" class="sstaas-source-choice">Local folder</button>
      <a id="sstaas-source-switch" href="#" class="sstaas-switch-link" hidden title="Clear current source and pick again">change</a>
    </span>

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
      <button id="sstaas-reindex" class="sstaas-icon-btn" title="Re-list + re-fetch + re-parse">⟳</button>
    </span>

    <!-- Hidden file-input fallback for browsers without File System
         Access API. Triggered programmatically from onLocalPick. -->
    <input id="sstaas-local-fallback" type="file" webkitdirectory directory multiple hidden>

    <span id="sstaas-local-row" class="sstaas-local-row" hidden>
      <span id="sstaas-local-dot" class="sstaas-dot" title=""></span>
      <code id="sstaas-local-name" class="sstaas-folder"></code>
      <button id="sstaas-local-refresh" class="sstaas-icon-btn" title="Refresh: rescan folder + re-parse">⟳</button>
    </span>

    <!-- Local MCP hub toggle. When enabled, the SPA opens a WebSocket
         to a locally-running MCP-SST server so Claude Code can drive
         this tab's search. Opt-in; nothing connects until ticked. -->
    <label class="sstaas-mcp-row" title="Bridge this tab to a local MCP-SST server so Claude Code can call searches here.">
      <input id="sstaas-mcp-toggle" type="checkbox">
      <span>Use <a href="https://github.com/refset/SST-MCP" target="_blank" rel="noopener">MCP</a></span>
      <span id="sstaas-mcp-dot" class="sstaas-dot" title="Not connected" hidden></span>
    </label>

    <span id="sstaas-status" class="sstaas-status"></span>
  </div>`;

const BUILD_COMMIT_URL = BUILD.commit && BUILD.commit !== "dev"
  ? `https://github.com/markburgess/SSTorytime/commit/${BUILD.commit}`
  : null;
const BUILD_LABEL = BUILD_COMMIT_URL
  ? `build <a href="${BUILD_COMMIT_URL}" target="_blank" rel="noopener">${BUILD.commit}</a>`
  : `build ${BUILD.commit}`;

const FOOTER_LINKS_HTML = `
  <div id="sstaas-footer-links">
    <a href="#" data-overlay="about">About</a>
    · <a href="#" data-overlay="terms">Terms (v${CONFIG.termsVersion})</a>
    · <a href="#" data-overlay="privacy">Privacy (v${CONFIG.privacyVersion})</a>
    · <span class="sstaas-build"${BUILD.builtAt ? ` title="built ${BUILD.builtAt}"` : ""}>${BUILD_LABEL}</span>
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

  /* Upstream's <page> has no inline padding, and several descendants
     (section#canvas at max-width: 100svw, .card-view / .notes-view at
     95svw) hard-code viewport-relative widths that spill past any
     padding we put on <page>. Pad <page>, then clamp those
     descendants to the padded content area. */
  page {
    padding: 1rem clamp(1rem, 3vw, 2.5rem) 2rem;
    box-sizing: border-box;
    /* Force the implicit grid to a single flexible column that fits
       inside the padded content area. Without this, the column's
       width is derived from the widest child (section#canvas at
       100svw), which spills past the padding. */
    grid-template-columns: minmax(0, 1fr);
  }
  page > section#canvas {
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    justify-self: stretch;
  }
  page .card-view,
  page .notes-view {
    width: 100%;
    max-width: none;
    box-sizing: border-box;
  }
  @media (max-width: 600px) {
    page { padding: 0.75rem 0.75rem 1.5rem; }
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
  .sstaas-who { color: #555; font-size: 0.82rem; display: inline-flex; gap: 0.3rem; align-items: baseline; }
  .sstaas-signout-wrap { color: #888; font-size: 0.78rem; }
  .sstaas-signout-link {
    color: inherit; text-decoration: none; border-bottom: 1px dotted #aaa;
  }
  .sstaas-signout-link:hover { border-bottom-style: solid; color: #b33030; }
  .sstaas-gh-form { display: inline-flex; align-items: center; gap: 0.25rem; }
  .sstaas-input {
    padding: 0.2rem 0.35rem; border: 1px solid #c8c8c4; border-radius: 3px;
    font-size: 0.82rem; background: #fff; color: inherit;
  }
  .sstaas-sep { color: #888; }

  .sstaas-brand {
    display: inline-flex; align-items: center; gap: 0.35rem;
    margin-right: 0.25rem;
  }
  .sstaas-brand-title { font-size: 0.92rem; letter-spacing: 0.01em; }
  .sstaas-brand-gh {
    display: inline-flex; align-items: center; color: #555;
  }
  .sstaas-brand-gh:hover { color: #000; }

  .sstaas-source-badge {
    display: inline-flex; align-items: center; gap: 0.45rem;
    padding: 0.15rem 0.65rem; border-radius: 999px;
    background: #fff; border: 1px solid #c8c8c4;
    font-size: 0.82rem; color: #333;
  }
  .sstaas-source-badge[data-mode="github"] {
    background: #eef6ff; border-color: #4a86c8; color: #1c4577;
  }
  .sstaas-source-badge[data-mode="local"] {
    background: #eef7ee; border-color: #3a9a3a; color: #1f5a1f;
  }
  .sstaas-source-value { opacity: 0.85; }
  .sstaas-source-choice {
    padding: 0.1rem 0.55rem; font-size: 0.8rem;
    border: 1px solid #c8c8c4; background: #fff; color: inherit;
    border-radius: 4px; cursor: pointer;
  }
  .sstaas-source-choice:hover { background: #efefe9; }
  .sstaas-switch-link {
    color: inherit; opacity: 0.7; text-decoration: none;
    font-size: 0.75rem; border-bottom: 1px dotted currentColor;
  }
  .sstaas-switch-link:hover { opacity: 1; }

  .sstaas-local-row {
    display: inline-flex; align-items: center; gap: 0.35rem;
  }
  .sstaas-mcp-row {
    display: inline-flex; align-items: center; gap: 0.35rem;
    font-size: 0.82rem; color: #555; padding: 0.1rem 0.4rem;
    border: 1px dashed #c8c8c4; border-radius: 4px;
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
  #sstaas-footer-links .sstaas-build {
    color: #888; font-family: ui-monospace, Menlo, monospace; font-size: 0.78rem;
  }
  #sstaas-footer-links .sstaas-build a {
    color: inherit; border-bottom: 1px dotted #aaa;
  }

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

  // Reconcile URL with localStorage on load. URL wins when it carries
  // an explicit ?source=… so shared links land in the intended mode.
  const urlSrc = parseUrlSource();
  if (urlSrc.mode === "github" && urlSrc.target) {
    localStorage.setItem(TARGET_KEY, JSON.stringify(urlSrc.target));
    localStorage.setItem(SOURCE_KEY, "github");
  } else if (urlSrc.mode === "local") {
    localStorage.setItem(SOURCE_KEY, "local");
  } else if (getSource()) {
    // No URL param but localStorage remembers a mode — mirror it.
    writeUrlSource(getSource(), loadTarget());
  }

  document.getElementById("sstaas-source-switch").addEventListener("click", (e) => {
    e.preventDefault();
    onSwitchSource();
  });
  document.getElementById("sstaas-signin").addEventListener("click", onSignIn);
  document.getElementById("sstaas-signout").addEventListener("click", (e) => {
    e.preventDefault();
    signOut();
    localStorage.removeItem(TARGET_KEY);
    setSource(null);
    refresh();
  });
  document.getElementById("sstaas-gh-load").addEventListener("click", onLoadTarget);
  ["sstaas-gh-owner", "sstaas-gh-repo", "sstaas-gh-branch", "sstaas-gh-path"].forEach((id) => {
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); onLoadTarget(); }
    });
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

  // MCP bridge toggle. URL is sourced from localStorage (override via
  // config.local.js or devtools) — we don't expose it in the bar.
  const mcpToggle = document.getElementById("sstaas-mcp-toggle");
  mcpToggle.checked = localStorage.getItem(MCP_ENABLED_KEY) === "1";
  const mcpDot = document.getElementById("sstaas-mcp-dot");
  const syncMcpDotVisible = () => {
    if (!mcpDot) return;
    if (mcpToggle.checked) mcpDot.removeAttribute("hidden");
    else mcpDot.setAttribute("hidden", "");
  };
  syncMcpDotVisible();
  mcpToggle.addEventListener("change", () => {
    localStorage.setItem(MCP_ENABLED_KEY, mcpToggle.checked ? "1" : "0");
    syncMcpDotVisible();
    applyMcpToggle();
  });
  mcp.onStatusChange(({ status }) => {
    if (!mcpDot) return;
    mcpDot.classList.remove("green", "yellow", "red");
    const url = (localStorage.getItem(MCP_URL_KEY) || DEFAULT_MCP_URL).trim();
    if (status === "connected") { mcpDot.classList.add("green"); mcpDot.title = "Connected: " + url; }
    else if (status === "connecting") { mcpDot.classList.add("yellow"); mcpDot.title = "Connecting…"; }
    else if (status === "error") { mcpDot.classList.add("red"); mcpDot.title = "Connection error"; }
    else mcpDot.title = "Not connected";
  });
  applyMcpToggle();

  onAuthChange(refresh);
  refresh();

  restoreLocalFolder().catch((e) => console.warn("restore folder:", e.message));
  autoReindexIfEmpty().catch((e) => console.warn("auto-reindex:", e.message));
  setInterval(() => pollForChanges().catch(() => {}), POLL_MS);
}

// If the URL landed us in github mode with a fully-specified target
// but the local PGlite has nothing in it yet, kick off a reindex so
// a fresh visit / shared link doesn't require a manual ⟳ press.
async function autoReindexIfEmpty() {
  if (getSource() !== "github") return;
  const target = loadTarget();
  if (!target?.owner || !target?.repo) return;
  await (window.__sstaasReady?.() ?? Promise.resolve());
  const r = await dbQuery("SELECT count(*)::int AS n FROM n4l_files");
  const n = r?.rows?.[0]?.[0] ?? 0;
  if (n > 0) return;
  await runReindex();
}

// ---- GitHub flow ----

function loadTarget() {
  try { return JSON.parse(localStorage.getItem(TARGET_KEY) ?? "null"); }
  catch { return null; }
}

function applyMcpToggle() {
  const enabled = localStorage.getItem(MCP_ENABLED_KEY) === "1";
  const url = (localStorage.getItem(MCP_URL_KEY) || DEFAULT_MCP_URL).trim();
  if (enabled && url) {
    mcp.connect(url, { target: loadTarget() });
  } else {
    mcp.disconnect();
  }
}

function onSignIn() {
  // Already have a valid token? Skip the prompt, just switch mode.
  if (isSignedIn()) {
    setSource("github", loadTarget());
    refresh();
    return;
  }
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
     <div style="margin-top: 0.75rem; display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
       <button id="sstaas-gh-token-save" class="sstaas-btn primary">Save token</button>
       <a id="sstaas-gh-token-skip" href="#" style="font-size: 0.82rem; color: #555;">Skip for now — only access public repos</a>
       <span id="sstaas-gh-token-msg" style="color: #b33030; font-size: 0.85rem;"></span>
     </div>`
  );
  const input = document.getElementById("sstaas-gh-token-input");
  const msg   = document.getElementById("sstaas-gh-token-msg");
  const btn   = document.getElementById("sstaas-gh-token-save");
  const skip  = document.getElementById("sstaas-gh-token-skip");
  input.focus();
  const submit = async () => {
    btn.disabled = true;
    msg.textContent = "";
    try {
      const user = await signInWithToken(input.value);
      setSource("github", loadTarget());
      refresh();
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
  skip.addEventListener("click", (e) => {
    e.preventDefault();
    // Drop any cached target so the repo picker appears with its
    // defaults (markburgess / SSTorytime / main / examples).
    localStorage.removeItem(TARGET_KEY);
    setSource("github", null);
    refresh();
    hideOverlay();
    setStatus("Continuing without a token — public repos only, subject to GitHub's anonymous rate limits.");
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
  setSource("github", target);
  mcp.updateTarget(target);
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
    driveDefaultToc();
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

// Type \toc into the upstream search box and press Go, so the user
// lands on a populated table of contents right after a (re)index
// completes. Deferred so the "Parsed N file(s)…" status message has
// time to paint before upstream's fetch replaces the visible state.
// Skipped when the user has already typed something.
function driveDefaultToc() {
  const currentInput = document.getElementById("name");
  if (!currentInput) return;
  const startedEmpty = !currentInput.value || currentInput.value.trim() === "";
  if (!startedEmpty) return;
  setTimeout(() => {
    const input = document.getElementById("name");
    const button = document.getElementById("gosubmit");
    if (!input || !button) return;
    // Re-check: the user might have typed something during the delay.
    if (input.value && input.value.trim() !== "") return;
    input.value = "\\toc";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    button.click();
  }, 600);
}

async function refreshGitHubWho() {
  const who = document.getElementById("sstaas-gh-who-name");
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
  let mode = getSource();

  // Self-heal: if mode is local but we have no localState, the user
  // has no way to refresh — drop back to none. GitHub mode is
  // tolerated without a signed-in user so public repos work from a
  // shared ?source=github URL with no PAT in the browser.
  if (mode === "local" && !localState) mode = null;
  if (mode !== getSource()) setSource(mode);

  const inGithub = mode === "github";
  const inLocal  = mode === "local";
  const inNone   = !mode;

  // Inline chooser lives inside the badge when mode is none.
  show("sstaas-signin",     inNone);
  show("sstaas-local-pick", inNone);

  // GitHub controls: only while mode is github.
  show("sstaas-gh-who",  inGithub && signedIn);
  show("sstaas-gh-form", inGithub && !target);
  show("sstaas-gh-row",  inGithub && !!target);

  // Local controls: only while mode is local.
  show("sstaas-local-row", inLocal && !!localState);

  // Switch link is offered whenever a mode is chosen.
  show("sstaas-source-switch", !inNone);

  const badge = document.getElementById("sstaas-source-badge");
  const val   = document.getElementById("sstaas-source-value");
  if (badge) badge.dataset.mode = mode ?? "none";
  if (val) {
    if (inGithub && target) val.textContent = `GitHub · ${targetLabel(target)}`;
    else if (inGithub)      val.textContent = "GitHub · pick a repo";
    else if (inLocal)       val.textContent = `Local · ${localState?.label ?? "…"}`;
    else                    val.textContent = "Load N4L from:";
  }

  if (signedIn && inGithub) refreshGitHubWho();
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
    setSource("local");
    refresh();
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
  setSource("local");
  refresh();
  setLocalName(label);
  setDot("yellow", "Newly picked — press refresh to parse");
  await parseFromFiles(files);
}

function onSwitchSource() {
  // Tear down current source and return the user to the chooser.
  const mode = getSource();
  if (mode === "github") {
    localStorage.removeItem(TARGET_KEY);
  } else if (mode === "local") {
    localState = null;
    fh.clear(getSessionId()).catch(() => { /* best effort */ });
  }
  setSource(null);
  refresh();
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
  // Only auto-restore the handle when the active source is local.
  if (getSource() !== "local") return;
  const sessionId = getSessionId();
  const handle = await fh.loadStoredHandle(sessionId);
  if (!handle) return;
  const perm = await fh.queryPermission(handle);
  localState = { handle, label: fh.labelFromHandle(handle), lastFingerprint: "" };
  refresh();
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
  driveDefaultToc();
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

