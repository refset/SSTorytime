// Intercepts the network calls upstream's main.js makes to the
// (no-longer-present) Go server, and routes them to local handlers
// backed by PGlite.
//
// Endpoints intercepted:
//   POST /searchN4L     → local search against PGlite
//   POST /SearchAssets  → local asset search
//   POST /Upload        → upload to the connected GitHub repo path
//
// All other URLs pass through to the real fetch.

import { query as dbQuery, getDB } from "./db.js";
import { wasmSearch } from "./bridge.js";

const HANDLERS = {
  "/searchN4L":    handleSearchN4L,
  "/SearchAssets": handleSearchAssets,
  "/Upload":       handleUpload,
};

export function installFetchShim() {
  // The inline pre-shim in index.html already captured the original
  // fetch and queued any intercepted calls. Grab its reference so our
  // passthrough doesn't loop forever.
  const origFetch = window.__sstaasOrigFetch ?? window.fetch.bind(window);

  const real = async (input, init) => {
    const url = (typeof input === "string" ? input : input?.url) ?? "";
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const handler = HANDLERS[path];
    if (!handler) return origFetch(input, init);
    try {
      // Upstream's InitializeApp() fires sendLinkSearch() from the
      // DOMContentLoaded handler, which happens long before PGlite +
      // WASM + OpenWasm finish. If we dispatched immediately we'd
      // throw "WASM not initialized"; the shim would return a 500;
      // upstream's sendLinkSearch would swallow that via .catch and
      // never call stopHipnotize() — leaving the loader spinning
      // forever. Block until the bridge is up so the first user-
      // visible response comes back cleanly instead.
      await window.__sstaasReady?.();
      const body = await readBody(init);
      const responseJSON = await handler(body);
      return new Response(JSON.stringify(responseJSON), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      console.error("[sstaas shim]", path, e);
      return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  // Tell the pre-shim to use `real` for any further matching calls,
  // and drain anything queued while we were loading.
  window.__sstaasReal = real;
  window.__sstaasFlushFetchQueue?.();
}

async function readBody(init) {
  if (!init?.body) return {};
  if (init.body instanceof FormData) {
    const obj = {};
    for (const [k, v] of init.body.entries()) obj[k] = v;
    return obj;
  }
  if (typeof init.body === "string") {
    try { return JSON.parse(init.body); } catch { return { raw: init.body }; }
  }
  return {};
}

// ---- /searchN4L ----
//
// Delegates to the WASM side, which drives the same HandleOrbit code
// path upstream's native server uses: DecodeSearchField → SolveNodePtrs
// → GetNodeOrbit → JSONNodeEvent → PackageResponse. Upstream's UI in
// main.js treats the response as the raw envelope it used to get from
// the Go server, so we return that envelope verbatim.
async function handleSearchN4L(body) {
  // Note: empty query goes through to WASM, not short-circuited to
  // Error here — upstream's FetchPage (initial page load) calls
  // DoOrbitPanel unconditionally on the response, and DoOrbitPanel
  // crashes on anything except an Orbits envelope. jsSearch returns
  // an empty-Orbits response for empty queries so that path is safe.
  let name = (body.name ?? body.query ?? "").trim();

  // Initial load (no query) behavior:
  //  - If no source is chosen yet, return an empty Orbits envelope
  //    so the SPA shows "No result" instead of trying to render
  //    against an empty PGlite. Nothing fetches, nothing flashes.
  //  - If a source is chosen, default to \toc so the user lands on
  //    a useful overview instead of the time-of-day reminders query.
  if (!name) {
    // Initial page load (upstream's FetchPage with no body). We never
    // fire a real search here — if a source is picked, ui.js drives
    // \toc after the (re)index completes; if not, the empty envelope
    // just yields "No result" in the SPA.
    return emptyOrbits();
  }

  const useSpinner = (body.name ?? body.query ?? "").trim() !== "";
  if (useSpinner) await showSpinner(`Searching for "${name}"…`);
  try {
    const raw = await wasmSearch(name);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } finally {
    if (useSpinner) hideSpinner();
  }
}

function emptyOrbits() {
  return {
    Response: "Orbits",
    Content: [],
    Time: "",
    Intent: "",
    Ambient: "",
  };
}

// ---- Spinner ----
//
// WASM search runs on the main thread and can block for seconds on
// large graphs. Showing a fullscreen overlay doesn't make it faster,
// but it tells the user the tab isn't dead. The double-rAF + setTimeout
// forces a paint before we kick off the blocking call.

let spinnerEl = null;
function ensureSpinner() {
  if (spinnerEl) return spinnerEl;
  const style = document.createElement("style");
  style.textContent = `
    #sstaas-spinner {
      position: fixed; inset: 0; background: rgba(255,255,255,0.75);
      display: flex; align-items: center; justify-content: center;
      z-index: 2000; flex-direction: column; gap: 1rem; color: #333;
      font-size: 0.9rem; backdrop-filter: blur(1px);
    }
    #sstaas-spinner[hidden] { display: none; }
    #sstaas-spinner .sstaas-spin {
      width: 2rem; height: 2rem; border-radius: 50%;
      border: 3px solid #c8c8c4; border-top-color: #4a86c8;
      animation: sstaas-spin 0.9s linear infinite;
    }
    @keyframes sstaas-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "sstaas-spinner";
  el.setAttribute("hidden", "");
  el.innerHTML = `<div class="sstaas-spin"></div><div id="sstaas-spinner-msg"></div>`;
  document.body.appendChild(el);
  spinnerEl = el;
  return el;
}

function showSpinner(message) {
  const el = ensureSpinner();
  el.querySelector("#sstaas-spinner-msg").textContent = message ?? "";
  el.removeAttribute("hidden");
  // Force a paint before the caller starts blocking work.
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

function hideSpinner() {
  if (spinnerEl) spinnerEl.setAttribute("hidden", "");
}

async function handleSearchAssets(body) {
  return packageResponse("Error", JSON.stringify(
    "Asset search not yet implemented in client-side fork."
  ));
}

async function handleUpload(body) {
  return packageResponse("Error", JSON.stringify(
    "Direct /Upload not supported. Push files to your chosen GitHub repo, " +
    "then press re-index."
  ));
}

function packageResponse(kind, contentJSONString) {
  return {
    Response: kind,
    Content: contentJSONString,
    Time: new Date().toISOString(),
    Intent: {},
    Ambient: {},
  };
}
