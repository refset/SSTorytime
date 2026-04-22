// WASM-only Open() variant. Mirrors the native Open() in session.go
// but talks to PGlite via the pglite-js sql.Driver instead of
// PostgreSQL via lib/pq. Native Open() is unchanged and continues to
// work for the regular SSTorytime server build.
//
// Two important deviations from native Open():
//
//  1. Before Configure() runs we install our unaccent(text) shim
//     (PGlite doesn't ship the unaccent contrib extension). Upstream's
//     sst_unaccent plpgsql wrapper then resolves correctly, so the
//     Node.UnSearch generated tsvector column works as expected.
//
//  2. We do NOT call os.Exit on failure — that would kill the entire
//     WASM module and there's no operator to see the message anyway.
//     Errors are returned for the JS bootstrap to surface.

//go:build js && wasm

package SSTorytime

import (
	"database/sql"
	"fmt"
)

// OpenWasm opens a PGlite-backed PoSST. The DSN is ignored (PGlite
// is a singleton in the browser tab). The bridge.js script must
// already have set window.__sstQuery before this is called.
func OpenWasm(loadArrows bool) (PoSST, error) {
	var sst PoSST

	db, err := sql.Open("pglite-js", "")
	if err != nil {
		return sst, fmt.Errorf("OpenWasm: sql.Open: %w", err)
	}
	if err := db.Ping(); err != nil {
		return sst, fmt.Errorf("OpenWasm: ping: %w", err)
	}
	sst.DB = db

	if err := InstallUnaccent(sst); err != nil {
		return sst, fmt.Errorf("OpenWasm: install unaccent shim: %w", err)
	}

	MemoryInit(&sst)
	Configure(sst, loadArrows)

	DownloadArrowsFromDB(&sst)
	DownloadContextsFromDB(&sst)
	SynchronizeNPtrs(&sst)

	NO_NODE_PTR.Class = 0
	NO_NODE_PTR.CPtr = -1
	NONODE.Class = 0
	NONODE.CPtr = 0

	return sst, nil
}
