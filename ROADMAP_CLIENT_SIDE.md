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
- `cmd/wasm/main.go` — minimal Go-WASM entry, async-only bridge.
- `apps/web/sstaas/` — bootstrap, fetch shim, PGlite + schema, WASM
  bridge, GIS auth, Drive REST, re-index orchestrator, asset cache,
  UI injection, legal copy, config.
- `apps/web/build.sh` — assembles `dist/` from upstream `src/server/public/`
  + `apps/web/sstaas/`, patches `index.html`, builds `sst.wasm`.
- `.github/workflows/pages.yml` — Go install → build → inject
  `vars.GOOGLE_OAUTH_CLIENT_ID` → upload to Pages.
- `infra/gcp/main.tf` + README — Drive API enable + manual-step
  checklist for OAuth consent screen and Web Client ID.
- `.gitignore` excludes `/dist/`, `*.wasm`, and the local config override.

### Still TODO (the honest list)
- **WASM N4L parser is a stub.** It only echoes filenames + byte
  lengths. Porting upstream's parser to actually emit nodes/arrows/links
  is the biggest piece of remaining work. Two viable shapes:
    (a) Refactor upstream's parser so it emits a diff (no DB calls
        from Go) and JS does all inserts. Cleanest for the no-DB-from-Go
        invariant we've established.
    (b) Implement a `database/sql` driver in Go that calls into JS
        (`window.__sstQuery`, already wired) so existing upstream code
        runs largely unchanged. More ambitious; Postgres composite
        types (`NodePtr`, `Link[]`) need careful handling.
- **Search is a placeholder.** The fetch shim's `/searchN4L` handler
  does a simple `LIKE` lookup on the flat `nodes` table and returns an
  Orbits-shaped response. Once the parser is wired, real search needs
  more work — and probably a richer schema.
- **Schema is intentionally flat.** `nodes`, `arrows`, `links` are
  plain tables with no composite types. Upstream's `NodePtr`/`Link[]`
  composites would need either a real pq-style row decoder in our JS
  bridge or a schema flatten — both viable, decision deferred.
- **Drive Picker not wired up.** Folder selection is currently
  "paste a folder ID into a `prompt()`". Real Picker needs the
  `picker.googleapis.com` API + a Browser API Key restricted by
  referrer. Terraform stub for the key is in `infra/gcp/main.tf`
  (commented out).
- **No tests yet.** None for the prior code either.

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
