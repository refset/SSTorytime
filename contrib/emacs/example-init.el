;;; example-init.el --- Live development environment for SSTorytime -*- lexical-binding: t; -*-

;;; Commentary:

;; Complete SSTorytime development environment with REPL server.
;; Use it with:
;;   emacs -Q -l contrib/emacs/example-init.el
;;
;; Or headless for testing:
;;   emacs -Q --batch -l contrib/emacs/example-init.el \
;;     --eval '(sstorytime-search "jeremy")'

;;; Code:

(setq debug-on-error t)

;; Set up package archives
(require 'package)
(add-to-list 'package-archives '("melpa" . "https://melpa.org/packages/") t)
(package-initialize)

;; Install dependencies if needed
(dolist (pkg '(magit-section transient))
  (unless (package-installed-p pkg)
    (unless package-archive-contents
      (package-refresh-contents))
    (package-install pkg)))

;; Add current directory to load path
(let ((emacs-dir (file-name-directory (or load-file-name buffer-file-name))))
  (add-to-list 'load-path emacs-dir))

;; Load elisp-dev tools for development introspection
(load (expand-file-name "elisp-dev-tools.el"
                        (file-name-directory (or load-file-name buffer-file-name))))

;; Load elisp-dev server (for potential direct use)
(load (expand-file-name "elisp-dev-server.el"
                        (file-name-directory (or load-file-name buffer-file-name))))

;; Load sstorytime
(require 'sstorytime)
(require 'sstorytime-browser)

;; Configure paths
(setq sstorytime-tools-path
      (expand-file-name "../../src"
                        (file-name-directory (or load-file-name buffer-file-name))))

(setq sstorytime-http-endpoint "http://localhost:8080/searchN4L")

;; Start the elisp-dev REPL server IN THIS EMACS PROCESS
(defun sstorytime-example--start-repl-server ()
  "Start the elisp-dev REPL server in this Emacs process."
  (condition-case err
      (progn
        (elisp-dev-server-start-tcp)
        (message "✓ Started elisp-dev REPL server on port 9999 (in this Emacs)"))
    (error
     (message "Note: elisp-dev server start failed or already running: %s" err))))

;; Only start in interactive mode
(unless noninteractive
  (sstorytime-example--start-repl-server))

;; Set up convenient keybindings
(global-set-key (kbd "C-c k") #'sstorytime-dispatch)
(global-set-key (kbd "C-c s") #'sstorytime-search)

;; Create a welcome/testing buffer
(defun sstorytime-example--create-welcome-buffer ()
  "Create a welcome buffer with usage instructions."
  (with-current-buffer (get-buffer-create "*SSTorytime Welcome*")
    (let ((inhibit-read-only t))
      (erase-buffer)
      (insert "# SSTorytime Live Development Environment\n\n")
      (insert "## Quick Start\n\n")
      (insert "Try these commands:\n\n")
      (insert "  M-x sstorytime-search RET jeremy RET\n")
      (insert "  C-c s   (keybinding for search)\n")
      (insert "  C-c k   (transient menu with all commands)\n\n")
      (insert "## Browser Navigation\n\n")
      (insert "In the *SSTorytime Browser* buffer:\n\n")
      (insert "  TAB       - Cycle section visibility (expand/collapse)\n")
      (insert "  RET       - Navigate to node at point\n")
      (insert "  s         - New search\n")
      (insert "  r         - Refresh current view\n")
      (insert "  q         - Quit browser\n")
      (insert "  ?         - Show transient menu\n\n")
      (insert "## Elisp Development (REPL Server)\n\n")
      (insert "The elisp-dev server runs IN THIS EMACS on port 9999.\n")
      (insert "Claude can introspect and eval in your live session!\n\n")
      (insert "From shell:\n\n")
      (insert "  ./elisp-dev-client df sstorytime-search\n")
      (insert "  ./elisp-dev-client source sstorytime-browse-enter | jq\n")
      (insert "  ./elisp-dev-client dv sstorytime-tools-path | jq\n")
      (insert "  ./elisp-dev-client eval '(buffer-list)'\n\n")
      (insert "## Iterating on Changes\n\n")
      (insert "After editing sstorytime.el or sstorytime-browser.el:\n\n")
      (insert "  1. M-x eval-buffer RET (or C-x C-e on individual forms)\n")
      (insert "  2. M-x sstorytime-search RET <query> RET\n")
      (insert "  3. Test the visual changes in the browser\n\n")
      (insert "For headless testing:\n\n")
      (insert "  emacs -Q --batch -l contrib/emacs/example-init.el \\\n")
      (insert "    --eval '(sstorytime-search \"jeremy\")'\n\n")
      (insert "## Server Status Check\n\n")
      (insert "  HTTP server: curl http://localhost:8080/searchN4L?q=test\n")
      (insert "  REPL server: ./elisp-dev-client ping\n\n")
      (insert "---\n\n")
      (insert "Press 'q' to close, then: M-x sstorytime-search\n"))
    (special-mode)
    (local-set-key (kbd "q") 'kill-current-buffer)
    (goto-char (point-min))
    (current-buffer)))

;; Show welcome buffer if interactive
(when (and (not noninteractive) (display-graphic-p))
  (switch-to-buffer (sstorytime-example--create-welcome-buffer)))

;; Print startup messages
(message "✓ SSTorytime loaded! Try: M-x sstorytime-search or C-c k s")
(message "✓ elisp-dev REPL server: ./elisp-dev-client <command>")
(message "✓ HTTP endpoint: %s" sstorytime-http-endpoint)

(provide 'example-init)
;;; example-init.el ends here
