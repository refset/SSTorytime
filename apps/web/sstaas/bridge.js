// WASM bridge. Loads sst.wasm on the main thread (no Worker needed —
// Go calls back into JS via Promises, so PGlite's async API and Go's
// goroutine-await pattern coexist on a single event loop).
//
// Exposes:
//   - initWasm(): loads + starts the Go runtime
//   - parseN4L(filesObj): forwards to __sstWasm.parseN4L(...)
//   - registers window.__sstQuery so Go (when wired) can run SQL.

import { query as dbQuery } from "./db.js";

let wasmStarted = false;

export async function initWasm() {
  if (wasmStarted) return;

  // Allow Go (via the pglite-js sql.Driver) to call PGlite. Returns a
  // Promise that resolves to { columns, types, rows, affectedRows }
  // on success, or rejects with an Error on SQL failure. Rejection is
  // important: Go's bridge distinguishes resolve vs. reject and turns
  // the latter into an `error` return from Query/Exec.
  // __sstProfile: counter + total PGlite time for coarse profiling.
  // Call window.__sstProfile.reset() before a run, read after.
  window.__sstProfile = {
    queries: 0, totalMs: 0, slowest: [],
    reset() { this.queries = 0; this.totalMs = 0; this.slowest = []; },
  };

  window.__sstQuery = async (sql, paramsJSON) => {
    let params = [];
    if (paramsJSON && paramsJSON !== "[]" && paramsJSON !== "null") {
      try { params = JSON.parse(paramsJSON); }
      catch { throw new Error("__sstQuery: bad params JSON"); }
    }
    const t0 = performance.now();
    try {
      return await dbQuery(sql, params);
    } finally {
      const dt = performance.now() - t0;
      const p = window.__sstProfile;
      p.queries++;
      p.totalMs += dt;
      if (dt > 50) {
        p.slowest.push({ ms: +dt.toFixed(1), sql: sql.slice(0, 120) });
        if (p.slowest.length > 20) {
          p.slowest.sort((a, b) => b.ms - a.ms);
          p.slowest.length = 20;
        }
      }
    }
  };

  // Load the Go runtime and the WASM module.
  await ensureGoRuntime();
  const go = new window.Go();
  const result = await WebAssembly.instantiateStreaming(fetch("/sstaas/sst.wasm"), go.importObject);
  go.run(result.instance); // do NOT await — main() blocks forever by design

  // Wait for Go's main() to publish __sstWasm.
  for (let i = 0; i < 200 && !window.__sstWasm; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!window.__sstWasm) throw new Error("WASM loaded but __sstWasm never appeared");

  // Bootstrap the SST session (CREATE TYPE / CREATE TABLE / CREATE
  // FUNCTION via the pglite-js sql.Driver). This is the heavy lift —
  // it runs upstream's Configure() against PGlite. Any error here
  // surfaces back to the SPA's status line.
  const openOut = await window.__sstWasm.open();
  console.log("SST.OpenWasm:", openOut);

  wasmStarted = true;
}

function ensureGoRuntime() {
  if (window.Go) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/sstaas/wasm_exec.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load wasm_exec.js"));
    document.head.appendChild(s);
  });
}

export async function parseN4L(filesObj) {
  if (!window.__sstWasm) throw new Error("WASM not initialized");
  const out = await window.__sstWasm.parseN4L(filesObj);
  // out is a JSON string per cmd/wasm/main.go
  return typeof out === "string" ? JSON.parse(out) : out;
}

// wasmSearch returns the upstream Response envelope verbatim — fetch-shim
// feeds it back to main.js as the JSON response to POST /searchN4L.
// Caller is responsible for parsing.
export async function wasmSearch(query) {
  if (!window.__sstWasm) throw new Error("WASM not initialized");
  return window.__sstWasm.search(query);
}

export function wasmVersion() {
  return window.__sstWasm?.version() ?? "(not loaded)";
}
