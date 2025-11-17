# Claude Development Notes for SSTorytime

## Project Overview

SSTorytime is a knowledge graph system based on Semantic Spacetime theory. It consists of:

- **N4L Language**: A simple note-taking format for capturing knowledge
- **PostgreSQL Backend**: Stores nodes and relationships with full-text search
- **Go CLI Tools**: Parse, validate, and query the knowledge graph
- **HTTP Server**: JSON API for web/programmatic access
- **Emacs Interface**: Interactive browser using magit-section

## Quick Context

### What SSTorytime Does

- Converts human-readable notes (N4L format) into a searchable knowledge graph
- Stores 4 types of relationships: Similarity (0), Leads-to (1), Contains (2), Properties (3)
- Provides "orbit" views showing connected nodes
- Enables semantic search with context and chapter filtering

### Key Files

```
src/
├── N4L                     # Parser/compiler (Go binary)
├── searchN4L               # Search tool (Go binary)
├── http_server             # JSON API server (Go binary)
└── server/http_server.go   # Server source

contrib/emacs/
├── sstorytime.el           # Main Emacs package
├── sstorytime-browser.el   # magit-section browser
├── example-init.el         # Test configuration
└── QUICKSTART.md           # User guide

examples/
└── *.n4l                   # Example knowledge bases
```

### Database

- Uses PostgreSQL (runs in Docker or system-wide)
- Default connection: `localhost:5432`, db: `sstoryline`, user: `sstoryline`
- Schema created automatically on first upload
- Uses PostgreSQL `ts_vector` for full-text search

### N4L Syntax Essentials

```n4l
-chapter name                    # Chapter declaration
:: context, tags ::              # Set context
Item A (relationship) Item B     # Create link
@label Node                      # Create reference
$label (refers to) Other         # Use reference
ALL CAPS TEXT                    # Creates reminder
```

## Development Workflow

### Using elisp-dev Tools (Recommended)

