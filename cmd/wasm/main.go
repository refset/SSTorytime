// WASM entry point for the static-site mode.
//
// Build constraint keeps this file out of `go build ./...` on native
// targets so it doesn't break the standard SSTorytime server build.
// To produce sst.wasm, run apps/web/build.sh (which sets GOOS/GOARCH).
//
// Exposes async-friendly functions on the global __sstWasm:
//   open()                 -> Promise<{ok}>      open + bootstrap PGlite via the pglite-js driver
//   nodeCount()            -> Promise<int>       quick liveness check
//   parseN4L({name:text})  -> Promise<diffJSON>  (parser stub for now)
//
// Bridging is async-only: the JS side calls these and gets a Promise;
// each Go handler runs in a goroutine, can await JS Promises (e.g.
// for SQL queries via the pglite-js driver) through channel-bridged
// then/catch callbacks, then resolves its own Promise.

//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"syscall/js"

	SST "github.com/markburgess/SSTorytime/pkg/SSTorytime"
	"github.com/markburgess/SSTorytime/pkg/n4lparse"
)

const buildVersion = "client-side-drive/wasm 0.0.3"

var (
	openOnce sync.Once
	openErr  error
	psst     SST.PoSST
)

func main() {
	js.Global().Set("__sstWasm", js.ValueOf(map[string]any{
		"version":   js.FuncOf(jsVersion),
		"open":      js.FuncOf(jsOpen),
		"nodeCount": js.FuncOf(jsNodeCount),
		"parseN4L":  js.FuncOf(jsParseN4L),
	}))
	fmt.Println(buildVersion, "loaded")
	select {} // park forever so the runtime stays alive for incoming JS calls
}

func jsVersion(this js.Value, args []js.Value) any {
	return js.ValueOf(buildVersion)
}

// jsOpen lazily runs SST.OpenWasm exactly once. window.__sstQuery
// must already be set by bridge.js (it is, by the time WASM finishes
// loading).
func jsOpen(this js.Value, args []js.Value) any {
	return promise(func() (any, error) {
		if err := ensureOpen(); err != nil {
			return nil, err
		}
		return js.ValueOf(map[string]any{"ok": true}), nil
	})
}

func ensureOpen() error {
	openOnce.Do(func() {
		psst, openErr = SST.OpenWasm(true)
	})
	return openErr
}

// jsNodeCount: a tiny SELECT to prove the driver round-trips.
func jsNodeCount(this js.Value, args []js.Value) any {
	return promise(func() (any, error) {
		if err := ensureOpen(); err != nil {
			return nil, err
		}
		var n int64
		row := psst.DB.QueryRow("SELECT count(*) FROM Node")
		if err := row.Scan(&n); err != nil {
			return nil, fmt.Errorf("nodeCount: %w", err)
		}
		return js.ValueOf(n), nil
	})
}

// jsParseN4L runs the upstream N4L parser over a {filename: text}
// payload and flushes the resulting in-memory graph into PGlite via
// GraphToDB. Returns a JSON string summarizing what was parsed + the
// updated directory sizes.
func jsParseN4L(this js.Value, args []js.Value) any {
	return promise(func() (any, error) {
		if err := ensureOpen(); err != nil {
			return nil, err
		}
		if len(args) < 1 {
			return nil, fmt.Errorf("parseN4L: missing files object")
		}
		filesArg := args[0]
		if filesArg.Type() != js.TypeObject {
			return nil, fmt.Errorf("parseN4L: argument must be a {filename: text} object")
		}
		files := map[string]string{}
		sizes := map[string]int{}
		keys := js.Global().Get("Object").Call("keys", filesArg)
		for i := 0; i < keys.Length(); i++ {
			name := keys.Index(i).String()
			v := filesArg.Get(name)
			if v.Type() != js.TypeString {
				return nil, fmt.Errorf("parseN4L: value for %q must be a string", name)
			}
			text := v.String()
			files[name] = text
			sizes[name] = len(text)
		}

		res, err := n4lparse.Parse(&psst, files)
		if err != nil {
			return nil, fmt.Errorf("parseN4L: %w", err)
		}

		SST.GraphToDB(psst, false)

		out := map[string]any{
			"ok":          true,
			"files":       sizes,
			"parsed":      res.Files,
			"n1Directory": res.N1Directory,
			"n2Directory": res.N2Directory,
			"n3Directory": res.N3Directory,
			"lt128":       res.LT128,
			"lt1024":      res.LT1024,
			"gt1024":      res.GT1024,
			"arrowTotal":  res.ArrowTotal,
		}
		b, _ := json.Marshal(out)
		return js.ValueOf(string(b)), nil
	})
}

// promise wraps a Go func returning (jsValue, error) into a JS Promise.
// The work runs in a goroutine so the Go scheduler can yield back to
// the JS event loop while we await any nested Promises (e.g. SQL).
func promise(work func() (any, error)) any {
	return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			out, err := work()
			if err != nil {
				reject.Invoke(err.Error())
				return
			}
			resolve.Invoke(out)
		}()
		return nil
	}))
}
