#!/bin/sh
# Assemble the static SPA distribution under dist/.
#
# Inputs:
#   - src/server/public/   upstream's SPA assets (HTML, CSS, main.js, favicons)
#   - apps/web/sstaas/     our additions (bootstrap, modules, legal copy)
#   - cmd/wasm/            Go source for the WASM module
#
# Output: dist/, ready to serve as a static site (e.g. GitHub Pages,
# python3 -m http.server). Upstream files are NOT modified — index.html
# is copied and patched in flight.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PUBLIC="$PROJECT_ROOT/src/server/public"
SSTAAS="$SCRIPT_DIR/sstaas"
DIST="$PROJECT_ROOT/dist"

echo "Cleaning dist/…"
rm -rf "$DIST"
mkdir -p "$DIST/sstaas"

echo "Copying upstream public/ assets…"
cp "$PUBLIC/style.css" "$DIST/"
cp "$PUBLIC/dark.css" "$PUBLIC/slate.css" "$PUBLIC/spaceblue.css" "$PUBLIC/red.css" "$DIST/"
cp "$PUBLIC/site.webmanifest" "$DIST/" 2>/dev/null || true
cp "$PUBLIC"/favicon*.* "$DIST/" 2>/dev/null || true
cp "$PUBLIC"/apple-touch-icon.png "$DIST/" 2>/dev/null || true
cp "$PUBLIC"/android-chrome*.png "$DIST/" 2>/dev/null || true
cp "$PUBLIC/main.js" "$DIST/main.js"
# Strip leading slash from theme CSS paths so they resolve against
# the document base URL (needed for subpath deploys like GH Pages).
sed -i "s|setAttribute('href', '/\\([a-z]*\\.css\\)')|setAttribute('href', '\\1')|g" "$DIST/main.js"

echo "Copying apps/web/sstaas/ → dist/sstaas/…"
cp -r "$SSTAAS"/* "$DIST/sstaas/"
# Drop the local-override stub from the published bundle.
rm -f "$DIST/sstaas/config.local.example.js"
# Don't ship a local-only override if one happens to exist.
rm -f "$DIST/sstaas/config.local.js"

echo "Stamping build-info.js with commit sha…"
BUILD_COMMIT=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
if ! git -C "$PROJECT_ROOT" diff --quiet 2>/dev/null; then
  BUILD_COMMIT="${BUILD_COMMIT}-dirty"
fi
BUILD_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$DIST/sstaas/build-info.js" <<EOF
export const BUILD = {
  commit: "${BUILD_COMMIT}",
  builtAt: "${BUILD_AT}",
};
EOF

echo "Patching index.html (inject bootstrap script tag)…"
# Take upstream's index.html and inject:
#  - an inline synchronous pre-shim that catches any fetch() to our
#    handler paths before the bootstrap module finishes loading, and
#    parks the call on a Promise until the full module-level shim
#    replaces it. Without this, upstream main.js's DOMContentLoaded
#    handler can race the module-graph evaluation of bootstrap.js and
#    reach origFetch first (we hit this in practice — GET /searchN4L
#    returned 404 from python's http.server because the shim wasn't
#    yet installed).
#  - the bootstrap module, which installs the full shim and replaces
#    the parked-Promise behavior with real handlers.
python3 - "$PUBLIC/index.html" "$DIST/index.html" <<'PY'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
html = open(src).read()
inject = """    <!-- sstaas client-side-drive additions -->
    <script>
      // Early fetch pre-shim. Any call to one of our handler paths is
      // queued until window.__sstaasFlushFetchQueue() fires (from
      // fetch-shim.js once the real shim is in place).
      (function () {
        var PATHS = { "/searchN4L": 1, "/SearchAssets": 1, "/Upload": 1 };
        var origFetch = window.fetch.bind(window);
        var queue = [];
        window.__sstaasOrigFetch = origFetch;
        window.__sstaasReal = null; // set by fetch-shim.js
        window.fetch = function (input, init) {
          var url = typeof input === "string" ? input : (input && input.url) || "";
          var path = url.replace(/^https?:\\/\\/[^/]+/, "");
          if (!PATHS[path]) return origFetch(input, init);
          if (window.__sstaasReal) return window.__sstaasReal(input, init);
          return new Promise(function (resolve, reject) {
            queue.push({ input: input, init: init, resolve: resolve, reject: reject });
          });
        };
        window.__sstaasFlushFetchQueue = function () {
          while (queue.length) {
            var q = queue.shift();
            window.fetch(q.input, q.init).then(q.resolve, q.reject);
          }
        };
      })();
    </script>
    <script type="module" defer src="sstaas/bootstrap.js"></script>
  </head>"""
html = html.replace("  </head>", inject, 1)
# Rewrite absolute asset paths so the SPA works under a subpath
# (e.g. GitHub Pages at /SSTorytime/) as well as from /.
html = re.sub(r'(href|src)="/([^/"])', r'\1="\2', html)
open(dst, "w").write(html)
PY

echo "Building Go WASM module…"
mkdir -p "$DIST/sstaas"
cd "$PROJECT_ROOT"
GOOS=js GOARCH=wasm go build -o "$DIST/sstaas/sst.wasm" ./cmd/wasm/

echo "Copying wasm_exec.js from current Go toolchain…"
GOROOT="$(go env GOROOT)"
if [ -f "$GOROOT/lib/wasm/wasm_exec.js" ]; then
  cp "$GOROOT/lib/wasm/wasm_exec.js" "$DIST/sstaas/wasm_exec.js"
elif [ -f "$GOROOT/misc/wasm/wasm_exec.js" ]; then
  cp "$GOROOT/misc/wasm/wasm_exec.js" "$DIST/sstaas/wasm_exec.js"
else
  echo "warning: couldn't locate wasm_exec.js in GOROOT=$GOROOT" >&2
fi

WASM_SIZE=$(du -h "$DIST/sstaas/sst.wasm" | cut -f1)
echo
echo "Build complete."
echo "  WASM size: $WASM_SIZE"
echo "  Output:    $DIST"
echo
echo "Serve locally:"
echo "  python3 -m http.server -d $DIST 18090"
