# Client-side / GitHub-backed SSToryGraph — roadmap

This fork is a re-fork of upstream
[SSTorytime](https://github.com/markburgess/SSTorytime) toward a
**fully client-side** model:

- App runs entirely in the browser (Go compiled to WASM, PGlite for
  storage, served as static files from GitHub Pages).
- Source-of-truth N4L files live in a **GitHub repo** the user points
  at (owner/repo/branch/path) or a **local directory** picked through
  the File System Access API.
- Authentication is a **personal access token paste** (GitHub's OAuth
  endpoints don't send CORS headers, so device flow and web flow both
  need a backend; PAT is the only zero-infra path).

The deployed SPA lives at https://refset.github.io/SSTorytime/.

## Architecture

```
┌────────────── Browser tab ──────────────┐
│  Upstream's index.html + main.js        │
│  (untouched; build patches index.html   │
│   to inject our bootstrap script tag +  │
│   rewrites absolute asset paths)        │
│                                         │
│  apps/web/sstaas/ modules:              │
│   bootstrap.js   first thing to run     │
│   fetch-shim.js  intercept /searchN4L,  │
│                   /SearchAssets,/Upload │
│                   + fullscreen spinner  │
│   db.js          PGlite + flat schema   │
│   bridge.js      load WASM, expose      │
│                  __sstQuery for Go      │
│   auth.js        GitHub PAT store       │
│   github.js      REST helpers (tree +   │
│                  contents)              │
│   reindex.js     list → fetch → parse   │
│   folder-handle.js  FSAA + IDB persist  │
│   ui.js          inject controls bar +  │
│                  footer overlay + modal │
│   legal/*.html   About / Privacy / Terms│
│                                         │
│  cmd/wasm/main.go → sst.wasm            │
│   parseN4L(files, configs, onProgress)  │
│   search(name)                          │
└─────────────────────────────────────────┘
           │            │
           │ static     │ api.github.com
           ▼            ▼
   GitHub Pages    GitHub repo
   (index.html +   (.n4l + SSTconfig/*.sst)
    main.js +
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
  to local handlers. Build-time patch to index.html is one injection
  (bootstrap script tag + queueing pre-shim), plus a regex to strip
  leading slashes from upstream asset paths so the SPA works under
  the `/SSTorytime/` Pages subpath.
- **PAT-only, no OAuth app, no verification.** The user pastes a
  GitHub personal access token scoped to the repo they want indexed.
  Token lives only in their browser's localStorage. No backend, no
  client secret, no consent-screen verification process.

## Status

### Done
- `cmd/wasm/main.go` — Go-WASM entry exposing `version()`, `open()`,
  `nodeCount()`, `parseN4L(files, configs, onProgress)`, `search()` on
  `window.__sstWasm`. Async via Promise+goroutine.
- `pkg/SSTorytime/driver_pglite_js.go` — `database/sql` driver that
  bridges to PGlite via `window.__sstQuery`. `//go:build js && wasm`;
  native build untouched.
- `pkg/SSTorytime/unaccent_wasm.go` — installs an `unaccent(text)` SQL
  function (NFD + strip combining marks + translate for non-decomposing
  letters) so upstream's `sst_unaccent` resolves on PGlite.
- `pkg/SSTorytime/session_wasm.go` — `OpenWasm(loadArrows)` mirrors
  native `Open()` but talks to PGlite via the pglite-js driver.
- `pkg/n4lparse/api.go` — `ParseWithConfigs(sst, configs, files,
  progress)` with a new optional `ProgressFn` callback for per-file
  parse progress. The WASM wrapper calls `time.Sleep(1ms)` after each
  callback so the JS status line paints between files.
- `internal/pgtext` — pure-Go Postgres composite/array literal codec
  (standalone, unit tested).
- `apps/web/sstaas/` — bootstrap, fetch shim (with blocking spinner),
  PGlite + flat schema, WASM bridge, GitHub PAT auth, Contents + Git
  Data API helpers, re-index orchestrator, local-folder path via FSAA
  + webkitdirectory fallback, UI injection, legal copy, config.
- `apps/web/build.sh` — assembles `dist/` from upstream
  `src/server/public/` + `apps/web/sstaas/`, patches `index.html`,
  rewrites absolute asset paths to relative, strips leading slash
  from upstream's theme-switch CSS hrefs, builds `sst.wasm`.
- `.github/workflows/pages.yml` — Go install → build → upload to
  Pages. No secrets or variables to inject (PAT is runtime-paste).

### End-to-end verified
- **Real N4L parsing + GraphToDB.** Default-demo target
  (`markburgess/SSTorytime@main:examples`) parses ~31 files in tens
  of seconds, reporting per-file progress in the status bar.
- **Skiplist for upstream content bugs.** `reindex.js` filters out
  example files that hit undeclared-arrow errors so the default demo
  stays green. Tracked in a constant; to be reported upstream.
- **Shared SSTconfig discovery.** `.sst` files under any `SSTconfig/`
  directory in the repo are always included (root + per-dataset),
  regardless of the user's path filter.
- **Local-folder flow.** FSAA directory picker (fallback to
  `<input webkitdirectory>`). Folder handle persisted in IndexedDB
  keyed by session id. Dot goes green after clean parse, yellow on
  30s fingerprint-change poll, red on permission denied.
- **Search wired to the real schema.** `/searchN4L` delegates to
  `__sstWasm.search`, which mirrors upstream's HandleSearch:
  `DecodeSearchField → SolveNodePtrs → GetNodeOrbit → JSONNodeEvent →
  PackageResponse`.
- **Loading splash** during PGlite + WASM init; **fullscreen spinner**
  during blocking WASM search calls.
- **`?search=...` deep links.** Bootstrap publishes
  `window.__sstaasReady` synchronously before the fetch shim installs,
  so deep-linked searches queue cleanly instead of hitting
  "WASM not initialized".

### Still TODO

#### Search features not yet ported from upstream HandleSearch
- **`\lastnptr` + session STM** (`UpdateLastSawSection`/`NPtr`).
- **Richer TOC** (`ShowChapterContexts` full path: `Context[]`,
  `Single[]`, `Common[]` via `IntersectContextParts` +
  `ContextIntentAnalysis`). Helpers live in `src/server/http_server.go`
  and need copying out.
- **`\help` content** — `CheckHelpQuery` rewrites the query but we
  don't surface help text.
- **Assets / images on node events** — `/SearchAssets` still returns
  "not implemented".

#### Infrastructure still missing
- **PGlite `idb://` persistence is broken in our environment.**
  `new PGlite('idb://...')` never resolves `waitReady`; in-memory
  comes up in ~7s. Parsed data wipes on every reload. Revisit when a
  future PGlite release fixes it.
- **Auto-parse on session-reload is a clickwait.** Because PGlite is
  in-memory, reloading a tab only restores the binding — user still
  has to press ⟳ to rebuild the graph.
- **Write-back to GitHub.** Current github.js only reads. A "commit
  these changes" path (create/update file contents + PR) is possible
  with the same PAT as long as it has Contents: write.
- **Insert performance: ~12s for the full examples corpus.** Levers
  worth measuring: bigger multi-statement batches, caching Configure
  + arrow upload across sessions (needs persistence), COPY-style
  bulk load for the arrow directory.
- **No tests for the JS modules.** Highest-value targets:
  `reindex.js`, `folder-handle.js` fingerprint + change detection,
  `db.js` `looksMultiStatement`.
- **Move known-broken examples out of the skiplist.** File upstream
  issues for each.

## Local dev

```sh
sh apps/web/build.sh
python3 -m http.server -d dist 18090
# → http://localhost:18090/
```

No config files to set up: the user pastes a GitHub PAT at runtime.

## Deploy

Settings → Pages → Source: GitHub Actions. Push to `main`. The
workflow builds and deploys; no secrets or repo variables needed.

## Reference / older attempts

An earlier `client-side-drive-attempt-1` branch carried features
(editor mode, OPFS browser, database-wipe panel) out of scope for
this fork. Kept in the local repo for reference only.
