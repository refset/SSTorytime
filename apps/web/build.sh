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

echo "Copying apps/web/sstaas/ → dist/sstaas/…"
cp -r "$SSTAAS"/* "$DIST/sstaas/"
# Drop the local-override stub from the published bundle.
rm -f "$DIST/sstaas/config.local.example.js"
# Don't ship a local-only override if one happens to exist.
rm -f "$DIST/sstaas/config.local.js"

echo "Patching index.html (inject bootstrap script tag)…"
# Take upstream's index.html and inject one extra <script> tag in
# <head> that loads our bootstrap module BEFORE main.js executes.
# main.js itself is already loaded as `type="module" defer` so its
# execution is deferred until after parsing finishes — by which time
# our bootstrap (also a module, also deferred) will have installed the
# fetch shim.
python3 - "$PUBLIC/index.html" "$DIST/index.html" <<'PY'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
html = open(src).read()
# Inject the GIS loader + sstaas bootstrap immediately before </head>.
inject = """    <!-- sstaas client-side-drive additions -->
    <script src="https://accounts.google.com/gsi/client" async defer></script>
    <script type="module" defer src="/sstaas/bootstrap.js"></script>
  </head>"""
html = html.replace("  </head>", inject, 1)
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
