;;; n4live.el --- Interactive N4L composition mode -*- lexical-binding: t; -*-

;; Copyright (C) 2025

;; Author: SSTorytime Contributors
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1") (magit-section "3.3.0") (transient "0.3.0"))
;; Keywords: tools, knowledge-management
;; URL: https://github.com/markburgess/SSTorytime

;;; Commentary:

;; n4live-mode provides an interactive, append-focused interface for
;; composing N4L notes without manual indentation or symbol entry.
;;
;; Workflow:
;; 1. Type node text → RET
;; 2. Select arrow with typeahead → RET
;; 3. Type target text → RET
;; 4. Repeat
;;
;; Export to .n4l format when done.

;;; Code:

(require 'magit-section)
(require 'transient)

;;; Data structures

(defvar-local n4live--chapter nil
  "Current chapter name.")

(defvar-local n4live--context nil
  "Current context tags (list of strings).")

(defvar-local n4live--nodes nil
  "List of nodes in current document.
Each node is a plist with :text and :relations.
Relations is a list of (:arrow arrow :target target).")

(defvar-local n4live--current-node nil
  "Currently selected node for adding relations.")

(defvar-local n4live--arrow-history nil
  "History of recently used arrows, most recent first.")

(defvar-local n4live--input-mode nil
  "Current input mode: nil, 'node, 'arrow, or 'target.")

(defvar-local n4live--pending-arrow nil
  "Arrow selected, waiting for target.")

;;; Arrow database (loaded from SSTorytime config)

(defvar n4live--arrows-by-type
  '((0 . (;; similarity
          ("sim" . "similar to")
          ("=" . "same as")
          ("eq" . "equals")
          ("see" . "see also")
          ("alias" . "also called")))
    (1 . (;; leadsto
          ("fwd" . "leads to")
          ("next" . "next is")
          ("cause" . "causes")
          ("uses" . "is used by")
          ("enables" . "enables")
          ("result" . "results in")))
    (2 . (;; contains
          ("contain" . "contains")
          ("consists" . "consists of")
          ("has-cmpt" . "has component")
          ("has-pt" . "has a part")
          ("includes" . "includes")))
    (3 . (;; properties
          ("def" . "defined as")
          ("note" . "note/remark")
          ("e.g." . "has example")
          ("descr" . "described as")
          ("feat" . "has feature")
          ("propt" . "has property")
          ("intention" . "has purpose or intent")
          ("affinity" . "has preference for"))))
  "Arrow definitions by STtype.
Alist of (STTYPE . ((SHORT . LONG) ...)).")

(defun n4live--all-arrows ()
  "Return flat list of all (SHORT . LONG) arrow pairs."
  (apply #'append (mapcar #'cdr n4live--arrows-by-type)))

(defun n4live--arrow-display (arrow)
  "Return display string for ARROW short form."
  (let ((long (cdr (assoc arrow (n4live--all-arrows)))))
    (if long
        (format "(%s) %s" arrow long)
      (format "(%s)" arrow))))

;;; Node management

(defun n4live--add-node (text)
  "Add a new node with TEXT."
  (let ((node (list :text text :relations nil)))
    (push node n4live--nodes)
    (setq n4live--current-node node)
    node))

(defun n4live--add-relation (node arrow target)
  "Add relation to NODE with ARROW pointing to TARGET."
  (let ((relation (list :arrow arrow :target target)))
    (setf (plist-get node :relations)
          (append (plist-get node :relations) (list relation)))
    ;; Update arrow history
    (setq n4live--arrow-history
          (cons arrow (remove arrow n4live--arrow-history)))
    ;; Keep only last 10
    (when (> (length n4live--arrow-history) 10)
      (setq n4live--arrow-history
            (seq-take n4live--arrow-history 10)))))

;;; Input handling

(defun n4live--read-arrow ()
  "Read arrow with typeahead completion, recent arrows first."
  (let* ((all-arrows (n4live--all-arrows))
         (recent-arrows (mapcar (lambda (a) (cons a (cdr (assoc a all-arrows))))
                                (seq-filter (lambda (a) (assoc a all-arrows))
                                           n4live--arrow-history)))
         (other-arrows (seq-filter (lambda (pair)
                                    (not (member (car pair) n4live--arrow-history)))
                                  all-arrows))
         (candidates (append recent-arrows other-arrows))
         (completion-extra-properties
          '(:annotation-function
            (lambda (key)
              (let ((long (cdr (assoc key (n4live--all-arrows)))))
                (if long (concat " — " long) ""))))))
    (completing-read "Arrow: " (mapcar #'car candidates) nil nil)))

(defun n4live--get-input ()
  "Extract input text from the input field."
  (save-excursion
    (goto-char (point-max))
    (let ((end (point)))
      (beginning-of-line)
      ;; Skip past the prompt
      (when (re-search-forward "^\\(?:Node\\|Arrow\\|→\\):?[[:space:]]*" end t)
        (string-trim (buffer-substring-no-properties (point) end))))))

(defun n4live-append-input ()
  "Handle input in append area."
  (interactive)
  (let ((input (n4live--get-input)))
    (cond
     ;; Reading node text
     ((or (null n4live--input-mode) (eq n4live--input-mode 'node))
      (if (string-empty-p input)
          (message "Please enter node text")
        (n4live--add-node input)
        (setq n4live--input-mode 'arrow)
        (n4live--refresh)))

     ;; Reading arrow - show completion
     ((eq n4live--input-mode 'arrow)
      (let ((arrow (n4live--read-arrow)))
        (setq n4live--pending-arrow arrow)
        (setq n4live--input-mode 'target)
        (n4live--refresh)))

     ;; Reading target
     ((eq n4live--input-mode 'target)
      (if (string-empty-p input)
          (message "Please enter target text")
        (n4live--add-relation n4live--current-node
                             n4live--pending-arrow
                             input)
        (setq n4live--pending-arrow nil)
        (setq n4live--input-mode 'arrow)
        (n4live--refresh))))))

(defun n4live-new-node ()
  "Start adding a new node."
  (interactive)
  (setq n4live--input-mode 'node)
  (n4live--refresh)
  (goto-char (point-max))
  (insert (propertize "Node: " 'face 'bold)))

;;; Display

(defun n4live--refresh ()
  "Refresh the n4live buffer display."
  (interactive)
  (let ((inhibit-read-only t)
        (input-start nil))
    (erase-buffer)

    ;; Header
    (insert (propertize (format "Chapter: %s\n" (or n4live--chapter "(none)"))
                       'face '(:weight bold :height 1.2)))
    (when n4live--context
      (insert (propertize (format "Context: %s\n"
                                 (string-join n4live--context ", "))
                         'face 'font-lock-comment-face)))
    (insert "\n")

    ;; Nodes (in reverse order - most recent first)
    (dolist (node (reverse n4live--nodes))
      (insert (propertize (format "• %s\n" (plist-get node :text))
                         'face '(:weight bold :foreground "dark blue")))

      ;; Relations
      (dolist (rel (plist-get node :relations))
        (insert (propertize (format "  (%s) → %s\n"
                                   (plist-get rel :arrow)
                                   (plist-get rel :target))
                           'face 'font-lock-keyword-face)))
      (insert "\n"))

    ;; Input area separator
    (insert (propertize "─────────────────────────────────\n"
                       'face 'font-lock-comment-face))

    (setq input-start (point))

    ;; Input prompt based on mode
    (cond
     ((or (null n4live--input-mode) (eq n4live--input-mode 'node))
      (insert (propertize "Node: " 'face '(:weight bold :foreground "dark green"))))
     ((eq n4live--input-mode 'arrow)
      (insert (propertize "  Arrow (RET for menu, C-c C-n for new node): "
                         'face '(:weight bold :foreground "dark blue"))))
     ((eq n4live--input-mode 'target)
      (insert (propertize (format "  (%s) → " n4live--pending-arrow)
                         'face '(:weight bold :foreground "dark orange")))))

    ;; Make everything after the prompt editable
    (put-text-property (point-min) input-start 'read-only t)
    (put-text-property (point-min) input-start 'rear-nonsticky t)

    (goto-char (point-max))))

;;; Export to N4L

(defun n4live--export-to-n4l ()
  "Export current document to N4L format."
  (with-temp-buffer
    (when n4live--chapter
      (insert (format "- %s\n\n" n4live--chapter)))

    (when n4live--context
      (insert (format ":: %s ::\n\n" (string-join n4live--context ", "))))

    ;; Nodes in original order (reverse of display)
    (dolist (node (reverse n4live--nodes))
      (let* ((text (plist-get node :text))
             (relations (plist-get node :relations))
             (first-rel (car relations))
             (rest-rels (cdr relations)))

        ;; First line with first relation
        (if first-rel
            (insert (format "%s (%s) %s\n"
                           text
                           (plist-get first-rel :arrow)
                           (plist-get first-rel :target)))
          (insert (format "%s\n" text)))

        ;; Continuation lines for additional relations
        (dolist (rel rest-rels)
          (insert (format "    \"      (%s) %s\n"
                         (plist-get rel :arrow)
                         (plist-get rel :target))))

        (insert "\n")))

    (buffer-string)))

(defun n4live-export-to-file (filename)
  "Export current document to N4L FILENAME."
  (interactive "FExport to N4L file: ")
  (let ((content (n4live--export-to-n4l)))
    (with-temp-file filename
      (insert content))
    (message "Exported to %s" filename)))

(defun n4live-preview-n4l ()
  "Show N4L export preview in other window."
  (interactive)
  (let ((content (n4live--export-to-n4l)))
    (with-current-buffer (get-buffer-create "*N4L Preview*")
      (erase-buffer)
      (insert content)
      (sstorytime-n4l-mode)
      (display-buffer (current-buffer)))))

;;; Transient menu

(transient-define-prefix n4live-dispatch ()
  "N4Live command menu."
  ["N4Live"
   ["Document"
    ("c" "Set chapter" n4live-set-chapter)
    ("x" "Set context" n4live-set-context)]
   ["Edit"
    ("n" "New node" n4live-new-node)
    ("d" "Delete last" n4live-delete-last)
    ("u" "Undo" undo)]
   ["Export"
    ("p" "Preview N4L" n4live-preview-n4l)
    ("e" "Export to file" n4live-export-to-file)
    ("v" "Validate" n4live-validate)]
   ["Other"
    ("g" "Refresh" n4live--refresh)
    ("q" "Quit" quit-window)]])

(defun n4live-set-chapter (chapter)
  "Set the CHAPTER name."
  (interactive "sChapter name: ")
  (setq n4live--chapter chapter)
  (n4live--refresh))

(defun n4live-set-context (context-string)
  "Set the CONTEXT-STRING (comma-separated tags)."
  (interactive "sContext tags (comma-separated): ")
  (setq n4live--context
        (mapcar #'string-trim (split-string context-string ",")))
  (n4live--refresh))

(defun n4live-delete-last ()
  "Delete the last item added."
  (interactive)
  (cond
   ((and n4live--current-node
         (plist-get n4live--current-node :relations))
    ;; Delete last relation
    (let ((rels (plist-get n4live--current-node :relations)))
      (setf (plist-get n4live--current-node :relations)
            (butlast rels))
      (message "Deleted last relation")))
   (n4live--nodes
    ;; Delete last node
    (pop n4live--nodes)
    (setq n4live--current-node (car n4live--nodes))
    (message "Deleted last node")))
  (n4live--refresh))

(defun n4live-validate ()
  "Validate current document by exporting and running N4L validator."
  (interactive)
  (let* ((temp-file (make-temp-file "n4live-validate-" nil ".n4l"))
         (content (n4live--export-to-n4l)))
    (with-temp-file temp-file
      (insert content))
    (let ((output (shell-command-to-string
                   (format "%s/N4L -v %s 2>&1"
                          (or sstorytime-tools-path
                              (expand-file-name "~/ghq/github.com/markburgess/SSTorytime/src"))
                          temp-file))))
      (with-current-buffer (get-buffer-create "*N4L Validation*")
        (erase-buffer)
        (insert output)
        (goto-char (point-min))
        (display-buffer (current-buffer)))
      (delete-file temp-file))))

;;; Major mode

(defvar n4live-mode-map
  (let ((map (make-sparse-keymap)))
    ;; Don't set a parent - we want clean keybindings
    ;; self-insert-command will work by default in text-mode

    ;; Our custom keys
    (define-key map (kbd "RET") #'n4live-append-input)
    (define-key map (kbd "C-c C-c") #'n4live-dispatch)
    (define-key map (kbd "C-c C-n") #'n4live-new-node)
    (define-key map (kbd "C-c C-p") #'n4live-preview-n4l)
    (define-key map (kbd "C-c C-e") #'n4live-export-to-file)
    (define-key map (kbd "C-c C-v") #'n4live-validate)
    (define-key map (kbd "C-c C-d") #'n4live-delete-last)
    map)
  "Keymap for n4live-mode.")

(define-derived-mode n4live-mode text-mode "N4Live"
  "Major mode for interactive N4L composition.

Workflow:
  1. Set chapter and context with C-c C-c
  2. Type node text, press RET
  3. Select arrow with completion, press RET
  4. Type target text, press RET
  5. Repeat step 3-4 to add more relations, or press C-c C-n for new node
  6. Preview with C-c C-p, export with C-c C-e

\\{n4live-mode-map}"
  (setq-local n4live--chapter nil)
  (setq-local n4live--context nil)
  (setq-local n4live--nodes nil)
  (setq-local n4live--current-node nil)
  (setq-local n4live--arrow-history nil)
  (setq-local n4live--input-mode 'node)
  ;; Allow editing with inhibit-read-only locally
  (setq-local inhibit-read-only t)
  (n4live--refresh))

;;;###autoload
(defun n4live ()
  "Start a new N4Live composition buffer."
  (interactive)
  (let ((buf (generate-new-buffer "*N4Live*")))
    (with-current-buffer buf
      (n4live-mode))
    (switch-to-buffer buf)))

(provide 'n4live)
;;; n4live.el ends here
