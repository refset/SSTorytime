// WASM entry point for the static-site mode.
//
// Build constraint keeps this file out of `go build ./...` on native
// targets so it doesn't break the standard SSTorytime server build.
// To produce sst.wasm, run apps/web/build.sh (which sets GOOS/GOARCH).
//
// Exposes async-friendly functions on the global __sstWasm:
//   open()                 -> Promise<{ok}>      open + bootstrap PGlite via the pglite-js driver
//   nodeCount()            -> Promise<int>       quick liveness check
//   parseN4L({name:text})  -> Promise<JSONstr>   run the upstream N4L parser + GraphToDB
//   search(query)          -> Promise<JSONstr>   orbits-shaped search response, mirroring the
//                                                upstream http_server.go /searchN4L handler
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
	"sort"
	"sync"
	"syscall/js"

	SST "github.com/markburgess/SSTorytime/pkg/SSTorytime"
	"github.com/markburgess/SSTorytime/pkg/n4lparse"
)

const buildVersion = "client-side-drive/wasm 0.0.5"

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
		"search":    js.FuncOf(jsSearch),
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

// jsSearch mirrors src/server/http_server.go's /searchN4L handler.
// Dispatches to: Orbits (name search), TOC (chapter/context listing),
// or Error (unsupported query types: \path, \from/\to, \stats, \page,
// arrows, sequence).
//
// Returns a JSON string shaped exactly like upstream's PackageResponse:
//   { "Response": "Orbits"|"TOC"|"Error", "Content": <json value>,
//     "Time": "...", "Intent": {...}, "Ambient": {...} }
//
// IMPORTANT: upstream main.js's FetchPage (initial page load) calls
// DoOrbitPanel unconditionally on whatever Response comes back, and
// DoOrbitPanel crashes on a string Content because it iterates it as
// an array. So when the query is empty we return an empty Orbits
// response (Content=[]) instead of Error — DoOrbitPanel handles that
// cleanly with a "No result" message.
func jsSearch(this js.Value, args []js.Value) any {
	return promise(func() (any, error) {
		if err := ensureOpen(); err != nil {
			return nil, err
		}
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return nil, fmt.Errorf("search: expected a string query")
		}
		query := args[0].String()

		query = SST.CheckRemindQuery(query)
		query = SST.CheckHelpQuery(query)
		query = SST.CheckConceptQuery(query)

		params := SST.DecodeSearchField(query)
		_, maxlimit := SST.MinMaxPolicy(params)

		name := len(params.Name) > 0
		from := len(params.From) > 0
		to := len(params.To) > 0
		chapter := params.Chapter != ""
		context := len(params.Context) > 0

		// Empty query (e.g. initial page load's FetchPage): return an
		// empty Orbits response so DoOrbitPanel renders "No result"
		// safely. Error responses with a non-empty Content string
		// would crash DoOrbitPanel — see comment above.
		if !name && !from && !to && !chapter && !context &&
			!params.Stats && !params.Sequence && params.PageNr == 0 {
			return packageResponse("Orbits", "[]"), nil
		}

		// Unsupported-for-now queries still return Error; upstream
		// sendLinkSearch (search-box flow) handles Error cleanly
		// (just logs), and these never come in via FetchPage.
		var unsupported string
		switch {
		case params.Stats:
			unsupported = "\\stats (statistics) not yet wired."
		case params.Sequence:
			unsupported = "\\sequence / \\story not yet wired."
		case params.PageNr > 0:
			unsupported = "\\page lookups not yet wired."
		case from || to:
			unsupported = "\\from / \\to path queries not yet wired."
		}
		if unsupported != "" {
			return packageResponse("Error", jsonString(unsupported)), nil
		}

		// Chapter/context listing (\toc, \chapter, \in, etc.) →
		// TOC response with a minimal ChCtx list. We don't yet
		// compute the per-chapter context clusters upstream shows,
		// just the chapter names + coordinates so the user can
		// see what's in the graph and click through.
		if (chapter || context) && !name {
			return buildTOCResponse(params, maxlimit), nil
		}

		nptrs := SST.SolveNodePtrs(psst, params.Name, params, nil, maxlimit)
		if len(nptrs) == 0 {
			return packageResponse("Error", jsonString(
				fmt.Sprintf("No nodes match %q.", query))), nil
		}

		events := make([]SST.NodeEvent, 0, len(nptrs))
		origin := SST.Coords{X: 0, Y: 0, Z: 0}
		for n := 0; n < len(nptrs) && n < maxlimit; n++ {
			orb := SST.GetNodeOrbit(&psst, nptrs[n], "", maxlimit)
			xyz := SST.RelativeOrbit(origin, SST.R0, n, len(nptrs))
			orb = SST.SetOrbitCoords(xyz, orb)
			events = append(events, SST.JSONNodeEvent(psst, nptrs[n], xyz, orb))
		}

		data, err := json.Marshal(events)
		if err != nil {
			return nil, fmt.Errorf("search: marshal events: %w", err)
		}
		return packageResponse("Orbits", string(data)), nil
	})
}

// buildTOCResponse: minimal equivalent of upstream's ShowChapterContexts.
// Lists the chapters in the graph with their layout coordinates, leaving
// the per-chapter context-cluster fields empty for now (upstream's
// IntersectContextParts / ContextIntentAnalysis aren't cheap and we
// haven't ported the helpers into pkg/SSTorytime yet).
func buildTOCResponse(params SST.SearchParameters, limit int) any {
	toc := SST.GetChaptersByChapContext(psst, params.Chapter, params.Context, limit)
	chapList := make([]string, 0, len(toc))
	for c := range toc {
		chapList = append(chapList, c)
	}
	sort.Strings(chapList)

	chapters := make([]SST.ChCtx, 0, len(chapList))
	for i, name := range chapList {
		chapters = append(chapters, SST.ChCtx{
			Chapter: name,
			XYZ:     SST.AssignChapterCoordinates(i, len(chapList)),
		})
	}

	data, _ := json.Marshal(chapters)
	return packageResponse("TOC", string(data))
}

// packageResponse builds the Response envelope upstream's UI expects.
// Intent + Ambient are left empty — the WASM build doesn't track STM
// context the way the long-lived Go server does.
//
// Content is a JSON-encoded value that must appear *inline* in the
// envelope (Content[0] works in main.js), not as a JSON-encoded
// string. Use json.RawMessage so Marshal doesn't double-encode it.
func packageResponse(kind string, contentJSON string) any {
	// Intent + Ambient are strings on upstream (GetTimeContext /
	// UpdateSTMContext return string) — main.js does
	// `el.textContent = obj.Ambient`, so objects render as
	// "[object Object]". Keep them as empty strings.
	env := map[string]any{
		"Response": kind,
		"Content":  json.RawMessage(contentJSON),
		"Time":     "",
		"Intent":   "",
		"Ambient":  "",
	}
	b, _ := json.Marshal(env)
	return js.ValueOf(string(b))
}

// jsonString JSON-escapes a plain string for embedding in a Content
// field (the upstream Content is itself a JSON-encoded string).
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
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
