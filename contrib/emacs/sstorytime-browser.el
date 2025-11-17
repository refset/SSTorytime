;;; sstorytime-browser.el --- Interactive browser for SSTorytime -*- lexical-binding: t; -*-

;; This file contains the magit-section based browser

;;; Code:

(require 'magit-section)
(require 'json)
(require 'url)
(require 'cl-lib)

;; Compatibility
(eval-when-compile
  (unless (fboundp 'when-let)
    (defmacro when-let (bindings &rest body)
      "Evaluate BODY if all BINDINGS are non-nil."
      (declare (indent 1) (debug (((&rest (symbolp form)) body))))
      (let ((binding-list (if (consp (car bindings)) bindings (list bindings))))
        `(let ,binding-list
           (when ,(caar binding-list)
             ,@body))))))

;;; Faces for different link types

(defface sstorytime-link-similarity
  '((t :inherit font-lock-constant-face :slant italic))
  "Face for similarity/nearness links (STtype 0)."
  :group 'sstorytime)

(defface sstorytime-link-leadsto
  '((t :inherit font-lock-keyword-face :weight bold))
  "Face for leads-to/causal links (STtype 1)."
  :group 'sstorytime)

(defface sstorytime-link-contains
  '((t :inherit font-lock-type-face))
  "Face for contains/hierarchy links (STtype 2)."
  :group 'sstorytime)

(defface sstorytime-link-properties
  '((t :inherit font-lock-variable-name-face))
  "Face for property/attribute links (STtype 3)."
  :group 'sstorytime)

;;; Navigation history

(defvar-local sstorytime-history-back nil
  "List of previous searches for back navigation.")

(defvar-local sstorytime-history-forward nil
  "List of forward searches (after going back).")

;;; Data structures

(cl-defstruct sstorytime-search-result
  "A search result containing multiple nodes."
  query nodes time intent ambient)

(cl-defstruct sstorytime-result-node
  "A node in search results with its orbit."
  text L chap context nptr xyz orbits)

(cl-defstruct sstorytime-orbit-node
  "A connected node in an orbit."
  radius arrow stindex dst ctx text xyz)

;;; JSON API Functions

(defun sstorytime--url-encode (string)
  "URL encode STRING."
  (url-hexify-string string))

(defun sstorytime--http-search (query)
  "Search for QUERY using HTTP API and return parsed JSON."
  (let* ((encoded-query (sstorytime--url-encode query))
         (url (format "%s/searchN4L?name=%s" sstorytime-server-url encoded-query))
         (url-request-extra-headers '(("Content-Type" . "application/x-www-form-urlencoded")))
         (url-mime-charset-string "utf-8"))
    (with-current-buffer (url-retrieve-synchronously url t nil 5)
      (set-buffer-multibyte t)
      (goto-char (point-min))
      (re-search-forward "^$")
      (decode-coding-region (point) (point-max) 'utf-8)
      (let ((json-object-type 'alist)
            (json-array-type 'list)
            (json-key-type 'string))
        (condition-case err
            (json-read)
          (error
           (message "Failed to parse JSON: %s\nBuffer: %s" err (buffer-string))
           nil))))))

(defun sstorytime--parse-search-results (json query)
  "Parse JSON search results for QUERY."
  (when json
    (make-sstorytime-search-result
     :query query
     :nodes (delq nil (mapcar #'sstorytime--parse-result-node
                              (cdr (assoc "Content" json))))
     :time (cdr (assoc "Time" json))
     :intent (cdr (assoc "Intent" json))
     :ambient (cdr (assoc "Ambient" json)))))

(defun sstorytime--parse-result-node (node-json)
  "Parse NODE-JSON into sstorytime-result-node.
Return nil if NODE-JSON is not a valid node object."
  (when (and (listp node-json)
             (assoc "Text" node-json))
    (make-sstorytime-result-node
     :text (cdr (assoc "Text" node-json))
     :L (cdr (assoc "L" node-json))
     :chap (cdr (assoc "Chap" node-json))
     :context (cdr (assoc "Context" node-json))
     :nptr (cdr (assoc "NPtr" node-json))
     :xyz (cdr (assoc "XYZ" node-json))
     :orbits (sstorytime--parse-orbits (cdr (assoc "Orbits" node-json))))))

(defun sstorytime--parse-orbits (orbits-json)
  "Parse ORBITS-JSON into list of orbit nodes."
  (when orbits-json
    (let (result)
      (dolist (orbit-ring orbits-json)
        (when orbit-ring
          (dolist (orbit-node orbit-ring)
            (push (make-sstorytime-orbit-node
                   :radius (cdr (assoc "Radius" orbit-node))
                   :arrow (cdr (assoc "Arrow" orbit-node))
                   :stindex (cdr (assoc "STindex" orbit-node))
                   :dst (cdr (assoc "Dst" orbit-node))
                   :ctx (cdr (assoc "Ctx" orbit-node))
                   :text (cdr (assoc "Text" orbit-node))
                   :xyz (cdr (assoc "XYZ" orbit-node)))
                  result))))
      (nreverse result))))

;;; Display Functions

(defun sstorytime--get-link-face (arrow)
  "Get face for ARROW based on link type keywords."
  (let ((arrow-lower (downcase (or arrow ""))))
    (cond
     ((string-match-p "\\(similar\\|same\\|like\\|near\\|equal\\)" arrow-lower)
      'sstorytime-link-similarity)
     ((string-match-p "\\(leads\\|cause\\|affect\\|then\\|next\\|precede\\|succeed\\)" arrow-lower)
      'sstorytime-link-leadsto)
     ((string-match-p "\\(contain\\|part\\|element\\|member\\|include\\|belong\\)" arrow-lower)
      'sstorytime-link-contains)
     ((string-match-p "\\(has\\|property\\|express\\|means\\|called\\|note\\|remark\\)" arrow-lower)
      'sstorytime-link-properties)
     (t 'sstorytime-relation-face))))

(defun sstorytime--insert-search-results (results)
  "Insert RESULTS using magit-section."
  (magit-insert-section (search-results)
    (magit-insert-heading
      (format "Search: %s" (propertize (sstorytime-search-result-query results)
                                      'face 'bold)))

    ;; Insert metadata
    (when (sstorytime-search-result-time results)
      (insert (propertize (format "Time: %s\n" (sstorytime-search-result-time results))
                         'face 'sstorytime-context-face)))

    (when (sstorytime-search-result-ambient results)
      (insert (propertize (format "Context: %s\n\n" (sstorytime-search-result-ambient results))
                         'face 'sstorytime-context-face)))

    ;; Insert nodes
    (let ((nodes (sstorytime-search-result-nodes results)))
      (if (null nodes)
          (insert (propertize "No results found.\n" 'face 'font-lock-comment-face))
        (dolist (node nodes)
          (sstorytime--insert-node node))))))

(defun sstorytime--insert-node (node &optional depth)
  "Insert NODE as a magit-section at DEPTH."
  (setq depth (or depth 0))
  (let ((text (sstorytime-result-node-text node))
        (chap (sstorytime-result-node-chap node))
        (ctx (sstorytime-result-node-context node))
        (orbits (sstorytime-result-node-orbits node)))

    (magit-insert-section (node node t)
      ;; Node heading
      (magit-insert-heading
        (concat
         (make-string (* depth 2) ?\s)
         (propertize (or text "") 'face 'sstorytime-node-face)))

      ;; Chapter and context
      (when chap
        (insert (make-string (* (1+ depth) 2) ?\s))
        (insert (propertize "Chapter: " 'face 'sstorytime-chapter-face))
        (insert (propertize chap
                           'face 'sstorytime-chapter-face
                           'sstorytime-chapter chap
                           'mouse-face 'highlight
                           'help-echo "RET to open N4L file"))
        (insert "\n"))
      (when ctx
        (insert (make-string (* (1+ depth) 2) ?\s)
                (propertize (format "Context: %s\n" ctx)
                           'face 'sstorytime-context-face)))

      ;; Orbits (connected nodes)
      (when orbits
        (insert "\n")
        (dolist (orbit-node orbits)
          (sstorytime--insert-orbit-node orbit-node (1+ depth)))))))

(defun sstorytime--insert-orbit-node (orbit-node depth)
  "Insert ORBIT-NODE as a clickable link at DEPTH."
  (let* ((arrow (sstorytime-orbit-node-arrow orbit-node))
         (text (sstorytime-orbit-node-text orbit-node))
         (ctx (sstorytime-orbit-node-ctx orbit-node))
         (radius (sstorytime-orbit-node-radius orbit-node))
         (indent (make-string (* depth 2) ?\s))
         (arrow-face (sstorytime--get-link-face arrow)))

    (magit-insert-section (orbit orbit-node t)
      (magit-insert-heading
        (concat indent
                (propertize (format "─%s─> " (make-string radius ?─))
                           'face 'font-lock-comment-face)
                (propertize (format "(%s)" arrow)
                           'face arrow-face)
                " "
                (propertize text
                           'face 'sstorytime-node-face
                           'sstorytime-clickable t
                           'sstorytime-search-text text)))

      (when ctx
        (insert (make-string (* (1+ depth) 2) ?\s)
                (propertize (format "[%s]\n" ctx)
                           'face 'sstorytime-context-face))))))

;;; Navigation

(defun sstorytime-browse-enter ()
  "Navigate to node at point or search for it."
  (interactive)
  ;; First check if we're on a chapter link (text property takes priority)
  (let ((chapter (get-text-property (point) 'sstorytime-chapter)))
    (if chapter
        (sstorytime--open-chapter-file chapter)
      ;; Otherwise use section-based navigation
      (let ((section (magit-current-section)))
        (when section
          (let ((type (oref section type))
                (value (oref section value)))
            (pcase type
              ('orbit
               (let ((text (and value (sstorytime-orbit-node-text value))))
                 (when text
                   (message "Searching for: %s" text)
                   (sstorytime--search-and-display text))))

              ('node
               (let ((text (and value (sstorytime-result-node-text value))))
                 (when text
                   (message "Searching for: %s" text)
                   (sstorytime--search-and-display text))))

              (_
               ;; Try search text property
               (let ((text (get-text-property (point) 'sstorytime-search-text)))
                 (when text
                   (message "Searching for: %s" text)
                   (sstorytime--search-and-display text)))))))))))

(defun sstorytime--find-chapter-in-files (chapter)
  "Find which N4L file(s) contain CHAPTER using ripgrep.
Returns list of (FILE . LINE-NUMBER) pairs."
  (when (and sstorytime-n4l-directory
             (file-directory-p sstorytime-n4l-directory))
    (let* ((default-directory sstorytime-n4l-directory)
           ;; Search for "- chapter" at start of line
           (pattern (format "^-\\s*%s\\s*$" (regexp-quote chapter)))
           (output (shell-command-to-string
                    (format "rg -n --type-add 'n4l:*.n4l' -t n4l '%s' 2>/dev/null || true" pattern)))
           (lines (split-string output "\n" t))
           results)
      (dolist (line lines)
        ;; Parse "filename:linenum:content"
        (when (string-match "^\\([^:]+\\):\\([0-9]+\\):" line)
          (let ((file (match-string 1 line))
                (linenum (string-to-number (match-string 2 line))))
            (push (cons file linenum) results))))
      (nreverse results))))


(defun sstorytime--open-chapter-file (chapter)
  "Open the N4L file for CHAPTER.
First tries CHAPTER.n4l, then searches all N4L files using ripgrep."
  (if (not sstorytime-n4l-directory)
      (message "sstorytime-n4l-directory not configured. Set it to enable opening chapter files.")
    (let* ((predicted-file (expand-file-name (concat chapter ".n4l") sstorytime-n4l-directory)))
      (cond
       ;; Fast path: predicted filename exists
       ((file-exists-p predicted-file)
        (find-file predicted-file))

       ;; Search for chapter in all N4L files
       (t
        (let ((matches (sstorytime--find-chapter-in-files chapter)))
          (cond
           ;; No matches - offer to create new file
           ((null matches)
            (if (yes-or-no-p (format "Chapter '%s' not found in any N4L file. Create %s? "
                                     chapter (file-name-nondirectory predicted-file)))
                (progn
                  (find-file predicted-file)
                  (insert (format "- %s\n\n" chapter)))
              (message "Chapter not found: %s" chapter)))

           ;; One match - open it and jump to line
           ((= 1 (length matches))
            (let* ((match (car matches))
                   (file (expand-file-name (car match) sstorytime-n4l-directory))
                   (line (cdr match)))
              (find-file file)
              (goto-char (point-min))
              (forward-line (1- line))
              (recenter)
              (message "Found chapter '%s' in %s at line %d"
                       chapter (file-name-nondirectory file) line)))

           ;; Multiple matches - let user choose
           (t
            (let* ((choices (mapcar (lambda (m)
                                     (format "%s:%d" (car m) (cdr m)))
                                   matches))
                   (choice (completing-read
                            (format "Chapter '%s' found in multiple files. Choose: " chapter)
                            choices nil t)))
              (when (string-match "^\\([^:]+\\):\\([0-9]+\\)" choice)
                (let ((file (expand-file-name (match-string 1 choice) sstorytime-n4l-directory))
                      (line (string-to-number (match-string 2 choice))))
                  (find-file file)
                  (goto-char (point-min))
                  (forward-line (1- line))
                  (recenter))))))))))))


(defun sstorytime-remove-chapter-at-point ()
  "Remove the chapter at point from the database."
  (interactive)
  (let ((chapter (get-text-property (point) 'sstorytime-chapter)))
    (if chapter
        (when (yes-or-no-p (format "Remove all data from chapter '%s'? This cannot be undone! " chapter))
          (require 'sstorytime)
          (sstorytime-remove-chapter chapter)
          (sstorytime-browse-refresh))
      (message "No chapter at point"))))

(defun sstorytime--search-and-display (query &optional no-history)
  "Search for QUERY and display results.
If NO-HISTORY is non-nil, don't add to navigation history."
  (let ((json (sstorytime--http-search query)))
    (if json
        (let ((results (sstorytime--parse-search-results json query)))
          (sstorytime--display-results results no-history))
      (message "No results or server error"))))

(defvar-local sstorytime--current-results nil
  "The current search results being displayed.")

(defun sstorytime--display-results (results &optional no-history)
  "Display RESULTS in a browse buffer.
If NO-HISTORY is non-nil, don't add to navigation history."
  (let ((buffer (get-buffer-create "*SSTorytime*")))
    (with-current-buffer buffer
      (let ((inhibit-read-only t)
            (current-query (and sstorytime--current-results
                                (sstorytime-search-result-query sstorytime--current-results)))
            (new-query (sstorytime-search-result-query results)))
        ;; Add to history if this is a new search (not from back/forward)
        (unless (or no-history (equal current-query new-query))
          (when current-query
            (push current-query sstorytime-history-back))
          ;; Clear forward history when making a new search
          (setq sstorytime-history-forward nil))
        (erase-buffer)
        (sstorytime-browse-mode)
        (setq sstorytime--current-results results)
        (sstorytime--insert-search-results results)
        (goto-char (point-min))))
    (pop-to-buffer buffer)))

(defun sstorytime-browse-refresh (&optional _ignore-auto _noconfirm)
  "Refresh the current browse buffer."
  (interactive)
  (when sstorytime--current-results
    (let ((query (sstorytime-search-result-query sstorytime--current-results)))
      (sstorytime--search-and-display query))))

(defun sstorytime-browse-back ()
  "Go back to the previous search."
  (interactive)
  (if sstorytime-history-back
      (let ((previous-query (pop sstorytime-history-back))
            (current-query (and sstorytime--current-results
                                (sstorytime-search-result-query sstorytime--current-results))))
        (when current-query
          (push current-query sstorytime-history-forward))
        (sstorytime--search-and-display previous-query 'no-history))
    (message "No previous search")))

(defun sstorytime-browse-forward ()
  "Go forward to the next search."
  (interactive)
  (if sstorytime-history-forward
      (let ((next-query (pop sstorytime-history-forward))
            (current-query (and sstorytime--current-results
                                (sstorytime-search-result-query sstorytime--current-results))))
        (when current-query
          (push current-query sstorytime-history-back))
        (sstorytime--search-and-display next-query 'no-history))
    (message "No forward search")))

;;; Mode

(defvar sstorytime-browse-mode-map
  (let ((map (make-sparse-keymap)))
    (define-key map (kbd "RET") #'sstorytime-browse-enter)
    (define-key map (kbd "TAB") #'magit-section-cycle)
    (define-key map (kbd "<tab>") #'magit-section-cycle)
    (define-key map (kbd "g") #'sstorytime-browse-refresh)
    (define-key map (kbd "s") #'sstorytime-search)
    (define-key map (kbd "c") #'sstorytime-search-chapter)
    (define-key map (kbd "C") #'sstorytime-search-context)
    (define-key map (kbd "?") #'sstorytime-dispatch)
    (define-key map (kbd "q") #'quit-window)
    (define-key map (kbd "n") #'magit-section-forward)
    (define-key map (kbd "p") #'magit-section-backward)
    (define-key map (kbd "l") #'sstorytime-browse-back)
    (define-key map (kbd "r") #'sstorytime-browse-forward)
    (define-key map (kbd "M-<left>") #'sstorytime-browse-back)
    (define-key map (kbd "M-<right>") #'sstorytime-browse-forward)
    (define-key map (kbd "D") #'sstorytime-remove-chapter-at-point)
    map)
  "Keymap for `sstorytime-browse-mode'.")

(define-derived-mode sstorytime-browse-mode magit-section-mode "SSTorytime"
  "Major mode for browsing SSTorytime knowledge graphs.

\\{sstorytime-browse-mode-map}"
  :group 'sstorytime
  (setq-local revert-buffer-function #'sstorytime-browse-refresh)
  (setq-local truncate-lines nil)
  (setq-local word-wrap t))

;;; Public API

(defun sstorytime-browse-search (query)
  "Browse search results for QUERY."
  (interactive "sSearch: ")
  (message "Searching for: %s" query)
  (sstorytime--search-and-display query))

(provide 'sstorytime-browser)
;;; sstorytime-browser.el ends here
