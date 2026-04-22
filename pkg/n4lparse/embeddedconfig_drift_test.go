// Drift guard: the arrow/annotation/closure configs this package
// embeds for WASM must stay byte-identical to the authoritative
// SSTconfig/ at the repo root. The native N4L command reads those
// from disk; we embed copies here because wasm has no filesystem.
// Run `cp SSTconfig/*.sst pkg/n4lparse/embeddedconfig/` whenever
// upstream updates them.

package n4lparse

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestEmbeddedConfigMatchesRepoRoot(t *testing.T) {
	// Walk up from this package's source dir until we find go.mod,
	// then look for SSTconfig/ next to it.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root := wd
	for {
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			break
		}
		parent := filepath.Dir(root)
		if parent == root {
			t.Skip("can't locate go.mod to resolve SSTconfig/")
		}
		root = parent
	}
	sstconfig := filepath.Join(root, "SSTconfig")
	if _, err := os.Stat(sstconfig); err != nil {
		t.Skipf("SSTconfig/ not present at %s", sstconfig)
	}

	for _, name := range configOrder {
		disk, err := os.ReadFile(filepath.Join(sstconfig, name))
		if err != nil {
			t.Errorf("read %s from SSTconfig/: %v", name, err)
			continue
		}
		embed, err := embeddedConfigs.ReadFile("embeddedconfig/" + name)
		if err != nil {
			t.Errorf("read embedded %s: %v", name, err)
			continue
		}
		if !bytes.Equal(disk, embed) {
			t.Errorf("drift: embeddedconfig/%s differs from SSTconfig/%s — re-copy", name, name)
		}
	}
}
