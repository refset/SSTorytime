// Intercepts the network calls upstream's main.js makes to the
// (no-longer-present) Go server, and routes them to local handlers
// backed by PGlite.
//
// Endpoints intercepted:
//   POST /searchN4L     → local search against PGlite
//   POST /SearchAssets  → local asset search
//   POST /Upload        → upload to user's Drive folder
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
  const name = (body.name ?? body.query ?? "").trim();
  if (!name) return packageResponse("Error", JSON.stringify("(empty query)"));
  const raw = await wasmSearch(name);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function handleSearchAssets(body) {
  return packageResponse("Error", JSON.stringify(
    "Asset search not yet implemented in client-side fork."
  ));
}

async function handleUpload(body) {
  return packageResponse("Error", JSON.stringify(
    "Direct /Upload not supported. Drop files into your chosen Google Drive folder, " +
    "then press Re-index."
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
