;;; n4live-smart.el --- Smart editing helpers for N4L files -*- lexical-binding: t; -*-

;; Copyright (C) 2025

;; Author: SSTorytime Contributors
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1"))
;; Keywords: tools, knowledge-management
;; URL: https://github.com/markburgess/SSTorytime

;;; Commentary:

;; Smart editing mode for N4L files, inspired by parinfer.
;; Provides intelligent indentation, arrow completion, and quick appending.
;;
;; Features:
;; - TAB: Add continuation line with proper indentation + completion
;; - (: Trigger arrow completion
;; - RET: Smart newline (continue node or start new)
;; - Normal N4L file appearance
;; - Works with company-mode, corfu, or built-in completion

;;; Code:

(require 'company nil t)

;;; Arrow database (same as n4live)

(defvar n4live-smart--arrows-by-type
  '((0 . (;; similarity (nr)
          ("sim" . "similar to")
          ("=" . "same as")
          ("eq" . "equals")
          ("see" . "see also")
          ("alias" . "also called")))
    (1 . (;; leadsto (lt)
          ("fwd" . "leads to")
          ("next" . "next is")
          ("cause" . "causes")
          ("uses" . "is used by")
          ("enables" . "enables")
          ("result" . "results in")
          ("runs" . "runs or executes")
          ("handles" . "handles")))
    (2 . (;; contains (cn)
          ("contain" . "contains")
          ("consists" . "consists of")
          ("has-cmpt" . "has component")
          ("has-pt" . "has a part")
          ("includes" . "includes")))
    (3 . (;; properties (ep)
          ("def" . "defined as")
          ("note" . "note/remark")
          ("e.g." . "has example")
          ("descr" . "described as")
          ("feat" . "has feature")
          ("propt" . "has property")
          ("intention" . "has purpose or intent")
          ("affinity" . "has preference for")
          ("provider" . "has service provider")
          ("ref" . "refers to")
          ("use-for" . "used for")
          ("solution" . "potential solution")
          ("problem" . "key problem"))))
  "Arrow definitions by STtype.")

(defvar n4live-smart--sttype-labels
  '((0 . "nr")
    (1 . "lt")
    (2 . "cn")
    (3 . "ep"))
  "Short labels for STtypes.")

(defvar-local n4live-smart--arrow-history nil
  "Recently used arrows, most recent first.")