We have a batch-mode version of [elisp-dev-mcp](https://github.com/laurynas-biveinis/elisp-dev-mcp) that works with Claude Code:

```bash
cd contrib/emacs

# Get function documentation
./elisp-dev df car

# Get function source code
./elisp-dev source mapcar

# Get variable information
./elisp-dev dv load-path

# Look up in Info docs
./elisp-dev info defun

# Read source file
./elisp-dev read /usr/share/emacs/29.1/lisp/files.el
```

All commands output JSON for easy parsing. Use `./elisp-dev help` for full usage.

This provides structured access to Emacs internals without needing the full MCP server.

### Automated Testing Script

Use the provided test script:

```bash
cd contrib/emacs
./test-package.sh
```

This runs all checks in the correct order and handles dependency installation.

### Emacs Package Development

When working on the Emacs interface (`contrib/emacs/`), **always follow this order**:

#### 1. Syntax Check First (Byte Compilation)

```bash
emacs --batch -f batch-byte-compile contrib/emacs/sstorytime.el
emacs --batch -f batch-byte-compile contrib/emacs/sstorytime-browser.el
```

**Why**: LLMs frequently generate syntax errors (unbalanced parens, missing quotes). Catch these before anything else.

**Common Issues**:
- Unbalanced parentheses (use `check-parens` or count with awk)
- Missing `provide` statement
- Unclosed strings in docstrings

#### 2. Load Test

```bash
emacs --batch --eval "(progn \
  (require 'package) \
  (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
  (package-initialize) \
  (add-to-list 'load-path \"$(pwd)/contrib/emacs\") \
  (require 'sstorytime) \
  (message \"✅ Package loaded successfully\"))"
```

#### 3. Run elisp-autofmt (if available)

```bash
# Skip if syntax errors exist
elisp-autofmt contrib/emacs/sstorytime.el
elisp-autofmt contrib/emacs/sstorytime-browser.el
```

Prevents runaway re-indentation from syntax errors.

#### 4. Run elisp-lint (if available)

```bash
# Skip if syntax errors or autofmt failures
elisp-lint contrib/emacs/sstorytime.el
```

#### 5. Integration Test

```bash
emacs -Q -l contrib/emacs/example-init.el
# Then: M-x sstorytime-check-setup
# Then: C-c k s RET chinese restaurant RET
```

### Debugging Elisp Syntax Errors

**Count parentheses**:
```bash
grep -o '(' file.el | wc -l
grep -o ')' file.el | wc -l
```

**Find unbalanced location**:
```bash
awk 'BEGIN{depth=0} {
  for(i=1;i<=length($0);i++){
    c=substr($0,i,1);
    if(c=="(")depth++;
    if(c==")")depth--
  }
  if(NR%50==0) print NR": depth="depth
}
END{print "Final: "depth}' file.el
```

**Check specific function**:
```bash
emacs --batch --eval "(let ((file \"path/to/file.el\")) \
  (with-temp-buffer \
    (insert-file-contents file) \
    (emacs-lisp-mode) \
    (check-parens)))"
```

### Go Development

**Build all tools**:
```bash
cd src && make
```

**Test a tool**:
```bash
cd src
./N4L -v ../examples/jeremy.n4l
./searchN4L "chinese restaurant"
```

**Start HTTP server**:
```bash
cd src
./http_server &
# Test: curl http://localhost:8080/searchN4L?name=test
```

## Common Gotchas

### Emacs Interface

1. **`oget` doesn't exist**: Use `magit-section-type` and `magit-section-value` instead
2. **`when-let` unavailable**: Use plain `let` + `when` for compatibility
3. **HTTP API returns JSON**: Don't use CLI tool output, parse JSON from `/searchN4L` endpoint
4. **Section hierarchy**: Must match: `(magit-insert-section (TYPE VALUE HIDE) ...)`

### N4L Files

1. **Apostrophes in chapter names**: Causes SQL injection errors (known bug)
   - Use: `- jeremy exo-brain`
   - Not: `- jeremy's exo-brain`

2. **Special characters**: Quote URLs and anything with `//`
   ```n4l
   Link (has url) "https://example.com"  # Correct
   Link (has url) https://example.com    # Wrong - // is comment
   ```

3. **Relationship types**: Must be one of 4 categories:
   - Similarity (0): `similar to`, `same as`, `like`
   - Leads-to (1): `causes`, `then`, `precedes`
   - Contains (2): `contains`, `part of`, `member of`
   - Properties (3): `has`, `means`, `note`

## HTTP API Reference

### Search Endpoint

```bash
curl "http://localhost:8080/searchN4L?name=QUERY"
```

**Response**:
```json
{
  "Response": "Orbits",
  "Content": [
    {
      "Text": "node text",
      "Chap": "chapter name",
      "Context": "context tags",
      "NPtr": {"Class": 4, "CPtr": 123},
      "Orbits": [
        [
          {
            "Radius": 1,
            "Arrow": "relationship name",
            "Text": "connected node text",
            "Ctx": "context"
          }
        ]
      ]
    }
  ],
  "Time": "Sun:Hr09:Qu3-Min30_35",
  "Intent": "query keywords...",
  "Ambient": "context info"
}
```

**Orbits**: Array of arrays, indexed by radius. Each orbit contains connected nodes.

## Testing Checklist

Before committing changes:

### Emacs Package

- [ ] Byte-compile succeeds (both .el files)
- [ ] Package loads: `(require 'sstorytime)`
- [ ] `sstorytime-check-setup` reports no issues
- [ ] Search works: `C-c k s`
- [ ] Sections expand/collapse: `TAB`
- [ ] Navigation works: `RET` on nodes
- [ ] N4L mode syntax highlighting works
- [ ] Upload works: `C-c C-u` in .n4l file

### Go Tools

- [ ] `make` succeeds
- [ ] N4L validates example files
- [ ] searchN4L returns results
- [ ] http_server starts and responds

### Integration

- [ ] Upload example → search → see results in Emacs
- [ ] Click node → new search → recursive navigation works
- [ ] Color-coded links display correctly

## Live Development Workflow with REPL Server (2025-11-16)

### Interactive Development Session

We successfully implemented a **live development workflow** where Claude Code can:

1. **Read Emacs buffers remotely** via elisp-dev REPL server
2. **Eval code changes** in the running Emacs session
3. **Test changes visually** before committing to user testing
4. **Iterate quickly** without restarting Emacs

### Setup

**Start the development environment:**

```bash
emacs -Q -l contrib/emacs/example-init.el
```

This automatically:
- Loads SSTorytime with magit-section browser
- Starts elisp-dev REPL server on port 9999 **inside the same Emacs process**
- Configures paths and keybindings
- Shows welcome buffer with instructions

### Claude Code's Development Workflow

**1. Read live buffers to understand state:**

```bash
# List all open buffers
./elisp-dev-client list-buffers | jq .

# Read a specific buffer (including *Warnings*, *Messages*, *Backtrace*)
./elisp-dev-client get-buffer "*Warnings*" | jq -r .content
./elisp-dev-client get-buffer "*SSTorytime*" | jq -r .content
```

**2. Introspect the live session:**

```bash
# Check what functions are loaded
./elisp-dev-client df sstorytime-browse-enter | jq .

# Get source of loaded function
./elisp-dev-client source sstorytime-browse-enter | jq .

# Check variable values
./elisp-dev-client dv sstorytime-n4l-directory | jq .
```

**3. Test changes by eval'ing in live session:**

```bash
# Reload a file with changes
./elisp-dev-client eval '(load "/path/to/sstorytime-browser.el")' | jq .

# Update a variable
./elisp-dev-client eval '(setq sstorytime-n4l-directory "/path/to/n4l/files")' | jq .

# Update a keymap
./elisp-dev-client eval '(setq sstorytime-browse-mode-map ...)' | jq .

# Apply keymap to running buffer
./elisp-dev-client eval '(with-current-buffer "*SSTorytime*" (use-local-map sstorytime-browse-mode-map))' | jq .
```

**4. Verify the changes work:**

```bash
# Check if a text property is set
./elisp-dev-client eval '(with-current-buffer "*SSTorytime*" (goto-char (point-min)) (re-search-forward "Chapter: ") (get-text-property (point) (quote sstorytime-chapter)))' | jq .

# Simulate user action
./elisp-dev-client eval '(with-current-buffer "*SSTorytime*" (goto-char (point-min)) (re-search-forward "Chapter: ") (sstorytime-browse-enter))' | jq .

# Verify expected result
./elisp-dev-client list-buffers | jq '.buffers[] | select(.name | contains("emacs-test"))'
```

**5. Check for errors:**

```bash
# Read backtrace if something failed
./elisp-dev-client get-buffer "*Backtrace*" | jq -r .content
```

### Example Session: Fixing Chapter Navigation

**Problem**: RET on chapters wasn't working

**Debugging process:**

```bash
# 1. Check what's at point
./elisp-dev-client eval '(with-current-buffer "*SSTorytime*"
  (goto-char (point-min))
  (re-search-forward "Chapter: ")
  (list :section-type (oref (magit-current-section) type)
        :chapter-prop (get-text-property (point) (quote sstorytime-chapter))))' | jq .
# Result: {:section-type: "node", :chapter-prop: "emacs-test"}

# 2. Realized: chapter property exists but node section handler runs first

# 3. Fixed: Check text property before section type

# 4. Reloaded code
./elisp-dev-client eval '(load "/path/to/sstorytime-browser.el")' | jq .

# 5. Tested the fix
./elisp-dev-client eval '(with-current-buffer "*SSTorytime*"
  (goto-char (point-min))
  (re-search-forward "Chapter: ")
  (sstorytime-browse-enter))' | jq .

# 6. Verified it opened the file
./elisp-dev-client list-buffers | jq '.buffers[] | select(.name | contains(".n4l"))'
# Result: Found "emacs-test.n4l" buffer - SUCCESS!
```

### Key Advantages

**For Claude:**
- **See actual errors** from *Backtrace* buffer instead of guessing
- **Test fixes immediately** without asking user to try each iteration
- **Verify text properties** and internal state before declaring success
- **Iterate rapidly** - fix syntax, reload, test, repeat

**For User:**
- **Only test working solutions** - no debugging syntax errors in UI
- **Keep working** - changes happen in background without disrupting session
- **Trust the fixes** - Claude tested them in the live environment first

### elisp-dev REPL Server Details

**Architecture:**
- Single Emacs process runs both the UI and REPL server
- TCP server on port 9999 listens for JSON-RPC requests
- Commands available: `df`, `source`, `dv`, `eval`, `list-buffers`, `get-buffer`, `ping`

**Performance:**
- 15x faster than batch mode (22ms vs 338ms per query)
- No Emacs startup overhead
- Persistent state matches user's session

**Commands:**

```bash
# Server management
./elisp-dev-server start   # Start (done automatically by example-init.el)
./elisp-dev-server status  # Check if running
./elisp-dev-server stop    # Stop server

# Client commands (to running server)
./elisp-dev-client df <function>
./elisp-dev-client source <function>
./elisp-dev-client dv <variable>
./elisp-dev-client eval '<elisp-expression>'
./elisp-dev-client list-buffers
./elisp-dev-client get-buffer "<buffer-name>"
./elisp-dev-client ping
```

### Integration with Claude Code

The REPL server enables Claude Code to:
1. **Read user's buffers** to see warnings/errors/state
2. **Introspect loaded code** to understand current implementation
3. **Eval fixes** to test them in the live session
4. **Verify results** by checking buffer state after changes

This creates a **rapid feedback loop** without requiring user interaction for every iteration.

## Recent Changes (2025-11-16)

### Created Interactive Emacs Browser

- **sstorytime-browser.el**: New magit-section based interface
  - Parses JSON from HTTP API (not CLI output)
  - Hierarchical expandable sections
  - Clickable nodes for recursive navigation
  - Color-coded relationship types (4 STtypes)
  - UTF-8 rendering for Chinese/Unicode characters
  - Back/forward navigation history (browser-like)
  - Chapter navigation (RET on chapter opens N4L file)

- **REPL server for live development**:
  - elisp-dev-server runs inside user's Emacs session
  - Claude can read buffers, eval code, and test changes remotely
  - 15x faster than batch mode
  - Enables iterative development without restarting Emacs

- **Upload workflow improvements**:
  - Added `sstorytime-reupload-buffer` - wipe and re-upload
  - Force upload with `-force` flag
  - Confirmation dialogs for destructive operations

- **Fixed compatibility issues**:
  - Replaced `oget` with `oref` for struct access
  - UTF-8 encoding for HTTP responses
  - Text properties checked before section navigation
  - Multiple parenthesis balancing issues

- **Testing approach**:
  - Live buffer introspection via REPL
  - Remote eval for testing fixes before user sees them
  - Backtrace reading for debugging errors
  - Syntax validation with check-parens

### Key Lessons

1. **Always byte-compile first** - catches 90% of issues
2. **Use JSON API, not CLI parsing** - structured data is reliable
3. **Live REPL testing** - test fixes in user's session before asking them to try
4. **Read buffer state** - see actual errors instead of guessing
5. **Check text properties first** - they override section-based navigation
6. **UTF-8 explicit** - set encoding, enable multibyte, decode responses
7. **Use elisp-dev tools** - structured queries better than grep/awk

### Elisp Development Tools

```bash
# Available in contrib/emacs/elisp-dev
./elisp-dev df <function>       # Documentation
./elisp-dev source <function>   # Source code with line numbers
./elisp-dev dv <variable>       # Variable properties
./elisp-dev info <symbol>       # Info documentation
./elisp-dev read <file>         # Read source file
```

Example workflow:
```bash
# 1. Look up how a function works
./elisp-dev df magit-insert-section | jq -r .description

# 2. Get its source code
./elisp-dev source magit-insert-section | jq -r .source

# 3. Find where it's defined
./elisp-dev source magit-insert-section | jq -r '"\(.["file-path"]):\(.["start-line"])"'

# 4. Read the whole file
./elisp-dev source magit-insert-section | jq -r .["file-path"] | xargs ./elisp-dev read
```

## Future Work

### Emacs Interface

- [ ] Cache visited nodes (avoid re-fetching)
- [ ] Graphviz visualization integration
- [ ] Org-mode export of subgraphs
- [ ] Company-mode completion for node names
- [ ] Embark integration for actions on nodes
- [ ] Consult integration for fuzzy search
- [ ] History navigation (back/forward buttons)

### Core System

- [ ] Fix SQL injection in chapter names (escape apostrophes)
- [ ] Add WebSocket support for live updates
- [ ] Implement differential sync (don't re-upload everything)
- [ ] Add org-roam import wizard

## Useful Commands

### Quick Test

```bash
# Start fresh
cd ~/ghq/github.com/markburgess/SSTorytime
docker compose -f postgres-docker/docker-compose.yml up -d
cd src && make
cd ../examples && make
cd ../src && ./http_server &

# Test Emacs
emacs -Q -l contrib/emacs/example-init.el
# M-x sstorytime-search RET chinese restaurant RET
```

### Debug

```bash
# Check server logs
curl http://localhost:8080/status

# Test API directly
curl "http://localhost:8080/searchN4L?name=test" | jq .

# Validate N4L syntax
cd src && ./N4L -v ../examples/jeremy.n4l
```

### Clean Slate

```bash
# Restart database
docker compose -f postgres-docker/docker-compose.yml down -v
docker compose -f postgres-docker/docker-compose.yml up -d

# Rebuild tools
cd src && make clean && make

# Re-upload examples
cd ../examples && make
```
