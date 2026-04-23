// First-things-first bootstrap. Loaded BEFORE upstream's main.js so
// the fetch shim is in place by the time main.js makes its first
// /searchN4L call. PGlite + WASM init in parallel; UI injection
// doesn't wait for them so the user sees the legal links immediately
// even if WASM is slow to come up.

import { installFetchShim } from "./fetch-shim.js";
import { initDB } from "./db.js";
import { initWasm } from "./bridge.js";
import { injectUI } from "./ui.js";
import { showSplash, setSplashMessage, hideSplash } from "./splash.js";

// Upstream's pushStateSafe rewrites the URL to `?search=…`, wiping
// any other query params. We carry ?source= / ?owner= / etc. in the
// URL so reloads are unambiguous, so patch history.pushState +
// history.replaceState to merge our keys back in whenever upstream
// pushes a new URL.
(function patchHistoryToPreserveSourceParams() {
  const OUR_KEYS = ["source", "owner", "repo", "branch", "path"];
  function merge(target) {
    try {
      const here = new URL(location.href);
      const there = new URL(target, location.href);
      for (const k of OUR_KEYS) {
        if (!there.searchParams.has(k) && here.searchParams.has(k)) {
          there.searchParams.set(k, here.searchParams.get(k));
        }
      }
      return there.pathname + there.search + there.hash;
    } catch { return target; }
  }
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (state, title, url) {
    return origPush(state, title, url == null ? url : merge(url));
  };
  history.replaceState = function (state, title, url) {
    return origReplace(state, title, url == null ? url : merge(url));
  };
})();

// Splash goes up as early as possible — synchronously, once the body
// exists. After that PGlite / WASM / SST.OpenWasm run, each updating
// the splash message, and the whole thing fades away together. If any
// step fails the splash stays visible with a red error.
function withSplashOnce(fn) {
  if (document.body) { fn(); return; }
  document.addEventListener("DOMContentLoaded", fn, { once: true });
}
withSplashOnce(() => showSplash());

// Publish the ready promise synchronously BEFORE installFetchShim
// runs — otherwise the queued fetches replayed by flushFetchQueue
// resume with __sstaasReady still undefined, skip the await, and
// dispatch to WASM before it's up. See fetch-shim.js for why.
let bridgeReady = false;
let resolveReady, rejectReady;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
window.__sstaasReady = () => ready;

(async () => {
  installFetchShim();
  withSplashOnce(() => setSplashMessage("Initialising local database…"));
  await initDB();
  withSplashOnce(() => setSplashMessage("Starting WASM runtime…"));
  await initWasm();
  bridgeReady = true;
  document.getElementById("server-status")?.classList.add("ok");
  document.getElementById("database-status")?.classList.add("ok");
  hideSplash();
  resolveReady();
})().catch((err) => {
  console.error("[sstaas bootstrap]", err);
  setSplashMessage("Bootstrap failed: " + err.message, true);
  document.getElementById("sstaas-status")?.replaceChildren(
    document.createTextNode("Bootstrap failed: " + err.message)
  );
  rejectReady(err);
});

// Inject UI as soon as DOM is parsed; injection itself is fine without
// the bridge being ready (the buttons gate themselves on it).
function start() {
  injectUI({ isBridgeReady: () => bridgeReady }).catch((err) =>
    console.warn("[sstaas ui]", err.message)
  );
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

