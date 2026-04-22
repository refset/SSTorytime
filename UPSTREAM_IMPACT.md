# Upstream impact of `client-side-drive`

A summary of what this fork actually changes in Mark's code, vs. what
lives in new parallel paths. Scope: from the branch base
(`b09c915` — Mark's last upstream commit at fork time) to current
`HEAD`.

## TL;DR

The fork is almost entirely **additive**. One committed edit to an
upstream Go source file, plus one build-time HTML patch. No upstream
JS, CSS, schema, or N4L logic was modified.

## Committed source edits to upstream files

### `pkg/SSTorytime/*.go` — `os.Exit` → `panic` (29 sites across 10 files)

Every `os.Exit(-1)` / `os.Exit(1)` in the committed upstream Go
sources becomes a `panic(...)`. This is required for the WASM build
(so `pkg/n4lparse.Parse`'s `defer recover()` can actually catch a
fatal parse error — `recover()` does not catch `os.Exit`, which was
tearing down the whole Go runtime on the first malformed line),
and it is arguably a strict improvement for the native HTTP server
too: a malformed request now panics up through `net/http`'s
per-request recover instead of killing the process. Nine files lose
their now-unused `"os"` import as a consequence; `session.go` keeps
it for `os.Getenv` / `os.UserHomeDir`. No behaviour change beyond
the exit vs. panic semantics.

### `pkg/SSTorytime/db_upload.go` — one nil-guard

Function: `UploadPageMapEvent`.

Upstream called `row.Close()` in the error branch of `sst.DB.Query(...)`.
Under `database/sql`, `Query` returns a nil `*Rows` on error, so
`row.Close()` segfaulted as soon as a duplicate-key insert landed under
PGlite. The fix drops the nil deref; the `return` path was already
correct. One-line behavioural change, no other control flow.

```diff
-		row.Close()
+		// row is nil on error — no Close() call here (prior code
+		// deref'd nil and crashed the runtime under PGlite).
 		return
```

This is the **only** upstream `.go` / `.js` / `.css` file modified in
a committed diff.

## Build-time HTML patch (not a committed source edit)

`apps/web/build.sh` copies `src/server/public/` into `dist/` verbatim,
then patches `dist/index.html` to inject three tags before `</head>`:

1. An inline synchronous **pre-shim** that parks calls to `/searchN4L`,
   `/SearchAssets`, `/Upload` on a Promise until the real shim is
   installed (needed because upstream `main.js`'s DOMContentLoaded
   handler can race the bootstrap module graph).
2. The **Google Identity Services** loader (for Drive auth).
3. The bootstrap ES module (`/sstaas/bootstrap.js`).

Upstream `index.html` on disk is never rewritten. The patch lives
entirely in the heredoc inside `build.sh`.

## What is *not* modified

- `src/server/public/main.js` — untouched. The fetch shim and the
  loading splash sit in front of it, not inside it. All UI behaviour
  (orbit panels, sequence, TOC, search history, theme) is upstream's
  code running unmodified against our shimmed fetch responses.
- `src/server/public/*.css`, `*.html` (aside from the build-time
  `index.html` injection above), assets — untouched.
- `src/server/http_server.go` — unused in this build target. A few
  helpers that lived there (`PackageConeFromOrigin`) had to be
  **copied** (not moved) into `cmd/wasm/main.go` because upstream's
  server path still needs them.
- `pkg/SSTorytime/*.go` — every other file untouched. The WASM path
  consumes upstream's `Configure`, `GraphToDB`, `HandleOrbit`-style
  helpers, `SolveNodePtrs`, `GetNodeOrbit`, `DecodeSearchField`,
  `GetSequenceContainers`, `GetPathsAndSymmetries`,
  `BetweenNessCentrality`, `SuperNodes`, `GetDBPageMap`, `JSONPage`,
  `GetLastSawSection`/`NPtr`, `GetDBArrowBy{Ptr,STType}`,
  `STIndexToSTType`, `GetFwdPathsAsLinks`, `LinkWebPaths`, etc.
  exactly as Mark wrote them.
- The N4L parser in `src/N4L/` — untouched. `pkg/n4lparse/` is a
  **library extraction** (new files, not edits) of that code so the
  WASM binary can link it without depending on `src/N4L`'s `main`
  package.
- The Postgres schema, the arrow directory files, the example `.n4l`
  corpus — untouched.

## Everything else is new, parallel code

All under new top-level paths so nothing shadows upstream:

| Path | What it adds |
|---|---|
| `apps/web/build.sh` | builds `dist/` from upstream `public/` + our overlay |
| `apps/web/sstaas/` | JS modules: bootstrap, fetch shim, PGlite + schema, WASM bridge, GIS auth, Drive REST, re-index orchestrator, asset cache, UI injection, splash, legal copy |
| `cmd/wasm/main.go` | Go→WASM entry; exposes `open/parseN4L/search/nodeCount` on `window.__sstWasm`; mirrors `HandleSearch` dispatch |
| `internal/pgtext/` | pure-Go Postgres composite/array literal codec (standalone, unit-tested) |
| `pkg/SSTorytime/driver_pglite_js.go` | `database/sql` driver that bridges to PGlite via `window.__sstQuery`. `//go:build js && wasm` |
| `pkg/SSTorytime/session_wasm.go` | `OpenWasm()` — `Open()` for the WASM build; native `Open()` untouched |
| `pkg/SSTorytime/unaccent_wasm.go` | NFD-based `unaccent(text)` shim (PGlite lacks the extension) |
| `pkg/n4lparse/` | library extraction of `src/N4L` parser + embedded default config |
| `.github/workflows/pages.yml` | GitHub Pages build + deploy |
| `infra/gcp/` | Terraform: enable Drive API + manual-step checklist |
| `ROADMAP_CLIENT_SIDE.md` | honest status + remaining work |

## Interaction pattern

Nothing in upstream is patched at runtime either. The shape is:

```
upstream main.js  ──fetch("/searchN4L")──▶  fetch-shim.js
                                                │
                                                ▼
                                         bridge.js (wasmSearch)
                                                │
                                                ▼
                                         cmd/wasm/main.go (jsSearch)
                                                │   uses upstream
                                                ▼   pkg/SSTorytime
                                         PGlite via pglite-js driver
```

Upstream's render code sees the same response envelopes it used to get
from Mark's Go HTTP server, so every panel renders from unmodified
`main.js`.

## Upstreamability

The one committed upstream edit (`db_upload.go` nil-guard) is a
straightforward defensive fix and would apply to Mark's native build
too — the nil `*Rows` contract is part of `database/sql`. Everything
else is parallel code, so rebasing onto future upstream commits should
be a clean fast-forward on upstream paths with merge activity confined
to the new directories.
