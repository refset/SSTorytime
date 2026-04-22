// WASM entry point for the static-site mode.
//
// Build constraint keeps this file out of `go build ./...` on native
// targets so it doesn't break the standard SSTorytime server build.
// To produce sst.wasm, run apps/web/build.sh (which sets GOOS/GOARCH).
//
// Exposes one async-friendly function via the global __sstWasm:
//   parseN4L(filesObj) -> Promise<diffJSON>
// taking a {filename: text} object and returning JSON describing the
// nodes/arrows/links to insert. JS is responsible for all DB work
// (PGlite on the main thread).
//
// We deliberately do NOT call PGlite from Go: the only data path
// between Go and JS is parameters in / JSON out. That keeps this
// module a pure function — no Worker, no SharedArrayBuffer, no
// Atomics — and dramatically simplifies static hosting (no COOP/COEP
// headers needed).
//
// The actual N4L parsing is the upstream package's; for now this just
// returns a placeholder so the rest of the plumbing can be wired
// end-to-end. See ROADMAP_CLIENT_SIDE.md for the parsing-port plan.

//go:build js && wasm

package main

import (
	"encoding/json"
	"fmt"
	"syscall/js"
)

const buildVersion = "client-side-drive/wasm 0.0.1"

type parseDiff struct {
	OK       bool                `json:"ok"`
	Note     string              `json:"note"`
	Files    map[string]int      `json:"files"`    // filename → byte length received
	Nodes    []map[string]any    `json:"nodes"`    // empty in the stub
	Arrows   []map[string]any    `json:"arrows"`   // empty in the stub
	Links    []map[string]any    `json:"links"`    // empty in the stub
	Warnings []string            `json:"warnings"` // empty in the stub
}

func main() {
	js.Global().Set("__sstWasm", js.ValueOf(map[string]any{
		"version":   js.FuncOf(version),
		"parseN4L":  js.FuncOf(parseN4L),
	}))
	fmt.Println(buildVersion, "loaded")
	// Block forever so the runtime stays alive for incoming JS calls.
	select {}
}

func version(this js.Value, args []js.Value) any {
	return js.ValueOf(buildVersion)
}

// parseN4L(filesObj) returns a Promise that resolves to a JSON string
// describing the parse result. This is the only async-bridge surface
// between JS and Go; everything else stays in JS.
func parseN4L(this js.Value, args []js.Value) any {
	if len(args) < 1 {
		return rejected("parseN4L: expected one argument (files object)")
	}
	filesArg := args[0]
	return js.Global().Get("Promise").New(js.FuncOf(func(_ js.Value, pargs []js.Value) any {
		resolve, reject := pargs[0], pargs[1]
		go func() {
			out, err := doParse(filesArg)
			if err != nil {
				reject.Invoke(err.Error())
				return
			}
			resolve.Invoke(out)
		}()
		return nil
	}))
}

func doParse(filesArg js.Value) (string, error) {
	if filesArg.Type() != js.TypeObject {
		return "", fmt.Errorf("parseN4L: argument must be a {filename: text} object")
	}
	files := map[string]int{}
	keys := js.Global().Get("Object").Call("keys", filesArg)
	for i := 0; i < keys.Length(); i++ {
		name := keys.Index(i).String()
		v := filesArg.Get(name)
		if v.Type() != js.TypeString {
			return "", fmt.Errorf("parseN4L: value for %q must be a string", name)
		}
		files[name] = v.Length()
	}
	diff := parseDiff{
		OK:    true,
		Note:  "parser stub: real N4L parsing not yet ported to WASM",
		Files: files,
	}
	b, err := json.Marshal(diff)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func rejected(msg string) any {
	return js.Global().Get("Promise").Call("reject", msg)
}
