;;; elisp-dev-tools.el --- Batch-mode Elisp development tools -*- lexical-binding: t; -*-

;; Adapted from elisp-dev-mcp for use in batch mode with Claude Code
;; Original: https://github.com/laurynas-biveinis/elisp-dev-mcp

;;; Commentary:

;; This provides the same functionality as elisp-dev-mcp but runs in batch mode
;; so Claude Code can use it without needing the full MCP server infrastructure.
;;
;; Usage:
;;   emacs --batch -l elisp-dev-tools.el --eval '(elisp-dev-describe-function "car")'

;;; Code:

(require 'help-fns)
(require 'pp)
(require 'info-look)
(require 'json)

;;; Describe Function

(defun elisp-dev-describe-function (function-name)
  "Get full documentation for FUNCTION-NAME.
Returns JSON with description or error."
  (let ((sym (intern-soft function-name)))
    (if (and sym (fboundp sym))
        (let ((doc (documentation sym t)))
          (princ (json-encode
                  `((function . ,function-name)
                    (description . ,(or doc "No documentation available."))))))
      (princ (json-encode
              `((error . ,(format "Function '%s' not found" function-name))))))))

;;; Get Function Definition

(defun elisp-dev--find-function-file (sym)
  "Find the file where SYM is defined.
Returns cons of (FILE . BUFFER) or nil."
  (condition-case nil
      (let* ((fn (symbol-function sym))
             (file (find-lisp-object-file-name sym fn)))
        (when file
          (cons file (find-file-noselect file))))
    (error nil)))

(defun elisp-dev--extract-function-source (sym buffer)
  "Extract source code for SYM from BUFFER.
Returns (SOURCE START-LINE END-LINE) or nil."
  (with-current-buffer buffer
    (save-excursion
      (goto-char (point-min))
      (when (re-search-forward
             (format "^(\\s-*def[^ \t\n]* +%s\\b" (regexp-quote (symbol-name sym)))
             nil t)
        (let ((start (save-excursion
                       (beginning-of-line)
                       ;; Look for header comments
                       (while (and (not (bobp))
                                   (save-excursion
                                     (forward-line -1)
                                     (looking-at "^\\s-*;;")))
                         (forward-line -1))
                       (point)))
              end)
          (goto-char (match-beginning 0))
          (forward-sexp)
          (setq end (point))
          (list (buffer-substring-no-properties start end)
                (line-number-at-pos start)
                (line-number-at-pos end)))))))

(defun elisp-dev-get-function-definition (function-name)
  "Get source code definition for FUNCTION-NAME.
Returns JSON with source, file-path, start-line, end-line or error."
  (let ((sym (intern-soft function-name)))
    (if (not (and sym (fboundp sym)))
        (princ (json-encode
                `((error . ,(format "Function '%s' not found" function-name)))))
      (if (subrp (symbol-function sym))
          (princ (json-encode
                  `((is-c-function . t)
                    (function-name . ,function-name)
                    (message . "Function is implemented in C source code"))))
        (let ((file-info (elisp-dev--find-function-file sym)))
          (if (not file-info)
              (princ (json-encode
                      `((error . ,(format "Could not find source file for '%s'" function-name)))))
            (let* ((file (car file-info))
                   (buffer (cdr file-info))
                   (source-info (elisp-dev--extract-function-source sym buffer)))
              (if (not source-info)
                  (princ (json-encode
                          `((error . ,(format "Could not extract source for '%s'" function-name)))))
                (princ (json-encode
                        `((source . ,(nth 0 source-info))
                          (file-path . ,file)
                          (start-line . ,(nth 1 source-info))
                          (end-line . ,(nth 2 source-info)))))))))))))

;;; Describe Variable

(defun elisp-dev-describe-variable (variable-name)
  "Get information about VARIABLE-NAME without exposing its value.
Returns JSON with variable properties."
  (let ((sym (intern-soft variable-name)))
    (if (not sym)
        (princ (json-encode
                `((error . ,(format "Variable '%s' not found" variable-name)))))
      (let* ((bound (boundp sym))
             (value (when bound (symbol-value sym)))
             (type (when bound (type-of value)))
             (doc (documentation-property sym 'variable-documentation t))
             (file (find-lisp-object-file-name sym 'defvar))
             (custom-type (get sym 'custom-type))
             (custom-group (get sym 'custom-group))
             (obsolete (get sym 'byte-obsolete-variable))
             (alias (indirect-variable sym)))
        (princ (json-encode
                `((name . ,variable-name)
                  (bound . ,(if bound t :json-false))
                  (value-type . ,(when bound (symbol-name type)))
                  (documentation . ,doc)
                  (source-file . ,file)
                  (is-custom . ,(if custom-type t :json-false))
                  ,@(when custom-group `((custom-group . ,(symbol-name (car custom-group)))))
                  ,@(when custom-type `((custom-type . ,(prin1-to-string custom-type))))
                  (is-obsolete . ,(if obsolete t :json-false))
                  ,@(when obsolete `((obsolete-since . ,(car obsolete))
                                     (obsolete-replacement . ,(cadr obsolete))))
                  (is-alias . ,(if (not (eq alias sym)) t :json-false))
                  ,@(when (not (eq alias sym))
                      `((alias-target . ,(symbol-name alias))))
                  (is-special . ,(if (special-variable-p sym) t :json-false)))))))))

;;; Info Lookup

(defun elisp-dev-info-lookup-symbol (symbol-name)
  "Look up SYMBOL-NAME in Info documentation.
Returns JSON with node content if found."
  (let ((sym (intern-soft symbol-name)))
    (if (not sym)
        (princ (json-encode
                `((found . :json-false)
                  (symbol . ,symbol-name)
                  (message . "Symbol not found"))))
      (condition-case err
          (progn
            (info-lookup-symbol sym 'emacs-lisp-mode)
            (let* ((node (Info-copy-current-node-name))
                   (content (buffer-substring-no-properties
                             (point-min) (point-max))))
              (princ (json-encode
                      `((found . t)
                        (symbol . ,symbol-name)
                        (node . ,node)
                        (manual . "elisp")
                        (content . ,content)
                        (info-ref . ,(format "(elisp)%s" node)))))))
        (error
         (princ (json-encode
                 `((found . :json-false)
                   (symbol . ,symbol-name)
                   (message . ,(format "No Info documentation found: %s"
                                      (error-message-string err)))))))))))

;;; Read Source File

(defvar elisp-dev--system-lisp-dir
  (let* ((data-parent
          (file-name-directory (directory-file-name data-directory)))
         (lisp-dir (expand-file-name "lisp/" data-parent)))
    (when (file-directory-p lisp-dir)
      lisp-dir))
  "System Lisp directory for Emacs installation.")

(defvar elisp-dev--allowed-dirs
  (list elisp-dev--system-lisp-dir
        (expand-file-name "~/.emacs.d/elpa/"))
  "Directories allowed for source file reading.")

(defun elisp-dev--path-allowed-p (path)
  "Check if PATH is in an allowed directory."
  (and (file-name-absolute-p path)
       (not (string-match-p "\\.\\." path))
       (let ((real-path (file-truename path)))
         (seq-some (lambda (dir)
                     (and dir (string-prefix-p (file-truename dir) real-path)))
                   elisp-dev--allowed-dirs))))

(defun elisp-dev-read-source-file (file-path)
  "Read Elisp source file at FILE-PATH.
Returns file contents as JSON or error."
  (if (not (elisp-dev--path-allowed-p file-path))
      (princ (json-encode
              `((error . ,(format "Access denied: %s not in allowed directories" file-path)))))
    (if (not (file-exists-p file-path))
        (princ (json-encode
                `((error . ,(format "File not found: %s" file-path)))))
      (condition-case err
          (with-temp-buffer
            (insert-file-contents file-path)
            (princ (json-encode
                    `((content . ,(buffer-string))
                      (file-path . ,file-path)))))
        (error
         (princ (json-encode
                 `((error . ,(format "Failed to read file: %s"
                                    (error-message-string err)))))))))))

;;; Batch Mode Entry Points

(defun elisp-dev-tools-run-command (command &rest args)
  "Run COMMAND with ARGS and output JSON result."
  (pcase command
    ("describe-function"
     (elisp-dev-describe-function (car args)))
    ("get-function-definition"
     (elisp-dev-get-function-definition (car args)))
    ("describe-variable"
     (elisp-dev-describe-variable (car args)))
    ("info-lookup"
     (elisp-dev-info-lookup-symbol (car args)))
    ("read-file"
     (elisp-dev-read-source-file (car args)))
    (_
     (princ (json-encode
             `((error . ,(format "Unknown command: %s" command))))))))

(provide 'elisp-dev-tools)
;;; elisp-dev-tools.el ends here
