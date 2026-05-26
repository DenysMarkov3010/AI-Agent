#!/bin/bash
# AI Test Agent — start DemoAgent web UI (if needed) and open the app in the browser.
# Mirrors launch-ai-agent.ps1 for macOS.
# Run from the Desktop .app launcher or: bash scripts/launch-ai-agent.sh

set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WEB_UI_PORT:-3847}"
WEB_URL="http://127.0.0.1:${PORT}/"
HEALTH_URL="${WEB_URL}__da/health"

test_web_ui_up() {
  curl -sf -o /dev/null --max-time 2 "$HEALTH_URL"
}

if [ ! -f "$PROJECT_ROOT/web-ui-server.js" ]; then
  /usr/bin/osascript -e "display dialog \"Не знайдено web-ui-server.js у:\\n$PROJECT_ROOT\" buttons {\"OK\"} default button \"OK\" with title \"AI Test Agent\"" >/dev/null 2>&1 || true
  exit 1
fi

if ! test_web_ui_up; then
  # Use a login shell so PATH includes the user's npm/node (Homebrew, nvm, asdf, ...).
  USER_SHELL="${SHELL:-/bin/zsh}"
  "$USER_SHELL" -lc "cd \"$PROJECT_ROOT\" && nohup npm run web >/tmp/ai-agent.log 2>&1 &" || true
  deadline=$(( $(date +%s) + 30 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.4
    if test_web_ui_up; then break; fi
  done
fi

# Always prefer Chrome on macOS. Try bundle ID first (locale-proof), then the
# display name, then the explicit .app path; fall back to the user's default
# browser only if no Chrome variant is installed.
open_in_chrome() {
  /usr/bin/open -b com.google.Chrome "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -a "Google Chrome" "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -b com.google.Chrome.canary "$WEB_URL" 2>/dev/null && return 0
  /usr/bin/open -a "Google Chrome Canary" "$WEB_URL" 2>/dev/null && return 0
  if [ -d "/Applications/Google Chrome.app" ]; then
    /usr/bin/open -a "/Applications/Google Chrome.app" "$WEB_URL" 2>/dev/null && return 0
  fi
  return 1
}

if ! open_in_chrome; then
  /usr/bin/osascript -e "display dialog \"Google Chrome не знайдено. Відкриваю у браузері за замовчуванням.\\n\\n$WEB_URL\" buttons {\"OK\"} default button \"OK\" with title \"AI Test Coverage\"" >/dev/null 2>&1 || true
  /usr/bin/open "$WEB_URL"
fi
