;;; elisp-dev-server.el --- REPL server for elisp-dev tools -*- lexical-binding: t; -*-

;;; Commentary:

;; A long-running Emacs server that responds to elisp-dev queries over a socket.
;; This avoids the overhead of launching Emacs for each query.
;;
;; Usage:
;;   emacs --batch -l elisp-dev-server.el -f elisp-dev-server-start
;;
;; The server listens on a Unix socket and responds to JSON-RPC style commands.

;;; Code:

(require 'json)
(require 'server)

;; Load the core tools
(load (expand-file-name "elisp-dev-tools.el"
                       (file-name-directory (or load-file-name buffer-file-name))))

(defvar elisp-dev-server-port 9999
  "TCP port for the elisp-dev server.")

(defvar elisp-dev-server-process nil
  "The server process.")

(defvar elisp-dev-server-socket-dir
  (expand-file-name "~/.emacs.d/elisp-dev/")
  "Directory for Unix socket.")

(defvar elisp-dev-server-socket-file
  (expand-file-name "socket" elisp-dev-server-socket-dir)
  "Unix socket file path.")

(defun elisp-dev-server--ensure-socket-dir ()
  "Ensure socket directory exists."
  (unless (file-directory-p elisp-dev-server-socket-dir)
    (make-directory elisp-dev-server-socket-dir t)))

(defun elisp-dev-server--handle-request (json-request)
  "Handle JSON-REQUEST and return JSON response."
  (condition-case err
      (let* ((request (json-read-from-string json-request))
             (command (cdr (assoc 'command request)))
             (args (append (cdr (assoc 'args request)) nil)))
        (with-output-to-string
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
            ("eval"
             (condition-case eval-err
                 (let ((result (eval (read (car args)))))
                   (princ (json-encode `((result . ,(format "%S" result))))))
               (error
                (princ (json-encode `((error . ,(format "Eval error: %s" (error-message-string eval-err)))))))))
            ("list-buffers"
             (let ((buffers (mapcar (lambda (b)
                                      `((name . ,(buffer-name b))
                                        (mode . ,(format "%s" (buffer-local-value 'major-mode b)))
                                        (file . ,(or (buffer-file-name b) "nil"))))
                                    (buffer-list))))
               (princ (json-encode `((buffers . ,buffers))))))
            ("get-buffer"
             (let ((buf (get-buffer (car args))))
               (if buf
                   (with-current-buffer buf
                     (princ (json-encode `((buffer . ,(car args))
                                          (mode . ,(format "%s" major-mode))
                                          (file . ,(or (buffer-file-name) "nil"))
                                          (point . ,(point))
                                          (size . ,(buffer-size))
                                          (content . ,(buffer-string))))))
                 (princ (json-encode `((error . ,(format "Buffer '%s' not found" (car args)))))))))
            ("ping"
             (princ (json-encode '((status . "ok") (version . "1.0")))))
            ("shutdown"
             (princ (json-encode '((status . "shutting down"))))
             (run-at-time 0.1 nil #'elisp-dev-server-stop))
            (_
             (princ (json-encode
                    `((error . ,(format "Unknown command: %s" command)))))))))
    (error
     (json-encode `((error . ,(format "Request error: %s" (error-message-string err))))))))

(defun elisp-dev-server--process-filter (proc string)
  "Process filter for server PROC receiving STRING."
  (let ((response (elisp-dev-server--handle-request string)))
    (process-send-string proc (concat response "\n"))))

(defun elisp-dev-server--sentinel (proc event)
  "Sentinel for server PROC with EVENT."
  (when (string-match "^open" event)
    (message "Client connected"))
  (when (string-match "^closed\\|^failed\\|^deleted" event)
    (message "Client disconnected")))

(defun elisp-dev-server-start-tcp ()
  "Start the elisp-dev TCP server."
  (interactive)
  (when (and elisp-dev-server-process
             (process-live-p elisp-dev-server-process))
    (error "Server already running"))

  (setq elisp-dev-server-process
        (make-network-process
         :name "elisp-dev-server"
         :server t
         :host "localhost"
         :service elisp-dev-server-port
         :family 'ipv4
         :filter #'elisp-dev-server--process-filter
         :sentinel #'elisp-dev-server--sentinel
         :noquery t))

  (message "elisp-dev server started on TCP port %d" elisp-dev-server-port)
  (message "Connect with: nc localhost %d" elisp-dev-server-port)

  ;; Keep server alive in batch mode
  (when noninteractive
    (while (process-live-p elisp-dev-server-process)
      (accept-process-output nil 1))))

(defun elisp-dev-server-start-unix ()
  "Start the elisp-dev Unix socket server."
  (interactive)
  (when (and elisp-dev-server-process
             (process-live-p elisp-dev-server-process))
    (error "Server already running"))

  (elisp-dev-server--ensure-socket-dir)

  ;; Remove old socket if exists
  (when (file-exists-p elisp-dev-server-socket-file)
    (delete-file elisp-dev-server-socket-file))

  (setq elisp-dev-server-process
        (make-network-process
         :name "elisp-dev-server"
         :server t
         :family 'local
         :service elisp-dev-server-socket-file
         :filter #'elisp-dev-server--process-filter
         :sentinel #'elisp-dev-server--sentinel
         :noquery t))

  (message "elisp-dev server started on Unix socket: %s" elisp-dev-server-socket-file)
  (message "Connect with: nc -U %s" elisp-dev-server-socket-file)

  ;; Keep server alive in batch mode
  (when noninteractive
    (while (process-live-p elisp-dev-server-process)
      (accept-process-output nil 1))))

(defun elisp-dev-server-start ()
  "Start the elisp-dev server (defaults to TCP)."
  (interactive)
  (elisp-dev-server-start-tcp))

(defun elisp-dev-server-stop ()
  "Stop the elisp-dev server."
  (interactive)
  (when (and elisp-dev-server-process
             (process-live-p elisp-dev-server-process))
    (delete-process elisp-dev-server-process)
    (setq elisp-dev-server-process nil)
    (when (file-exists-p elisp-dev-server-socket-file)
      (delete-file elisp-dev-server-socket-file))
    (message "elisp-dev server stopped")))

(provide 'elisp-dev-server)
;;; elisp-dev-server.el ends here
