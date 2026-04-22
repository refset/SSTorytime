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
  `Configure()` against PGlite — CREATE TYPE NodePtr / Link /
  Appointment, CREATE TABLE Node / PageMap / ArrowDirectory /
  ArrowInverses / LastSeen / ContextDirectory, the dozen CREATE OR
  REPLACE FUNCTION definitions, and the unaccent shim all execute
  cleanly via the pglite-js driver.
- **Real N4L parsing + GraphToDB.** Directory picker (File System
  Access API, fallback to `<input webkitdirectory>`) feeds every
  `.n4l` in the chosen folder into `__sstWasm.parseN4L`, which runs
  `pkg/n4lparse.Parse` and then `SST.GraphToDB`. Verified against
  `examples/branches.n4l`: 14 nodes, 628 arrows, 8 PageMap entries.
- **Session identity in URL.** `?session=<id>` generated on first
  load; same URL across tabs binds the same local folder, different
  URLs are fully independent. Folder handle is persisted in an
  IndexedDB (`sstaas-folders`) keyed by session id; idb-open is
  timeout-capped so a hung DB never freezes the UI.
- **Folder status + change detection.** Dot goes green after a clean
  parse, flips yellow on a 30s poll whenever the fingerprint of
  `.n4l` files in the folder (name + size + lastModified) changes on
  disk, red on permission denied. ⟳ rescans + re-parses.
- **Search wired to the real schema.** `/searchN4L` delegates to
  `__sstWasm.search`, which mirrors upstream's HandleSearch:
  `DecodeSearchField → SolveNodePtrs → GetNodeOrbit → JSONNodeEvent →
  PackageResponse`. Envelope uses `json.RawMessage` for Content so
  upstream main.js's `obj.Content[0].Text` works. Initial empty-query
  FetchPage gets an empty Orbits response (Content=[]) to avoid
  DoOrbitPanel's string-iteration crash on Error-shaped payloads.
  A minimal `\toc` / chapter-only query returns a TOC response with
  chapter names + XYZ (no per-chapter context clusters yet).
- **Loading splash.** Full-viewport overlay with pulsing dots hides
  the SPA until PGlite + WASM + OpenWasm are ready. Messages step
  through phases; sticks red on bootstrap failure.

### Still TODO (the honest list)

#### Search features not yet ported from upstream HandleSearch

Currently wired: Orbits (name search), minimal TOC, and explanatory
"not yet wired" errors for the rest. The gaps:

- **`\stories` / `\sequence`** (`HandleStories`) — traverses `then`/
  sequence arrows to reconstruct narratives. Lightest of the
  unwired branches.
- **`\from X \to Y`** (`HandlePathSolve`) — paths between two node
  sets, with betweenness centrality + SuperNodes analysis. Pulls in
  `GetPathsAndSymmetries`, `BetweenNessCentrality`, `SuperNodes`.
- **`\from X` or `\to X` alone** (`HandleCausalCones`) — forward/
  backward causal cones. Needs `PackageConeFromOrigin`.
- **`\stats`** (`ShowStats`) — summary numbers over a result set.
- **`\page N`** (`HandlePageMap`) — look up notes by page number
  against the `PageMap` table.
- **`\arrow "foo"` and arrow-only filters** (`HandleMatchingArrows`) —
  arrow-type listings.
- **`\lastnptr` + session STM** (`UpdateLastSawSection` /
  `UpdateLastSawNPtr`) — records what the user most-recently viewed.
  Also feeds back into `Intent` / `Ambient`, which we currently
  emit as empty strings.
- **Richer TOC** (`ShowChapterContexts` full path) — upstream returns
  per-chapter `Context[]`, `Single[]`, `Common[]` built by
  `IntersectContextParts` + `ContextIntentAnalysis`. Helpers are in
  `src/server/http_server.go`, not `pkg/SSTorytime`, so porting them
  means either moving or copying.
- **`\help` content** — `CheckHelpQuery` rewrites the query but we
  don't surface help text anywhere.
- **Assets / images on node events** — a NodeEvent references asset
  names; `/SearchAssets` still returns "not implemented".

#### Infrastructure still missing

- **PGlite `idb://` persistence is broken in our environment.**
  Verified via isolated spikes: `new PGlite('idb://anything')` never
  resolves `waitReady`; in-memory comes up in ~7s. Parsed data wipes
  on every reload. Revisit when a future PGlite release fixes it or
  once we wire OPFS persistence (needs COOP/COEP headers GitHub
  Pages doesn't set).
- **Auto-parse on session-reload is a clickwait.** Because PGlite is
  in-memory, reloading a tab with a restored folder handle only
  restores the binding — user still has to press ⟳ to rebuild the
  graph. Goes away once persistence works.
- **Drive Picker not wired up.** Manual prompt-for-folder-ID only.
  Real Picker needs `picker.googleapis.com` + a referrer-restricted
  Browser API key. Terraform stub in `infra/gcp/main.tf` (commented).
- **Insert performance: ~14s for the 15-line `branches.n4l`.**
  One-Promise-per-statement round-trips. Levers worth measuring:
  bigger multi-statement batches, caching Configure + arrow upload
  across sessions (needs persistence), COPY-style bulk load for the
  arrow directory.
- **No tests for the JS modules.** Go side has `internal/pgtext` and
  `pkg/n4lparse/embeddedconfig_drift_test.go` coverage; JS is
  untested. Highest-value targets: `reindex.js`, `folder-handle.js`
  fingerprint + change detection, `db.js` looksMultiStatement.
- **Stale flat-schema tables in `db.js`.** `n4l_files` / `nodes` /
  `arrows` / `links` from the earlier scaffolding are unused now
  that the upstream schema is populated; safe to delete once no
  fetch-shim path depends on them.

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
