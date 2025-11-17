# Elisp Development Tools

Batch-mode Elisp development tools adapted from [elisp-dev-mcp](https://github.com/laurynas-biveinis/elisp-dev-mcp) for use with Claude Code.

## Quick Start

### Option 1: REPL Server (Recommended - 15x faster)

```bash
cd contrib/emacs

# Start the server (once)
./elisp-dev-server start

# Query functions (fast!)
./elisp-dev-client df car | jq .
./elisp-dev-client source mapcar | jq -r .source

# Stop when done
./elisp-dev-server stop
```

### Option 2: Batch Mode (Slower but simpler)

```bash
cd contrib/emacs

# Each command starts a new Emacs process
./elisp-dev df car | jq .
./elisp-dev source mapcar | jq -r .source
```

## Commands

### describe-function (df)

Get documentation for a function.

```bash
./elisp-dev df mapcar
```

Output:
```json
{
  "function": "mapcar",
  "description": "Apply FUNCTION to each element..."
}
```

### get-function-definition (source, gf)

Get source code with line numbers.

```bash
./elisp-dev source mapcar
```

Output:
```json
{
  "source": "(defun mapcar ...)",
  "file-path": "/usr/share/emacs/.../subr.el",
  "start-line": 123,
  "end-line": 145
}
```

Or for C functions:
```json
{
  "is-c-function": true,
  "function-name": "car",
  "message": "Function is implemented in C source code"
}
```

### describe-variable (dv)

Get variable information (without exposing the value).

```bash
./elisp-dev dv load-path
```

Output:
```json
{
  "name": "load-path",
  "bound": true,
  "value-type": "cons",
  "documentation": "List of directories...",
  "source-file": "C-source",
  "is-custom": false,
  "is-special": true
}
```

### info-lookup (info)

Look up symbol in Info documentation.

```bash
./elisp-dev info defun
```

Output:
```json
{
  "found": true,
  "symbol": "defun",
  "node": "Defining Functions",
  "manual": "elisp",
  "content": "...",
  "info-ref": "(elisp)Defining Functions"
}
```

### read-file (read)

Safely read Elisp source files.

```bash
./elisp-dev read /usr/share/emacs/29.1/lisp/files.el
```

**Security**: Only reads from:
- Emacs system lisp directories
- `~/.emacs.d/elpa/`

Rejects paths with `..` traversal and resolves symlinks.

## Usage in Development

### Understanding magit-section

```bash
# Get documentation
./elisp-dev df magit-insert-section | jq -r .description

# Find source
./elisp-dev source magit-section-mode | jq -r '.["file-path"]'

# Read entire source file
FILE=$(./elisp-dev source magit-section-mode | jq -r '.["file-path"]')
./elisp-dev read "$FILE" | jq -r .content | less
```

### Debugging

```bash
# Check if function exists
./elisp-dev df my-function 2>&1 | jq -e .error > /dev/null && echo "Not found"

# Get line numbers for errors
./elisp-dev source problematic-function | jq '.["start-line"], .["end-line"]'
```

### Exploring APIs

```bash
# Find all magit-section functions (requires grep)
./elisp-dev source magit-section-mode | \
  jq -r '.["file-path"]' | \
  xargs grep -n "^(defun magit-" | \
  head -20
```

## Implementation

Files:
- `elisp-dev-tools.el` - Core functionality
- `elisp-dev` - CLI wrapper script

The tools run in Emacs batch mode and output JSON for easy parsing with `jq`.

## Server Management

The REPL server runs a persistent Emacs process that responds to queries over TCP port 9999.

```bash
# Start server
./elisp-dev-server start

# Check status
./elisp-dev-server status

# View logs
./elisp-dev-server logs

# Restart server
./elisp-dev-server restart

# Stop server
./elisp-dev-server stop
```

## Performance

Comparison of batch mode vs REPL server:

| Mode | Time | Speedup |
|------|------|---------|
| Batch (`./elisp-dev df car`) | 338ms | 1x |
| REPL (`./elisp-dev-client df car`) | 22ms | **15x** |

The REPL server is recommended for interactive use and when making multiple queries.

## Differences from MCP Version

This adaptation:
- ✅ Works with Claude Code (no MCP server needed)
- ✅ Same functionality as elisp-dev-mcp
- ✅ JSON output for programmatic use
- ✅ REPL server option for fast queries (15x faster than batch)
- ✅ Batch mode option for simple one-off queries
- ❌ Requires Emacs to be installed locally

For Claude Desktop users, the original [elisp-dev-mcp](https://github.com/laurynas-biveinis/elisp-dev-mcp) MCP server is recommended as it integrates directly with the LLM.

## Testing

Included in the automated test suite:

```bash
./test-package.sh
```

All elisp-dev tools are tested as part of the package testing workflow.
