# Client-side / Drive-backed SSToryGraph — roadmap

This branch (`client-side-drive`) is a re-fork of upstream
[SSTorytime](https://github.com/markburgess/SSTorytime) toward a
**fully client-side** model:

- App runs entirely in the browser (Go compiled to WASM, PGlite for
  storage, served as static files from GitHub Pages).
- Source-of-truth N4L files and assets live in a **Google Drive folder**
  the user picks.
- A `.sstaas-index.json` file in that folder tracks per-file state
  (active/archived, hash, keep-offline). Pressing **Re-index** diffs
  against that meta and processes anything new or changed.

Branch base: upstream tip (`b09c915` at fork time).

## Architecture

```
┌────────────── Browser tab ──────────────┐
│  Upstream's index.html + main.js        │
│  (untouched; build patches index.html   │
│   to inject our bootstrap script tag)   │
│                                         │
│  apps/web/sstaas/ modules:              │
│   bootstrap.js   first thing to run     │
│   fetch-shim.js  intercept /searchN4L,  │
│                   /SearchAssets,/Upload │
│   db.js          PGlite + flat schema   │
│   bridge.js      load WASM, expose      │
│                  __sstQuery for Go      │
│   auth.js        GIS token client       │
│   drive.js       Drive v3 REST          │
│   reindex.js     diff → fetch → parse   │
│   assets.js      IndexedDB blob cache   │
│   ui.js          inject 3 buttons +     │
│                  footer overlay markup  │
│   legal/*.html   About / Privacy / Terms│
│                                         │
│  cmd/wasm/main.go → sst.wasm            │
│   parseN4L(filesObj) → Promise<diff>    │
│   (currently a stub — see "Still TODO") │
└─────────────────────────────────────────┘
           │            │
           │ static     │ Drive v3 REST
           ▼            ▼
   GitHub Pages    Google Drive
   (index.html +   (.n4l + assets +
    main.js +       .sstaas-index.json)
    sstaas/)
```

### Why this shape

- **No Worker, no SharedArrayBuffer, no Atomics.** WASM runs on the
  main thread; Go and JS bridge via Promises (Go uses goroutines +
  `js.Func` callbacks to await JS Promises through channels). This
  drops the COOP/COEP service worker requirement entirely — plain
  static hosting works.
- **No edits to upstream's main.js.** Instead, `bootstrap.js` installs
  a `window.fetch` shim that catches the three URLs upstream's main.js
  expects (`/searchN4L`, `/SearchAssets`, `/Upload`) and routes them
  to local handlers. Build-time patch to index.html is just one line:
  inject the bootstrap script tag before `</head>`.
- **Asset model:** stream from Drive on demand by default; per-asset
  "offline" checkbox in the assets panel caches the blob in a separate
  IndexedDB (`sstaas-assets/blobs`) and writes `keepOffline=true` to
  the meta so any browser opening the same folder picks up the choice.

## Status

### Done in this branch
- `cmd/wasm/main.go` — Go-WASM entry exposing `version()`, `open()`,
  `nodeCount()`, `parseN4L()` on `window.__sstWasm`. Async via
  Promise+goroutine.
- `pkg/SSTorytime/driver_pglite_js.go` — `database/sql` driver that
  bridges to PGlite via `window.__sstQuery`. Handles bool/int/float
  scalars; everything else (text, tsvector, composites, arrays) comes
  through as strings, which matches what `lib/pq` does and what
  upstream's `ParseSQL*` helpers in `tools.go` already consume.
  `//go:build js && wasm`; native build untouched.
- `pkg/SSTorytime/unaccent_wasm.go` — installs an `unaccent(text)` SQL
  function (NFD + strip combining marks + small translate for
  non-decomposing letters like ø/ł/ß) so upstream's `sst_unaccent`
  wrapper resolves on PGlite, which lacks the unaccent extension.
- `pkg/SSTorytime/session_wasm.go` — `OpenWasm(loadArrows)` mirrors
  native `Open()` but talks to PGlite via the pglite-js driver,
  installs the unaccent shim before `Configure()`, and returns errors
  instead of `os.Exit`. Native `Open()` unchanged.
- `internal/pgtext` — pure-Go decoder/encoder for Postgres composite
  literals `(...)` and array literals `{...}`. Standalone, unit
  tested, used by the driver for any caller that wants to decode a
  composite/array string into typed values.
- `apps/web/sstaas/` — bootstrap, fetch shim, PGlite + flat schema,
  WASM bridge, GIS auth, Drive REST, re-index orchestrator with asset
  cache, UI injection (3 buttons + footer overlays + assets panel),
  legal copy, config.
- `apps/web/build.sh` — assembles `dist/` from upstream
  `src/server/public/` + `apps/web/sstaas/`, patches `index.html`,
  builds `sst.wasm`.
- `.github/workflows/pages.yml` — Go install → build → inject
  `vars.GOOGLE_OAUTH_CLIENT_ID` → upload to Pages.
- `infra/gcp/main.tf` + README — Drive API enable + manual-step
  checklist for OAuth consent screen and Web Client ID.

### End-to-end verified (browser, PGlite 0.4.4)
- WASM loads, Go runtime boots, `__sstWasm` global appears.
- `__sstWasm.open()` resolves `{ok: true}` after running upstream's
  `Configure()` against PGlite — that means CREATE TYPE NodePtr / Link /
  Appointment, CREATE TABLE Node / PageMap / ArrowDirectory /
  ArrowInverses / LastSeen / ContextDirectory, the dozen CREATE OR
  REPLACE FUNCTION definitions, and the unaccent shim all execute
  cleanly via the pglite-js driver.
- `__sstWasm.nodeCount()` returns `0` (round-trip Go → driver →
  `window.__sstQuery` → PGlite → back to Go works).

### Still TODO (the honest list)
- **PGlite `idb://` persistence is broken in our environment.** Verified
  via isolated spike pages: `new PGlite('idb://anything')` never
  resolves `waitReady`, while `new PGlite()` (in-memory) comes up in
  ~7s. Currently using in-memory; data wipes on refresh and Re-index
  rebuilds it from Drive. Revisit once a future PGlite release fixes
  it, or once we wire OPFS persistence (which needs cross-origin
  isolation headers GitHub Pages doesn't set today).
- **WASM N4L parser is still a stub.** `parseN4L()` echoes file
  metadata; the actual ingest into nodes/arrows/links isn't wired
  yet. With the driver in place this should now be straightforward —
  call upstream's parser and let it INSERT through the driver into
  PGlite.
- **Search is a placeholder.** The fetch-shim's `/searchN4L` handler
  does a simple `LIKE` lookup against the flat n4l_files table from
  the earlier scaffolding. Once the parser is wired, switch the
  handler to invoke a Go-side dispatcher that uses upstream's
  `SearchN4L`-style logic against the now-populated tables.
- **Drive Picker not wired up.** Folder selection is currently
  "paste a folder ID into a `prompt()`". Real Picker needs the
  `picker.googleapis.com` API + a Browser API Key restricted by
  referrer. Terraform stub for the key is in `infra/gcp/main.tf`
  (commented out).
- **Insert performance not yet profiled.** Each Go `db.Exec` becomes
  a Promise round-trip to JS+PGlite (1ms-ish baseline). Upstream's
  parser does many small inserts; once parsing is wired, we should
  measure with a real N4L file and decide whether to batch via
  transactions / multi-row INSERT / `COPY ... FROM STDIN`. Recording
  here so it doesn't get lost.
- **No tests for the JS modules.** Go side has `internal/pgtext` test
  coverage; JS modules are untested. `reindex.js` would be the
  highest-value target if we add JS tests.

## Local dev

```sh
# 1. OAuth client ID (one-time)
cp apps/web/sstaas/config.local.example.js apps/web/sstaas/config.local.js
# edit config.local.js with your client ID

# 2. Build dist/
sh apps/web/build.sh

# 3. Serve dist/ on http://localhost:18090
python3 -m http.server -d dist 18090

# 4. Open http://localhost:18090, click "Sign in with Google",
#    "Choose Drive folder" (paste a folder ID), then "Re-index".
```

## Deploy

1. Add `GOOGLE_OAUTH_CLIENT_ID` as a repo **variable** (Settings →
   Secrets and variables → Actions → Variables).
2. Settings → Pages → Source: GitHub Actions.
3. Push to `client-side-drive`. The workflow builds + deploys.
4. Add `https://<owner>.github.io/<repo>` to the Authorized JavaScript
   origins of the OAuth Web Client ID.

## Reference / older attempts

`client-side-drive-attempt-1` is an earlier branch I built on top of an
in-progress stash from a prior session. It carried features (editor
mode, OPFS browser, database-wipe panel) that are out of scope for
this fork. Kept around in the local repo for reference.
