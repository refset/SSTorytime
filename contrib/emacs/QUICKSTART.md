# SSTorytime Emacs - Quick Start Guide

## First Time Setup (5 minutes)

### Step 1: Launch Emacs with the test config

```bash
cd ~/ghq/github.com/markburgess/SSTorytime
emacs -Q -l contrib/emacs/example-init.el
```

This starts Emacs with a minimal configuration that loads SSTorytime.

### Step 2: Check Setup

Run: `M-x sstorytime-check-setup`

You should see:
```
SSTorytime setup looks good!
Tools: /home/jdt/ghq/github.com/markburgess/SSTorytime/src
Server: http://localhost:8080
```

If you see errors, run: `M-x sstorytime-configure`

### Step 3: Start SSTorytime

Press: `C-c k` or run `M-x sstorytime`

You'll see the main menu:

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

### Step 4: Try a Search

Press `s` and type: `chinese`

You'll see search results in a magit-section buffer.

### Step 5: Navigate

- Press `TAB` to expand/collapse sections
- Press `RET` to navigate to a node
- Press `g` to refresh
- Press `q` to quit

## Common Issues

### "Tool not found: searchN4L"

**Fix**: Set the correct path:

```elisp
M-x sstorytime-configure
```

Then enter: `/home/jdt/ghq/github.com/markburgess/SSTorytime/src`

### "No such program ./searchN4L"

This means `sstorytime-tools-path` is not set correctly.

**Quick fix in Emacs**:

```elisp
M-: (setq sstorytime-tools-path "/home/jdt/ghq/github.com/markburgess/SSTorytime/src")
```

Then try again: `C-c k s`

### Search returns nothing

Make sure the database has data:

```bash
cd ~/ghq/github.com/markburgess/SSTorytime/examples
make
```

## Next Steps

### Add to Your Config

Once it's working, add to your `~/.emacs` or `~/.emacs.d/init.el`:

```elisp
;; Load SSTorytime
(add-to-list 'load-path "~/ghq/github.com/markburgess/SSTorytime/contrib/emacs")
(require 'sstorytime)

;; Configure path
(setq sstorytime-tools-path
      (expand-file-name "~/ghq/github.com/markburgess/SSTorytime/src"))

;; Optional keybinding
(global-set-key (kbd "C-c k") #'sstorytime-dispatch)
```

### Create Your First Notes

1. Press `C-c k` then `e`
2. Name your file: `my-notes`
3. Edit:

```n4l
- my notes

:: learning, emacs ::

Emacs (is a) text editor
  "    (has feature) extensibility
  "    (uses) Lisp

SSTorytime (integrates with) Emacs
```

4. Save: `C-x C-s`
5. Upload: `C-c C-u`
6. Search: `C-c k s` → type "emacs"

## Keyboard Shortcuts Summary

### In any buffer:
- `C-c k` - Open SSTorytime menu
- `C-c k s` - Quick search

### In N4L files:
- `C-c C-u` - Upload to database
- `C-c C-v` - Validate syntax
- `C-c C-c` - Open menu

### In browse buffers:
- `RET` - Open node at point
- `TAB` - Toggle section
- `g` - Refresh
- `s` - New search
- `c` - Search by chapter
- `C` - Search by context
- `?` - Show menu
- `q` - Quit window

## Tips

### Quick Setup Check

Run this in Emacs:

```elisp
M-: (file-exists-p (expand-file-name "searchN4L" sstorytime-tools-path))
```

Should return: `t`

### See What Path Is Being Used

```elisp
M-: sstorytime-tools-path
```

### Test a Tool Directly

```elisp
M-: (sstorytime--call-tool "searchN4L" "test")
```

This should return search results.

## Getting Help

- Run `M-x sstorytime-check-setup` to diagnose issues
- Check the `*Messages*` buffer for error details
- See README.md for full documentation
