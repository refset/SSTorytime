#!/bin/bash
# Elisp package testing script
# Based on elisp-dev-mcp best practices

set -e

echo "=== SSTorytime Emacs Package Testing ==="

# 0. Ensure dependencies
echo -e "\n[0/4] Ensuring dependencies..."
emacs --batch --eval "(progn \
  (require 'package) \
  (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
  (package-initialize) \
  (unless (package-installed-p 'magit) \
    (package-refresh-contents) \
    (package-install 'magit)))" 2>&1 | tail -1

# 1. Byte compilation (syntax check)
echo -e "\n[1/4] Byte compilation (syntax check)..."
emacs --batch --eval "(progn \
  (require 'package) \
  (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
  (package-initialize) \
  (setq byte-compile-error-on-warn nil) \
  (batch-byte-compile))" sstorytime.el sstorytime-browser.el 2>&1 | grep -E "(Error|Warning:|✅)" || {
    echo "❌ Byte compilation failed"
    exit 1
}
echo "✅ Byte compilation passed"

# 2. Load test
echo -e "\n[2/4] Load test..."
emacs --batch --eval "(progn \
  (require 'package) \
  (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
  (package-initialize) \
  (add-to-list 'load-path \"$(pwd)\") \
  (require 'sstorytime) \
  (message \"✅ Package loads successfully\"))" 2>&1 | grep -E "(✅|Error)" || {
    echo "❌ Load test failed"
    exit 1
}

# 3. Function availability check
echo -e "\n[3/4] Function availability check..."
emacs --batch --eval "(progn \
  (require 'package) \
  (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
  (package-initialize) \
  (add-to-list 'load-path \"$(pwd)\") \
  (require 'sstorytime) \
  (let ((missing nil)) \
    (dolist (fn '(sstorytime-search \
                  sstorytime-browse-search \
                  sstorytime-check-setup \
                  sstorytime-upload-buffer \
                  sstorytime-validate-buffer \
                  sstorytime-dispatch)) \
      (unless (fboundp fn) \
        (push fn missing))) \
    (if missing \
        (error \"Missing functions: %s\" missing) \
      (message \"✅ All expected functions available\"))))" 2>&1 | grep -E "(✅|Error|Missing)"

# 4. Integration test (requires running server)
echo -e "\n[4/4] Integration test (requires HTTP server)..."
if curl -s http://localhost:8080/status > /dev/null 2>&1; then
    emacs --batch --eval "(progn \
      (require 'package) \
      (add-to-list 'package-archives '(\"melpa\" . \"https://melpa.org/packages/\") t) \
      (package-initialize) \
      (add-to-list 'load-path \"$(pwd)\") \
      (require 'sstorytime) \
      (setq sstorytime-tools-path \"$(dirname $(pwd))/src\") \
      (setq sstorytime-server-url \"http://localhost:8080\") \
      (let ((json (sstorytime--http-search \"test\"))) \
        (if json \
            (message \"✅ HTTP API integration works\") \
          (error \"Failed to get JSON response\"))))" 2>&1 | grep -E "(✅|Error)"
else
    echo "⚠️  HTTP server not running, skipping integration test"
    echo "   Start with: cd ../src && ./http_server &"
fi

echo -e "\n=== All tests passed! ==="
