// Library-style entry point for the N4L parser. The upstream
// command in src/N4L/ reads files from disk + parses flags + uploads;
// the WASM path just needs to take a map of {name: content} plus
// embedded arrow configs and produce an in-memory graph ready to
// flush via SST.GraphToDB.
//
// This file wraps the copied-over parser logic in parser.go with:
//  - embedded SSTconfig (arrows-*.sst, annotations.sst, closures.sst)
//    so we don't need a filesystem at runtime
//  - a stable Parse() function that resets the global parser state
//    for each input file, runs the configs once, then the user files
//  - a panic-recovering wrapper so calls like os.Exit in deep helpers
//    don't tear down the host runtime

package n4lparse

import (
	"embed"
	"fmt"
	"sort"
	"time"

	SST "github.com/markburgess/SSTorytime/pkg/SSTorytime"
)

//go:embed embeddedconfig/*.sst
var embeddedConfigs embed.FS

// configOrder mirrors the order ReadConfig() returns on disk.
var configOrder = []string{
	"arrows-LT-1.sst",
	"arrows-NR-0.sst",
	"arrows-CN-2.sst",
	"arrows-EP-3.sst",
	"annotations.sst",
	"closures.sst",
}

// Result summarizes what Parse did. Counts are post-parse, pre-flush.
// Errors is a per-file list of failures so one malformed file in a
// batch doesn't hide the rest — the caller decides whether to flush
// or abort.
type Result struct {
	Files       []string
	Errors      []FileError
	ConfigMs    int64
	FilesMs     int64
	InferMs     int64
	N1Directory int
	N2Directory int
	N3Directory int
	LT128       int
	LT1024      int
	GT1024      int
	ArrowTotal  int
}

type FileError struct {
	File string
	Line int
	Err  string
}

// Parse: embedded configs + user files. See ParseWithConfigs for the
// form that also accepts user-supplied SSTconfig/*.sst definitions.
func Parse(sst *SST.PoSST, userFiles map[string]string) (res Result, err error) {
	return ParseWithConfigs(sst, nil, userFiles)
}

// ParseWithConfigs loads the embedded default configs, then any
// userConfigs (typically the .sst files from a sibling SSTconfig/
// directory in the picked folder — upstream's per-dataset extension
// point), then parses each user file in sorted name order and runs
// CompleteInferences. Any panic in a user file is caught per-file
// and recorded as a FileError; the panic text comes from the real
// ParseError message, not the generic panic sentinel.
func ParseWithConfigs(sst *SST.PoSST, userConfigs, userFiles map[string]string) (res Result, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("n4lparse: %v (line %d in %q)", r, LINE_NUM, CURRENT_FILE)
		}
	}()

	tConfig := time.Now()
	AddMandatory(sst)
	CONFIGURING = true
	for _, name := range configOrder {
		data, readErr := embeddedConfigs.ReadFile("embeddedconfig/" + name)
		if readErr != nil {
			return res, fmt.Errorf("n4lparse: embedded config %q missing: %w", name, readErr)
		}
		resetParserState(name)
		ParseConfig(sst, []rune(string(data)))
	}
	// User-supplied SSTconfig/*.sst, deterministic order.
	configNames := make([]string, 0, len(userConfigs))
	for n := range userConfigs {
		configNames = append(configNames, n)
	}
	sort.Strings(configNames)
	for _, name := range configNames {
		resetParserState(name)
		ParseConfig(sst, []rune(userConfigs[name]))
	}
	CONFIGURING = false
	res.ConfigMs = time.Since(tConfig).Milliseconds()

	// 2. User files, in deterministic (name) order.
	names := make([]string, 0, len(userFiles))
	for n := range userFiles {
		names = append(names, n)
	}
	sort.Strings(names)

	tFiles := time.Now()
	for _, name := range names {
		if fe := parseOneFile(sst, name, userFiles[name]); fe != nil {
			res.Errors = append(res.Errors, *fe)
			continue
		}
		res.Files = append(res.Files, name)
	}
	res.FilesMs = time.Since(tFiles).Milliseconds()

	// 3. Post-process (NEAR cliques, etc).
	tInfer := time.Now()
	CompleteInferences(sst)
	res.InferMs = time.Since(tInfer).Milliseconds()

	res.N1Directory = len(sst.NODE_DIRECTORY.N1directory)
	res.N2Directory = len(sst.NODE_DIRECTORY.N2directory)
	res.N3Directory = len(sst.NODE_DIRECTORY.N3directory)
	res.LT128 = len(sst.NODE_DIRECTORY.LT128)
	res.LT1024 = len(sst.NODE_DIRECTORY.LT1024)
	res.GT1024 = len(sst.NODE_DIRECTORY.GT1024)
	res.ArrowTotal = int(sst.ARROW_DIRECTORY_TOP)
	return res, nil
}

// parseOneFile parses a single file inside its own recover so a panic
// (parser fatal) is captured as a FileError and the outer batch can
// continue with the next file.
func parseOneFile(sst *SST.PoSST, name, content string) (fe *FileError) {
	defer func() {
		if r := recover(); r != nil {
			msg := fmt.Sprintf("%v", r)
			if LAST_PARSE_ERROR != "" {
				msg = LAST_PARSE_ERROR
			}
			fe = &FileError{File: name, Line: LINE_NUM, Err: msg}
		}
	}()
	LAST_PARSE_ERROR = ""
	resetParserState(name)
	ParseN4L(sst, []rune(content))
	return nil
}

// resetParserState mirrors NewFile() but skips the os.Stat +
// large-file warning path. Callers feed content directly from memory.
func resetParserState(name string) {
	CURRENT_FILE = name
	TEST_DIAG_FILE = DiagnosticName(name)

	LINE_ITEM_STATE = ROLE_BLANK_LINE
	LINE_NUM = 1
	LINE_ITEM_CACHE = make(map[string][]string)
	LINE_RELN_CACHE = make(map[string][]SST.Link)
	LINE_ITEM_REFS = nil
	LINE_ITEM_COUNTER = 1
	LINE_RELN_COUNTER = 0
	LINE_ALIAS = ""
	LAST_IN_SEQUENCE = ""
	LINE_PATH = nil
	SEQUENCE_MODE = false
	FWD_ARROW = ""
	BWD_ARROW = ""
	SECTION_STATE = ""
	ResetContextState()
	ContextEval("any", "=")
}
