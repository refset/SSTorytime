# SSTorytime Emacs Interface

An Emacs interface for SSTorytime that provides a native, magit-like experience for browsing and editing knowledge graphs.

## Features

- **magit-section UI** - Collapsible, hierarchical display of search results and node relationships
- **transient menus** - Familiar, discoverable command interface
- **N4L mode** - Syntax highlighting and validation for N4L files
- **Direct integration** - Upload and validate notes without leaving Emacs
- **Search interface** - Full-text search with context and chapter filtering

## Installation

### Prerequisites

This package requires:
- Emacs 27.1 or later
- `magit-section` (from Magit)
- `transient` (from Magit)

If you use Magit, you already have these dependencies.

### Using Straight.el

```elisp
(straight-use-package
 '(sstorytime :type git
              :host github
              :repo "markburgess/SSTorytime"
              :files ("contrib/emacs/*.el")))
```

### Using use-package with straight

```elisp
(use-package sstorytime
  :straight (sstorytime :type git
                        :host github
                        :repo "markburgess/SSTorytime"
                        :files ("contrib/emacs/*.el"))
  :commands (sstorytime)
  :bind ("C-c k" . sstorytime-dispatch)
  :config
  (setq sstorytime-tools-path "~/ghq/github.com/markburgess/SSTorytime/src"))
```

### Manual Installation

1. Clone the SSTorytime repository
2. Add to your load path:

```elisp
(add-to-list 'load-path "~/ghq/github.com/markburgess/SSTorytime/contrib/emacs")
(require 'sstorytime)
```

### Configuration

Set the path to your SSTorytime installation:

```elisp
(setq sstorytime-tools-path "~/ghq/github.com/markburgess/SSTorytime/src")
```

Optionally customize other settings:

```elisp
(setq sstorytime-server-url "http://localhost:8080"
      sstorytime-default-limit 20
      sstorytime-db-name "sstoryline"
      sstorytime-db-user "sstoryline"
      sstorytime-db-password "sst_1234"
      sstorytime-db-host "localhost"
      sstorytime-db-port 5432)
```

## Usage

### Main Interface

Press `?` or run `M-x sstorytime-dispatch` to open the main menu:

```
Search                  Browse                  Edit
s  Search               b  Browse Results       e  New N4L File
c  By Chapter           n  Show Node            o  Open N4L File
C  By Context           p  Find Path            u  Upload Buffer
f  From Node                                     v  Validate Buffer
t  To Node

Tools
S  Start Server
K  Stop Server
R  Rebuild Tools
```

### Editing N4L Files

1. **Create a new file**: `M-x sstorytime-new-file` or `e` in the dispatch menu
2. **Edit with syntax highlighting**: `.n4l` files automatically use `sstorytime-n4l-mode`
3. **Validate**: `C-c C-v` or `v` in dispatch menu
4. **Upload**: `C-c C-u` or `u` in dispatch menu

### Searching

- `s` - Free-text search
- `c` - Search by chapter
- `C` - Search by context tags
- `f` - Search from a specific node
- `t` - Search to a specific node
- `p` - Find paths between nodes

### Browsing Results

In browse buffers:

- `RET` - Navigate to node at point
- `TAB` - Expand/collapse section
- `g` - Refresh
- `s` - New search
- `?` - Open dispatch menu
- `q` - Quit window

## N4L Mode

The `sstorytime-n4l-mode` provides:

### Syntax Highlighting

- **Chapters** - `- chapter name`
- **Context tags** - `:: tags ::`
- **Relationships** - `(relation)`
- **References** - `@label` and `$label.1`
- **Comments** - `#` or `//`
- **Reminders** - `ALL CAPS TEXT`

### Keybindings

| Key         | Command                   | Description              |
|-------------|---------------------------|--------------------------|
| `C-c C-u`   | `sstorytime-upload-buffer` | Upload to database       |
| `C-c C-v`   | `sstorytime-validate-buffer` | Validate syntax        |
| `C-c C-c`   | `sstorytime-dispatch`     | Open command menu        |

