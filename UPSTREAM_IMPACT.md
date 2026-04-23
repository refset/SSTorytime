# Upstream impact of the client-side fork

A summary of what this fork actually changes in Mark's code, vs. what
lives in new parallel paths.

## TL;DR

The fork is almost entirely **additive**. Two committed edits to
upstream Go source files, plus one build-time HTML patch (injection +
absolute-path rewrite). No upstream JS, CSS, schema, or N4L logic was
modified beyond the build-time text substitutions.

## Committed source edits to upstream files

### `pkg/SSTorytime/*.go` — `os.Exit` → `panic` (29 sites across 10 files)

Every `os.Exit(-1)` / `os.Exit(1)` in the committed upstream Go
sources becomes a `panic(...)`. Required for the WASM build so
`pkg/n4lparse.Parse`'s `defer recover()` can actually catch a fatal
parse error — `recover()` doesn't catch `os.Exit`, which was tearing
down the whole Go runtime on the first malformed line. Arguably a
strict improvement for the native HTTP server too: a malformed
request now panics up through `net/http`'s per-request recover
instead of killing the process. Nine files lose their now-unused
`"os"` import; `session.go` keeps it for `os.Getenv` / `os.UserHomeDir`.
No behaviour change beyond exit-vs-panic semantics.

### `pkg/SSTorytime/db_upload.go` — one nil-guard

`UploadPageMapEvent`: upstream called `row.Close()` in the error
branch of `sst.DB.Query(...)`. Under `database/sql`, `Query` returns
a nil `*Rows` on error, so `row.Close()` segfaulted as soon as a
duplicate-key insert landed under PGlite. One-line behavioural change,
no other control flow.

```diff
-		row.Close()
+		// row is nil on error — no Close() call here (prior code
+		// deref'd nil and crashed the runtime under PGlite).
 		return
```

### `pkg/n4lparse/api.go` — optional progress callback

`ParseWithConfigs` grew a fourth parameter, a `ProgressFn` callback
that's invoked before each config-load and each per-file parse stage.
Callers pass `nil` to opt out; the single other call site in the
package (`Parse`) does exactly that. Additive: default behaviour is
unchanged.

## Build-time HTML patch (not a committed source edit)

`apps/web/build.sh` copies `src/server/public/` into `dist/` verbatim,
then applies two text transforms to `dist/index.html`:

1. **Injection before `</head>`**: an inline synchronous pre-shim
   that parks calls to `/searchN4L`, `/SearchAssets`, `/Upload` on a
   Promise until the real shim is installed, and the bootstrap ES
   module (`sstaas/bootstrap.js`).
2. **Absolute-to-relative rewrite**: `href="/foo"` / `src="/foo"` →
   `href="foo"` / `src="foo"`, so favicons, CSS, and `main.js` resolve
   under the `/SSTorytime/` Pages subpath. External `https://...`
   refs are left alone.

`dist/main.js` also gets a one-line sed applied: upstream's theme
switcher hard-codes absolute CSS hrefs (`/dark.css` etc), so the
leading slash is stripped. Source `main.js` on disk is never touched.

## What is *not* modified

- `src/server/public/main.js` — untouched on disk. The fetch shim and
  the loading splash sit in front of it, not inside it. All UI
  behaviour (orbit panels, sequence, TOC, search history, theme) is
  upstream's code running unmodified against our shimmed responses.
- `src/server/public/*.css`, `*.html`, assets — untouched.
- `src/server/http_server.go` — unused in this build target.
  `PackageConeFromOrigin` and a few other helpers were **copied**
  (not moved) into `cmd/wasm/main.go`.
- `pkg/SSTorytime/*.go` — every file beyond the `os.Exit` conversion
  and the `db_upload.go` nil-guard is untouched. The WASM path
  consumes upstream's `Configure`, `GraphToDB`, `HandleOrbit` helpers,
  `SolveNodePtrs`, `GetNodeOrbit`, `DecodeSearchField`, etc. as-is.
- The N4L parser in `src/N4L/` — untouched. `pkg/n4lparse/` is a
  **library extraction** of that code.
- The Postgres schema, the arrow directory files, the example `.n4l`
  corpus — untouched.

## Everything else is new, parallel code

All under new top-level paths:

| Path | What it adds |
|---|---|
| `apps/web/build.sh` | builds `dist/` from upstream `public/` + our overlay, patches index.html, rewrites absolute paths |
| `apps/web/sstaas/` | JS modules: bootstrap, fetch shim (+spinner), PGlite + schema, WASM bridge, GitHub PAT auth, GitHub Contents API helpers, re-index orchestrator, local-folder support (FSAA + webkitdirectory), UI injection, splash, legal copy |
| `cmd/wasm/main.go` | Go→WASM entry; exposes `open/parseN4L/search/nodeCount` on `window.__sstWasm`; mirrors `HandleSearch` dispatch |
| `internal/pgtext/` | pure-Go Postgres composite/array literal codec (standalone, unit-tested) |
| `pkg/SSTorytime/driver_pglite_js.go` | `database/sql` driver that bridges to PGlite via `window.__sstQuery`. `//go:build js && wasm` |
| `pkg/SSTorytime/session_wasm.go` | `OpenWasm()` — `Open()` for the WASM build; native `Open()` untouched |
| `pkg/SSTorytime/unaccent_wasm.go` | NFD-based `unaccent(text)` shim (PGlite lacks the extension) |
| `pkg/n4lparse/` | library extraction of `src/N4L` parser + embedded default config |
| `.github/workflows/pages.yml` | GitHub Pages build + deploy (no secrets) |
| `ROADMAP_CLIENT_SIDE.md` | honest status + remaining work |

## Interaction pattern

Nothing in upstream is patched at runtime. The shape is:

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

- `db_upload.go` nil-guard: straightforward defensive fix, applies to
  Mark's native build too — the nil `*Rows` contract is part of
  `database/sql`.
- `os.Exit` → `panic` conversion: upstream-friendly since the HTTP
  server currently dies on any fatal parse error; panicking through
  `net/http`'s per-request recover is strictly better. Downside is
  the 29-site churn.
- `ParseWithConfigs` progress callback: additive API extension;
  existing callers pass nil or use the no-progress convenience
  wrapper, so it's a drop-in.

Everything else is parallel code under new paths, so rebasing onto
future upstream commits should fast-forward cleanly.
