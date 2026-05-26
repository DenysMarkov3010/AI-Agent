#!/bin/bash
# Idempotent desktop shortcut for «AI Test Coverage» on macOS.
# If AI Test Coverage.app already exists on the user Desktop, exits without doing anything.
# Otherwise runs create-desktop-shortcut.sh (same as `npm run shortcut`).
# Called from web-ui-server.js on macOS when the web UI starts.

set -e

DESKTOP="$HOME/Desktop"
APP_PATH="$DESKTOP/AI Test Coverage.app"
LEGACY_APP="$DESKTOP/AI Test Agent.app"

if [ -d "$APP_PATH" ]; then
  if [ -d "$LEGACY_APP" ]; then
    rm -rf "$LEGACY_APP" || true
  fi
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec /bin/bash "$SCRIPT_DIR/create-desktop-shortcut.sh"
