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

// Splash goes up as early as possible — synchronously, once the body
// exists. After that PGlite / WASM / SST.OpenWasm run, each updating
// the splash message, and the whole thing fades away together. If any
// step fails the splash stays visible with a red error.
function withSplashOnce(fn) {
  if (document.body) { fn(); return; }
  document.addEventListener("DOMContentLoaded", fn, { once: true });
}
withSplashOnce(() => showSplash());

let bridgeReady = false;
const ready = (async () => {
  installFetchShim();
  withSplashOnce(() => setSplashMessage("Initialising local database…"));
  await initDB();
  withSplashOnce(() => setSplashMessage("Starting WASM runtime…"));
  await initWasm();
  bridgeReady = true;
  // Light up upstream's status indicators so the user sees we're alive.
  document.getElementById("server-status")?.classList.add("ok");
  document.getElementById("database-status")?.classList.add("ok");
  hideSplash();
})().catch((err) => {
  console.error("[sstaas bootstrap]", err);
  setSplashMessage("Bootstrap failed: " + err.message, true);
  document.getElementById("sstaas-status")?.replaceChildren(
    document.createTextNode("Bootstrap failed: " + err.message)
  );
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

// Expose for debugging.
window.__sstaasReady = () => ready;
