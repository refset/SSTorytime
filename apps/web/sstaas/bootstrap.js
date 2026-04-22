// First-things-first bootstrap. Loaded BEFORE upstream's main.js so
// the fetch shim is in place by the time main.js makes its first
// /searchN4L call. PGlite + WASM init in parallel; UI injection
// doesn't wait for them so the user sees the legal links immediately
// even if WASM is slow to come up.

import { installFetchShim } from "./fetch-shim.js";
import { initDB } from "./db.js";
import { initWasm } from "./bridge.js";
import { injectUI } from "./ui.js";

let bridgeReady = false;
const ready = (async () => {
  installFetchShim();
  await initDB();
  await initWasm();
  bridgeReady = true;
  // Light up upstream's status indicators so the user sees we're alive.
  document.getElementById("server-status")?.classList.add("ok");
  document.getElementById("database-status")?.classList.add("ok");
})().catch((err) => {
  console.error("[sstaas bootstrap]", err);
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
