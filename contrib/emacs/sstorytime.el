;;; sstorytime.el --- Emacs interface for SSTorytime knowledge graphs -*- lexical-binding: t; -*-

;; Copyright (C) 2025

;; Author: SSTorytime Contributors
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1") (magit-section "3.3.0") (transient "0.3.0"))
;; Keywords: tools, knowledge-management, graph
;; URL: https://github.com/markburgess/SSTorytime

;;; Commentary:

;; This package provides an Emacs interface to SSTorytime, a knowledge
;; graph system based on Semantic Spacetime.  It uses magit-section for
;; hierarchical display of nodes and relationships, and transient for
;; command interfaces.
;;
;; Features:
;; - Search and browse knowledge graphs
;; - View node orbits (connected nodes)
;; - Navigate relationships
;; - Edit N4L files with syntax highlighting
;; - Upload notes to the database
;;
;; Setup:
;;   (require 'sstorytime)
;;   (setq sstorytime-tools-path "/path/to/SSTorytime/src")

;;; Code:

(require 'magit-section)
(require 'transient)
(require 'json)
(require 'url)

;; Load the browser
(require 'sstorytime-browser (expand-file-name "sstorytime-browser"
                                               (file-name-directory
                                                (or load-file-name buffer-file-name))))

;;; Customization

(defgroup sstorytime nil
  "Interface to SSTorytime knowledge graphs."
  :group 'tools
  :prefix "sstorytime-")

(defcustom sstorytime-tools-path
  (let ((default-path "~/ghq/github.com/markburgess/SSTorytime/src"))
    (if (file-directory-p (expand-file-name default-path))
        (expand-file-name default-path)
      nil))
  "Path to SSTorytime tools directory.
This should point to the 'src' directory of your SSTorytime installation."
  :type '(choice (directory :tag "Tools directory")
                 (const :tag "Not configured" nil))
  :group 'sstorytime)

(defcustom sstorytime-server-url "http://localhost:8080"
  "URL of the SSTorytime HTTP server."
  :type 'string
  :group 'sstorytime)

(defcustom sstorytime-n4l-directory nil
  "Directory containing N4L files.
If set, allows jumping to N4L files when clicking on chapters."
  :type '(choice (directory :tag "N4L directory")
                 (const :tag "Not configured" nil))
  :group 'sstorytime)

(defcustom sstorytime-default-limit 20
  "Default number of results to fetch."
  :type 'integer
  :group 'sstorytime)

(defcustom sstorytime-db-name "sstoryline"
  "PostgreSQL database name."
  :type 'string
  :group 'sstorytime)

(defcustom sstorytime-db-user "sstoryline"
  "PostgreSQL database user."
  :type 'string
  :group 'sstorytime)

(defcustom sstorytime-db-password "sst_1234"
  "PostgreSQL database password."
  :type 'string
  :group 'sstorytime)

(defcustom sstorytime-db-host "localhost"
  "PostgreSQL database host."
  :type 'string
  :group 'sstorytime)

(defcustom sstorytime-db-port 5432
  "PostgreSQL database port."
  :type 'integer
  :group 'sstorytime)

;;; Faces

(defface sstorytime-node-face
  '((t :inherit font-lock-function-name-face :weight bold))
  "Face for node names."
  :group 'sstorytime)

(defface sstorytime-relation-face
  '((t :inherit font-lock-keyword-face :slant italic))
  "Face for relationship types."
  :group 'sstorytime)

(defface sstorytime-context-face
  '((t :inherit font-lock-comment-face))
  "Face for context tags."
  :group 'sstorytime)

(defface sstorytime-chapter-face
  '((t :inherit font-lock-type-face :weight bold))
  "Face for chapter names."
  :group 'sstorytime)

;;; Data Structures

(cl-defstruct sstorytime-node
  "A node in the knowledge graph."
  id name chapter context rank)

(cl-defstruct sstorytime-link
  "A relationship between nodes."
  from to relation inverse)

;;; Utility Functions

(defun sstorytime--call-tool (tool &rest args)
  "Call SSTorytime TOOL with ARGS and return output."
  (let* ((default-directory (expand-file-name sstorytime-tools-path))
         (tool-path (expand-file-name tool default-directory)))
    (unless (file-exists-p tool-path)
      (error "Tool not found: %s (looked in %s)" tool tool-path))
    (unless (file-executable-p tool-path)
      (error "Tool not executable: %s" tool-path))
    (with-temp-buffer
      (let ((exit-code (apply #'call-process
                              tool-path
                              nil (list t t) nil args)))
        (if (zerop exit-code)
            (buffer-string)
          (error "Tool %s failed (exit code %d):\n%s"
                 tool exit-code (buffer-string)))))))

(defun sstorytime--http-get (endpoint)
  "Make HTTP GET request to ENDPOINT and return parsed JSON."
  (let ((url (concat sstorytime-server-url endpoint)))
    (with-current-buffer (url-retrieve-synchronously url t)
      (goto-char (point-min))
      (re-search-forward "^$")
      (json-read))))

(defun sstorytime--format-node (node)
  "Format NODE for display."
  (propertize (sstorytime-node-name node)
              'face 'sstorytime-node-face
              'sstorytime-node node))

(defun sstorytime--format-relation (relation)
  "Format RELATION for display."
  (propertize (format "(%s)" relation)
              'face 'sstorytime-relation-face))

;;; Search Functions

(defun sstorytime-search (query)
  "Search for QUERY in the knowledge graph."
  (interactive "sSearch SSTorytime: ")
  (sstorytime-browse-search query))

(defun sstorytime-search-chapter (chapter)
  "Search for notes in CHAPTER."
  (interactive "sChapter name: ")
  (sstorytime-browse-search (format "chapter %s" chapter)))

(defun sstorytime-search-context (context)
  "Search for notes with CONTEXT."
  (interactive "sContext tags: ")
  (sstorytime-browse-search (format "context %s" context)))


;;; N4L File Support

(defvar sstorytime-n4l-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "C-c C-u") #'sstorytime-upload-buffer)
    (define-key map (kbd "C-c C-v") #'sstorytime-validate-buffer)
    (define-key map (kbd "C-c C-c") #'sstorytime-dispatch)
    (define-key map (kbd "C-c C-e") #'sstorytime-toggle-inline-errors)
    map)
  "Keymap for `sstorytime-n4l-mode'.")

(defvar sstorytime-n4l-font-lock-keywords
  `(("^\\s *\\(#\\|//\\).*$" . 'font-lock-comment-face)
    ("^-\\s *\\(.+\\)$" (1 'sstorytime-chapter-face))
    ("^::.*::" . 'sstorytime-context-face)
    ("(\\([^)]+\\))" (1 'sstorytime-relation-face))
    ("^@\\(\\w+\\)" (1 'font-lock-variable-name-face))
    ("\\$\\(\\w+\\(?:\\.\\w+\\)?\\)" (1 'font-lock-variable-name-face))
    ("^[A-Z][A-Z ]+[A-Z]$" . 'font-lock-warning-face))
  "Font lock keywords for N4L mode.")

;;; Background validation

(defvar-local sstorytime--validation-timer nil
  "Timer for background validation.")

(defvar-local sstorytime--validation-overlays nil
  "List of overlays for validation errors.")

(defvar-local sstorytime--inline-errors-visible nil
  "Whether to display error messages inline (vs just underlines with tooltips).")

(defcustom sstorytime-validation-delay 1.0
  "Delay in seconds before running background validation."
  :type 'number
  :group 'sstorytime)

(defcustom sstorytime-enable-background-validation t
  "Enable continuous background validation in N4L buffers."
  :type 'boolean
  :group 'sstorytime)

(defun sstorytime--clear-validation-overlays ()
  "Remove all validation error overlays."
  ;; Remove tracked overlays
  (mapc #'delete-overlay sstorytime--validation-overlays)
  (setq sstorytime--validation-overlays nil)
  ;; Also remove any orphaned overlays with error messages (safety cleanup)
  (dolist (ov (overlays-in (point-min) (point-max)))
    (when (overlay-get ov 'sstorytime-error-message)
      (delete-overlay ov))))

(defun sstorytime--parse-validation-errors (output)
  "Parse validation OUTPUT and return list of (LINE . MESSAGE) pairs."
  (let ((errors nil))
    (with-temp-buffer
      (insert output)
      (goto-char (point-min))
      ;; Match: "N4L /path/file MESSAGE at line N"
      (while (re-search-forward "N4L [^ ]+ \\(.*\\) at line \\([0-9]+\\)" nil t)
        (let ((message (match-string 1))
              (line (string-to-number (match-string 2))))
          (push (cons line message) errors))))
    (nreverse errors)))

(defun sstorytime--highlight-error (line message)
  "Add error overlay at LINE with MESSAGE.
Skip if LINE is the current line and also the last line (actively being edited)."
  (save-excursion
    (goto-char (point-min))
    (forward-line (1- line))
    (let* ((bol (line-beginning-position))
           (eol (line-end-position))
           (current-line (line-number-at-pos (point)))
           (last-line (line-number-at-pos (point-max)))
           (is-editing-last-line (and (= line current-line)
                                     (= line last-line))))
      ;; Skip error if we're actively editing the last line
      (unless is-editing-last-line
        (let ((ov (make-overlay bol eol)))
          ;; Always add underline and tooltip
          (overlay-put ov 'face '(:underline (:color "red" :style wave)))
          (overlay-put ov 'help-echo message)
          (overlay-put ov 'sstorytime-error t)
          (overlay-put ov 'sstorytime-error-message message)
          ;; Add fringe indicator
          (overlay-put ov 'before-string
                       (propertize "!" 'display '(left-fringe exclamation-mark error)))
          ;; Conditionally add inline message on line below
          (when sstorytime--inline-errors-visible
            (overlay-put ov 'after-string
                         (propertize (concat "\n  → " message)
                                    'face '(:foreground "red" :slant italic))))
          (push ov sstorytime--validation-overlays))))))

(defun sstorytime--run-validation ()
  "Run N4L validation on current buffer and highlight errors."
  (when (and sstorytime-enable-background-validation
             sstorytime-tools-path)
    (let* ((n4l-tool (expand-file-name "N4L" sstorytime-tools-path))
           (temp-file (make-temp-file "n4l-validate-" nil ".n4l"))
           (output nil))
      (unwind-protect
          (progn
            ;; Write buffer contents to temp file
            (write-region (point-min) (point-max) temp-file nil 'silent)
            ;; Run validation on temp file
            (setq output (with-temp-buffer
                          (call-process n4l-tool nil t nil "-v" temp-file)
                          (buffer-string)))
            ;; Clear old overlays
            (sstorytime--clear-validation-overlays)

            ;; Parse and highlight errors
            (let ((errors (sstorytime--parse-validation-errors output)))
              (dolist (error errors)
                (sstorytime--highlight-error (car error) (cdr error)))

              ;; Update mode line
              (if errors
                  (setq mode-name (format "N4L[%d]" (length errors)))
                (setq mode-name "N4L"))
              (force-mode-line-update)))
        ;; Clean up temp file
        (when (file-exists-p temp-file)
          (delete-file temp-file))))))

(defun sstorytime--schedule-validation ()
  "Schedule background validation after idle time."
  (when sstorytime--validation-timer
    (cancel-timer sstorytime--validation-timer))
  (setq sstorytime--validation-timer
        (run-with-idle-timer sstorytime-validation-delay nil
                            #'sstorytime--run-validation)))

(defun sstorytime-toggle-inline-errors ()
  "Toggle display of inline error messages.
When ON: Shows error text on a line below the error (LSP-style).
When OFF: Shows only subtle underline with tooltip on hover."
  (interactive)
  (setq sstorytime--inline-errors-visible (not sstorytime--inline-errors-visible))
  (dolist (ov sstorytime--validation-overlays)
    (let ((message (overlay-get ov 'sstorytime-error-message)))
      (if sstorytime--inline-errors-visible
          ;; Add inline message
          (overlay-put ov 'after-string
                       (propertize (concat "\n  → " message)
                                  'face '(:foreground "red" :slant italic)))
        ;; Remove inline message
        (overlay-put ov 'after-string nil))))
  (message "Inline error messages %s" (if sstorytime--inline-errors-visible "shown" "hidden")))

;;;###autoload
(define-derived-mode sstorytime-n4l-mode text-mode "N4L"
  "Major mode for editing N4L (Notes For Learning) files.

\\{sstorytime-n4l-mode-map}"
  :group 'sstorytime
  (setq-local comment-start "# ")
  (setq-local comment-start-skip "\\(#\\|//\\)\\s *")
  (setq font-lock-defaults '(sstorytime-n4l-font-lock-keywords))

  ;; Set up background validation
  (when sstorytime-enable-background-validation
    (add-hook 'after-change-functions
              (lambda (&rest _) (sstorytime--schedule-validation))
              nil t)
    ;; Run initial validation
    (sstorytime--schedule-validation)))

;;;###autoload
(add-to-list 'auto-mode-alist '("\\.n4l\\'" . sstorytime-n4l-mode))

(defun sstorytime-upload-buffer (&optional force)
  "Upload current buffer to SSTorytime database.
With prefix argument FORCE, use -force flag to overwrite existing data."
  (interactive "P")
  (unless (derived-mode-p 'sstorytime-n4l-mode)
    (user-error "Not in an N4L buffer"))
  ;; Save buffer if modified
  (when (buffer-modified-p)
    (if (y-or-n-p "Buffer has unsaved changes. Save before uploading? ")
        (save-buffer)
      (user-error "Upload cancelled - buffer not saved")))
  ;; Ensure buffer has a file
  (unless (buffer-file-name)
    (user-error "Buffer must be saved to a file before uploading"))
  (let* ((file (buffer-file-name))
         (args (if force
                   (list "-u" "-force" file)
                 (list "-u" file)))
         (output (apply #'sstorytime--call-tool "N4L" args)))
    (message "Uploaded %s%s:\n%s"
             file
             (if force " (forced)" "")
             output)))

(defun sstorytime-remove-buffer ()
  "Remove current buffer's data from SSTorytime database (wipe).
This removes all nodes and links from this file's chapter."
  (interactive)
  (unless (derived-mode-p 'sstorytime-n4l-mode)
    (user-error "Not in an N4L buffer"))
  (let ((file (buffer-file-name)))
    (when (yes-or-no-p (format "Remove all data from %s? This cannot be undone! " file))
      (let ((output (sstorytime--call-tool "N4L" "-wipe" file)))
        (message "Removed data from %s:\n%s" file output)))))

(defun sstorytime-remove-chapter (chapter)
  "Remove all data for CHAPTER from the database.
This removes all nodes and links associated with the chapter name."
  (interactive "sChapter name to remove: ")
  (when (yes-or-no-p (format "Remove all data from chapter '%s'? This cannot be undone! " chapter))
    (let ((output (sstorytime--call-tool "removeN4L" "-force" chapter)))
      (message "Removed chapter '%s':\n%s" chapter output))))

(defun sstorytime-reupload-buffer ()
  "Remove and re-upload current buffer (wipe + upload).
This completely replaces the chapter's data."
  (interactive)
  (unless (derived-mode-p 'sstorytime-n4l-mode)
    (user-error "Not in an N4L buffer"))
  (let ((file (buffer-file-name)))
    (when (yes-or-no-p (format "Remove and re-upload %s? " file))
      (sstorytime-remove-buffer)
      (sit-for 0.5)  ; Brief pause to ensure wipe completes
      (sstorytime-upload-buffer t))))

(defun sstorytime-validate-buffer ()
  "Validate current N4L buffer."
  (interactive)
  (unless (derived-mode-p 'sstorytime-n4l-mode)
    (user-error "Not in an N4L buffer"))
  (let* ((file (buffer-file-name))
         (output (sstorytime--call-tool "N4L" "-v" file)))
    (with-current-buffer (get-buffer-create "*SSTorytime Validation*")
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert output)
        (compilation-mode))
      (pop-to-buffer (current-buffer)))))

;;; Transient Menus

(transient-define-prefix sstorytime-dispatch ()
  "Main SSTorytime command menu."
  ["Search"
   ("s" "Search" sstorytime-search)
   ("c" "By Chapter" sstorytime-search-chapter)
   ("C" "By Context" sstorytime-search-context)
   ("f" "From Node" sstorytime-search-from)
   ("t" "To Node" sstorytime-search-to)]
  ["Browse"
   ("b" "Browse Results" sstorytime-browse)
   ("n" "Show Node" sstorytime-goto-node)
   ("p" "Find Path" sstorytime-find-path)]
  ["Edit"
   ("e" "New N4L File" sstorytime-new-file)
   ("o" "Open N4L File" sstorytime-open-file)
   ("u" "Upload Buffer" sstorytime-upload-buffer)
   ("U" "Upload (Force)" (lambda () (interactive) (sstorytime-upload-buffer t)))
   ("r" "Re-upload (Wipe+Upload)" sstorytime-reupload-buffer)
   ("w" "Wipe/Remove Buffer" sstorytime-remove-buffer)
   ("W" "Remove Chapter by Name" sstorytime-remove-chapter)
   ("v" "Validate Buffer" sstorytime-validate-buffer)]
  ["Tools"
   ("S" "Start Server" sstorytime-start-server)
   ("K" "Stop Server" sstorytime-stop-server)
   ("R" "Rebuild Tools" sstorytime-rebuild-tools)])

(defun sstorytime-search-from (node)
  "Search from NODE."
  (interactive "sFrom node: ")
  (sstorytime-browse-search (format "from %s" node)))

(defun sstorytime-search-to (node)
  "Search to NODE."
  (interactive "sTo node: ")
  (sstorytime-browse-search (format "to %s" node)))

(defun sstorytime-find-path (from to)
  "Find path FROM one node TO another."
  (interactive "sFrom: \nsTo: ")
  (sstorytime-browse-search (format "from %s to %s" from to)))

(defun sstorytime-new-file (name)
  "Create a new N4L file with NAME."
  (interactive "sFile name (without .n4l): ")
  (let ((file (expand-file-name (concat name ".n4l"))))
    (find-file file)
    (when (zerop (buffer-size))
      (insert (format "- %s\n\n:: notes ::\n\n" name))
      (save-buffer))))

(defun sstorytime-open-file ()
  "Open an N4L file."
  (interactive)
  (let ((default-directory (expand-file-name "examples"
                                            (file-name-directory sstorytime-tools-path))))
    (call-interactively #'find-file)))

(defun sstorytime-browse ()
  "Browse the knowledge graph."
  (interactive)
  (sstorytime-browse-search "any"))

(defun sstorytime-goto-node (node)
  "Go to NODE."
  (interactive "sNode name: ")
  (sstorytime-browse-search node))

(defvar sstorytime--server-process nil
  "The running HTTP server process.")

(defun sstorytime-start-server ()
  "Start the SSTorytime HTTP server."
  (interactive)
  (when (and sstorytime--server-process
             (process-live-p sstorytime--server-process))
    (user-error "Server already running"))
  (let ((default-directory sstorytime-tools-path))
    (setq sstorytime--server-process
          (start-process "sstorytime-server" "*SSTorytime Server*"
                        "./http_server"))
    (message "SSTorytime server started on %s" sstorytime-server-url)))

(defun sstorytime-stop-server ()
  "Stop the SSTorytime HTTP server."
  (interactive)
  (when (and sstorytime--server-process
             (process-live-p sstorytime--server-process))
    (kill-process sstorytime--server-process)
    (setq sstorytime--server-process nil)
    (message "SSTorytime server stopped")))

(defun sstorytime-rebuild-tools ()
  "Rebuild SSTorytime tools."
  (interactive)
  (let ((default-directory sstorytime-tools-path))
    (async-shell-command "make" "*SSTorytime Build*")))

;;; Setup and Diagnostics

(defun sstorytime-check-setup ()
  "Check if SSTorytime is properly configured."
  (interactive)
  (let ((issues nil))
    (unless sstorytime-tools-path
      (push "sstorytime-tools-path is not set" issues))
    (when sstorytime-tools-path
      (unless (file-directory-p sstorytime-tools-path)
        (push (format "Tools directory does not exist: %s" sstorytime-tools-path) issues))
      (when (file-directory-p sstorytime-tools-path)
        (dolist (tool '("N4L" "searchN4L" "notes" "pathsolve"))
          (let ((tool-path (expand-file-name tool sstorytime-tools-path)))
            (unless (file-exists-p tool-path)
              (push (format "Tool not found: %s" tool) issues))
            (when (file-exists-p tool-path)
              (unless (file-executable-p tool-path)
                (push (format "Tool not executable: %s" tool) issues)))))))
    (if issues
        (message "SSTorytime setup issues:\n%s"
                 (mapconcat #'identity issues "\n"))
      (message "SSTorytime setup looks good!
Tools: %s
Server: %s"
               sstorytime-tools-path
               sstorytime-server-url))))

;;;###autoload
(defun sstorytime-configure ()
  "Interactively configure SSTorytime paths."
  (interactive)
  (let ((tools-path (read-directory-name
                     "SSTorytime tools directory (src/): "
                     (or sstorytime-tools-path
                         "~/ghq/github.com/markburgess/SSTorytime/src"))))
    (customize-save-variable 'sstorytime-tools-path tools-path)
    (sstorytime-check-setup)))

;;; Interactive Entry Point

;;;###autoload
(defun sstorytime ()
  "Start SSTorytime interface."
  (interactive)
  (if (and sstorytime-tools-path
           (file-directory-p sstorytime-tools-path))
      (sstorytime-dispatch)
    (when (yes-or-no-p "SSTorytime not configured. Configure now? ")
      (sstorytime-configure))))

(provide 'sstorytime)
;;; sstorytime.el ends here