(defun n4live-smart--all-arrows ()
  "Return flat list of all (SHORT . LONG) arrow pairs."
  (apply #'append (mapcar #'cdr n4live-smart--arrows-by-type)))

(defun n4live-smart--get-arrow-sttype (arrow)
  "Return STtype number for ARROW, or nil if not found."
  (catch 'found
    (dolist (type-pair n4live-smart--arrows-by-type)
      (let ((sttype (car type-pair))
            (arrows (cdr type-pair)))
        (when (assoc arrow arrows)
          (throw 'found sttype))))))

(defun n4live-smart--read-arrow ()
  "Read arrow with completion, recent arrows first."
  (let* ((all-arrows (n4live-smart--all-arrows))
         (recent-arrows (mapcar (lambda (a) (cons a (cdr (assoc a all-arrows))))
                                (seq-filter (lambda (a) (assoc a all-arrows))
                                           n4live-smart--arrow-history)))
         (other-arrows (seq-filter (lambda (pair)
                                    (not (member (car pair) n4live-smart--arrow-history)))
                                  all-arrows))
         (candidates (append recent-arrows other-arrows))
         (completion-extra-properties
          '(:annotation-function
            (lambda (key)
              (let ((long (cdr (assoc key (n4live-smart--all-arrows)))))
                (if long (concat " — " long) "")))))
         (arrow (completing-read "Arrow: " (mapcar #'car candidates) nil nil)))
    ;; Update history
    (setq n4live-smart--arrow-history
          (cons arrow (remove arrow n4live-smart--arrow-history)))
    (when (> (length n4live-smart--arrow-history) 20)
      (setq n4live-smart--arrow-history
            (seq-take n4live-smart--arrow-history 20)))
    arrow))

;;; Company backend for arrow completion

(defun company-n4live-arrows (command &optional arg &rest ignored)
  "Company backend for N4L arrow completion."
  (interactive (list 'interactive))
  (pcase command
    ('interactive (company-begin-backend 'company-n4live-arrows))
    ('prefix
     (when (and (eq major-mode 'sstorytime-n4l-mode)
                n4live-smart-mode
                (looking-back "(\\([a-z-]*\\)" (line-beginning-position)))
       (match-string 1)))
    ('candidates
     (let* ((all-arrows (n4live-smart--all-arrows))
            ;; Prioritize recent arrows
            (recent-arrows (seq-filter (lambda (a) (assoc a all-arrows))
                                       n4live-smart--arrow-history))
            (other-arrows (mapcar #'car
                                 (seq-filter (lambda (pair)
                                              (not (member (car pair) n4live-smart--arrow-history)))
                                            all-arrows)))
            (all-candidates (append recent-arrows other-arrows)))
       (seq-filter (lambda (c) (string-prefix-p arg c)) all-candidates)))
    ('annotation
     (let* ((long (cdr (assoc arg (n4live-smart--all-arrows))))
            (sttype (n4live-smart--get-arrow-sttype arg))
            (label (cdr (assoc sttype n4live-smart--sttype-labels))))
       (if (and long label)
           (format " — %s | %s" long label)
         (format " — %s" (or long "")))))
    ('post-completion
     ;; Update history
     (setq n4live-smart--arrow-history
           (cons arg (remove arg n4live-smart--arrow-history)))
     (when (> (length n4live-smart--arrow-history) 20)
       (setq n4live-smart--arrow-history
             (seq-take n4live-smart--arrow-history 20)))
     ;; Insert closing paren and space
     (insert ") "))
    ('sorted t)
    ('duplicates nil)))

;;; Smart editing commands

(defun n4live-smart--on-continuation-line-p ()
  "Return t if point is on a continuation line (starts with quote)."
  (save-excursion
    (beginning-of-line)
    (looking-at "^[[:space:]]*\"[[:space:]]*")))

(defun n4live-smart--get-continuation-indent ()
  "Get the indentation string for continuation lines.
Returns the whitespace + quote + whitespace pattern from current line."
  (save-excursion
    (beginning-of-line)
    (when (re-search-forward "^\\([[:space:]]*\"[[:space:]]*\\)" (line-end-position) t)
      (match-string 1))))

(defun n4live-smart-tab ()
  "Smart TAB: Add continuation line with proper indentation and trigger completion."
  (interactive)
  (cond
   ;; If we're on a continuation line, add another one
   ((n4live-smart--on-continuation-line-p)
    (let ((indent (or (n4live-smart--get-continuation-indent) "    \"      ")))
      (end-of-line)
      (newline)
      (insert indent "(")
      ;; Trigger company completion
      (when (and (fboundp 'company-mode) company-mode)
        (company-complete))))

   ;; If we're on a node line (has content), start continuation
   ((save-excursion
      (beginning-of-line)
      (and (not (looking-at "^[[:space:]]*$"))
           (not (looking-at "^-"))
           (not (looking-at "^::"))))
    (end-of-line)
    (newline)
    (insert "    \"      (")
    ;; Trigger company completion
    (when (and (fboundp 'company-mode) company-mode)
      (company-complete)))))

(defun n4live-smart-backspace ()
  "Smart backspace: delete to previous logical point if no meaningful content before point."
  (interactive)
  (let* ((bol (line-beginning-position))
         (before-point (buffer-substring-no-properties bol (point)))
         ;; Check if there's only whitespace/structure before point
         (only-structure (string-match-p "^[[:space:]\"()]*$" before-point)))
    (cond
     ;; If only structure before point, delete to previous logical position
     (only-structure
      (cond
       ;; On a continuation line with just the opening paren
       ((and (n4live-smart--on-continuation-line-p)
             (looking-back "^[[:space:]]*\"[[:space:]]*(" (line-beginning-position)))
        ;; Delete entire continuation line setup
        (let ((start (line-beginning-position)))
          (forward-line -1)
          (end-of-line)
          (delete-region (point) (save-excursion (forward-line 1) (line-end-position)))))

       ;; Just after opening paren in continuation
       ((looking-back "(" 1)
        (delete-char -1))

       ;; In the middle of continuation indent
       ((looking-back "^[[:space:]]*\"[[:space:]]+" (line-beginning-position))
        ;; Delete back to the quote
        (delete-region (save-excursion (re-search-backward "\"" bol t) (1+ (point)))
                      (point)))

       ;; Just after newline at end of previous line
       ((and (bolp) (not (bobp)))
        ;; Delete the newline
        (delete-char -1))

       ;; Default: regular backspace
       (t
        (delete-char -1))))

     ;; Normal backspace when there's content before point
     (t
      (delete-char -1)))))

(defun n4live-smart-insert-arrow ()
  "Insert arrow with completion after opening paren."
  (interactive)
  (let ((arrow (n4live-smart--read-arrow)))
    (insert arrow ") ")))

(defun n4live-smart-open-paren ()
  "Smart open paren: insert paren and optionally complete arrow."
  (interactive)
  (insert "(")
  ;; Check if we're in a position where an arrow makes sense
  (when (and (save-excursion
               (beginning-of-line)
               (or (looking-at "^[^-:]") ;; Not chapter/context
                   (looking-at "^[[:space:]]*\""))) ;; Continuation
             (y-or-n-p "Complete arrow? "))
    (delete-char -1) ;; Remove the ( we just inserted
    (insert "(")
    (let ((arrow (n4live-smart--read-arrow)))
      (insert arrow ") "))))

(defun n4live-smart-newline ()
  "Smart newline: continue current node or start fresh."
  (interactive)
  (cond
   ;; On continuation line - add another or finish
   ((n4live-smart--on-continuation-line-p)
    (if (y-or-n-p "Add another relation? ")
        (n4live-smart-tab)
      (progn
        (end-of-line)
        (newline)
        (newline))))

   ;; Regular newline
   (t
    (newline))))

(defun n4live-smart-new-node ()
  "Start a new node at point."
  (interactive)
  (unless (bolp)
    (end-of-line)
    (newline))
  (when (save-excursion
          (forward-line -1)
          (not (looking-at "^[[:space:]]*$")))
    (newline))
  (let ((node-text (read-string "Node text: "))
        (arrow (n4live-smart--read-arrow))
        (target (read-string "Target: ")))
    (insert (format "%s (%s) %s" node-text arrow target))))

(defun n4live-smart-add-relation ()
  "Add a relation to the current node."
  (interactive)
  (end-of-line)
  (newline)
  (let ((arrow (n4live-smart--read-arrow))
        (target (read-string "Target: ")))
    (insert (format "    \"      (%s) %s" arrow target))))

(defun n4live-smart-add-chapter ()
  "Insert a chapter marker."
  (interactive)
  (unless (bolp)
    (end-of-line)
    (newline))
  (when (save-excursion
          (forward-line -1)
          (not (looking-at "^[[:space:]]*$")))
    (newline))
  (let ((chapter (read-string "Chapter name: ")))
    (insert (format "- %s\n\n" chapter))))

(defun n4live-smart-add-context ()
  "Insert a context marker."
  (interactive)
  (let* ((tags-string (read-string "Context tags (comma-separated): "))
         (tags (mapcar #'string-trim (split-string tags-string ","))))
    (insert (format ":: %s ::\n\n" (string-join tags ", ")))))

(defun n4live-smart-setup-file ()
  "Set up a new N4L file with chapter and context."
  (interactive)
  (when (or (= (buffer-size) 0)
            (y-or-n-p "Buffer not empty. Set up chapter/context anyway? "))
    (goto-char (point-min))
    (let ((chapter (read-string "Chapter name: "))
          (tags-string (read-string "Context tags (comma-separated, optional): ")))
      (insert (format "- %s\n\n" chapter))
      (unless (string-empty-p tags-string)
        (let ((tags (mapcar #'string-trim (split-string tags-string ","))))
          (insert (format ":: %s ::\n\n" (string-join tags ", ")))))
      (message "Chapter set up. Start typing your first node!"))))

;;; Minor mode

(defvar n4live-smart-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "TAB") #'n4live-smart-tab)
    (define-key map (kbd "DEL") #'n4live-smart-backspace)
    (define-key map (kbd "<backspace>") #'n4live-smart-backspace)
    (define-key map (kbd "C-c (") #'n4live-smart-insert-arrow)
    (define-key map (kbd "C-c C-n") #'n4live-smart-new-node)
    (define-key map (kbd "C-c C-r") #'n4live-smart-add-relation)
    (define-key map (kbd "C-c RET") #'n4live-smart-newline)
    (define-key map (kbd "C-c C-h") #'n4live-smart-add-chapter)
    (define-key map (kbd "C-c C-x") #'n4live-smart-add-context)
    (define-key map (kbd "C-c C-s") #'n4live-smart-setup-file)
    map)
  "Keymap for n4live-smart-mode.")

;;;###autoload
(define-minor-mode n4live-smart-mode
  "Minor mode for smart N4L editing.

Provides intelligent helpers for writing N4L files:
- TAB: Add continuation line with proper indentation + arrow completion
- C-c (: Insert arrow with completion
- C-c C-n: Create new node
- C-c C-r: Add relation to current node
- C-c C-h: Add chapter marker
- C-c C-x: Add context tags
- C-c C-s: Set up new file (chapter + context)
- C-c RET: Smart newline

\\{n4live-smart-mode-map}"
  :lighter " N4L+"
  :keymap n4live-smart-mode-map
  (if n4live-smart-mode
      (progn
        ;; Enable company-mode and add our backend
        (when (fboundp 'company-mode)
          (company-mode 1)
          (setq-local company-backends
                      (cons 'company-n4live-arrows
                            (remove 'company-n4live-arrows
                                   (if (listp company-backends)
                                       company-backends
                                     (list company-backends)))))
          ;; Configure TAB to complete in company
          (setq-local company-active-map
                      (let ((map (make-sparse-keymap)))
                        (set-keymap-parent map company-active-map)
                        (define-key map (kbd "TAB") #'company-complete-selection)
                        (define-key map (kbd "<tab>") #'company-complete-selection)
                        map)))
        ;; Auto-prompt for chapter setup on empty files
        (when (and (= (buffer-size) 0)
                   (y-or-n-p "Empty N4L file. Set up chapter and context? "))
          (n4live-smart-setup-file)))
    ;; Cleanup when disabling mode
    (when (fboundp 'company-mode)
      (setq-local company-backends
                  (remove 'company-n4live-arrows company-backends)))))

;;;###autoload
(defun n4live-smart-setup ()
  "Enable n4live-smart-mode in sstorytime-n4l-mode buffers."
  (when (derived-mode-p 'sstorytime-n4l-mode)
    (n4live-smart-mode 1)))

;; Auto-enable in n4l files
;;;###autoload
(add-hook 'sstorytime-n4l-mode-hook #'n4live-smart-setup)

(provide 'n4live-smart)
;;; n4live-smart.el ends here