## Example Workflow

### 1. Start the Server

```elisp
M-x sstorytime-start-server
```

Or from dispatch menu: `S`

### 2. Create Notes

```elisp
M-x sstorytime-new-file RET my-notes RET
```

This creates `my-notes.n4l`:

```n4l
- my-notes

:: notes ::

```

### 3. Write Your Notes

```n4l
- my-notes

:: productivity, tools ::

Emacs (is a) text editor
  "    (has feature) extensibility
  "    (written in) Emacs Lisp

SSTorytime (is a) knowledge graph system
    "       (uses) PostgreSQL
    "       (has interface) Emacs
    "       (has interface) Web UI

Emacs (can use) SSTorytime
```

### 4. Validate and Upload

- `C-c C-v` to validate
- `C-c C-u` to upload

### 5. Search and Browse

- `M-x sstorytime-search RET emacs RET`
- Navigate with `RET`
- Explore connected nodes

## Integration with Org-Roam

### Convert Org Files to N4L

You can convert org-roam files to N4L format:

```elisp
(defun my/org-to-n4l (org-file n4l-file)
  "Convert ORG-FILE to N4L-FILE format."
  (interactive "fOrg file: \nFN4L file: ")
  (with-current-buffer (find-file-noselect org-file)
    (let* ((title (or (cadar (org-collect-keywords '("TITLE"))) "notes"))
           (tags (or (cadar (org-collect-keywords '("ROAM_TAGS"))) ""))
           (content (buffer-substring-no-properties (point-min) (point-max))))
      (with-current-buffer (find-file-noselect n4l-file)
        (erase-buffer)
        (sstorytime-n4l-mode)
        (insert (format "- %s\n\n" title))
        (when (not (string-empty-p tags))
          (insert (format ":: %s ::\n\n" tags)))
        ;; Insert simplified content
        ;; This is a basic conversion - you'll want to customize this
        (insert content)
        (save-buffer)
        (message "Converted %s to %s" org-file n4l-file)))))
```

### Link Back to Org Files

Add URLs to link N4L notes back to source org files:

```n4l
My Original Note (has url) "file:///path/to/note.org"
```

## Tips

### Quick Search from Anywhere

Add a global keybinding:

```elisp
(global-set-key (kbd "C-c k s") #'sstorytime-search)
(global-set-key (kbd "C-c k k") #'sstorytime-dispatch)
```

### Auto-upload on Save

```elisp
(add-hook 'sstorytime-n4l-mode-hook
          (lambda ()
            (add-hook 'after-save-hook
                      #'sstorytime-upload-buffer
                      nil t)))
```

### Custom Search Functions

```elisp
(defun my/search-meeting-notes ()
  "Search for meeting notes."
  (interactive)
  (sstorytime-search "context meetings"))

(defun my/search-today ()
  "Search for today's notes."
  (interactive)
  (sstorytime-search (format-time-string "context %Y-%m-%d")))
```

## Troubleshooting

### Server Won't Start

Make sure PostgreSQL is running:

```bash
cd ~/ghq/github.com/markburgess/SSTorytime/postgres-docker
docker compose up -d
```

### Tools Not Found

Check `sstorytime-tools-path`:

```elisp
M-: sstorytime-tools-path
```

Rebuild if needed:

```elisp
M-x sstorytime-rebuild-tools
```

### Upload Fails

Validate first with `C-c C-v` to catch syntax errors.

Avoid apostrophes in chapter names (known bug in SSTorytime).

## Future Enhancements

Planned features:

- [ ] Direct PostgreSQL connection (bypass CLI tools)
- [ ] Graphviz visualization of node orbits
- [ ] Org-mode export/import
- [ ] Company-mode completion for nodes and relations
- [ ] Embark integration
- [ ] Consult integration for searching
- [ ] Inline preview of linked nodes

## Contributing

Contributions welcome! This is a community-driven interface for SSTorytime.

## License

Same as SSTorytime project.
