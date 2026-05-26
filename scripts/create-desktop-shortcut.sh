#!/bin/bash
# Create "AI Test Coverage.app" on the user Desktop with custom icon (ai-agent.icns).
# Mirrors create-desktop-shortcut.ps1 for macOS.
# Run: bash scripts/create-desktop-shortcut.sh

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$HOME/Desktop"
APP_NAME="AI Test Coverage"
APP_PATH="$DESKTOP/${APP_NAME}.app"
LEGACY_APP="$DESKTOP/AI Test Agent.app"
PNG_PATH="$PROJECT_ROOT/assets/ai-agent.png"
ICNS_PATH="$PROJECT_ROOT/assets/ai-agent.icns"

if [ -d "$LEGACY_APP" ]; then
  rm -rf "$LEGACY_APP" || true
fi

if [ ! -f "$PNG_PATH" ]; then
  echo "Missing icon: $PNG_PATH" >&2
  exit 1
fi

# Build a multi-resolution .icns from the PNG if missing.
# Uses macOS-bundled sips + iconutil; both ship with every macOS install.
if [ ! -f "$ICNS_PATH" ]; then
  if ! command -v sips >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
    echo "sips/iconutil not found — cannot build .icns icon." >&2
    exit 1
  fi
  TMP_ROOT="$(mktemp -d)"
  ICONSET="$TMP_ROOT/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    double=$((size * 2))
    sips -z "$size" "$size" "$PNG_PATH" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$double" "$double" "$PNG_PATH" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$ICNS_PATH"
  rm -rf "$TMP_ROOT"
fi

# (Re)create the .app bundle. Removing first keeps the operation idempotent.
rm -rf "$APP_PATH"
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

cp "$ICNS_PATH" "$APP_PATH/Contents/Resources/AppIcon.icns"

cat > "$APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.demoagent.ai-agent</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
PLIST

LAUNCHER_BIN="$APP_PATH/Contents/MacOS/launcher"
#
# Self-contained launcher: embeds PROJECT_ROOT at build time.
#
# macOS 26+ silently sandboxes unsigned .app bundles on the Desktop (no TCC
# prompt, just "Operation not permitted"). Reading the external launch-*.sh
# from inside the .app fails. So the launcher CANNOT depend on any file
# outside the bundle. To then spawn `npm run web` outside the sandbox we
# trampoline through `/usr/bin/osascript` (Apple-signed) — its
# `do shell script` gives the child process the user's full TCC scope.
#
# We build the launcher in two parts: a header that embeds PROJECT_ROOT via
# `printf %q` (handles spaces / special chars), then a quoted heredoc body
# that keeps every $var literal.
{
  printf '#!/bin/bash\n'
  printf '# Self-contained launcher for AI Test Coverage.app — see create-desktop-shortcut.sh.\n'
  printf 'PROJECT_ROOT=%q\n' "$PROJECT_ROOT"
  cat <<'LAUNCHER_BODY'
PORT="${WEB_UI_PORT:-3847}"
WEB_URL="http://127.0.0.1:${PORT}/"
HEALTH_URL="${WEB_URL}__da/health"
LOG_FILE="/tmp/ai-agent.log"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE" 2>&1
}

log "launcher start, URL=$WEB_URL, PROJECT_ROOT=$PROJECT_ROOT"

is_up() {
  /usr/bin/curl -sf -o /dev/null --max-time 2 "$HEALTH_URL"
}

start_server_via_osascript() {
  # Escape single quotes in PROJECT_ROOT for the inner sh string.
  local escaped_root="${PROJECT_ROOT//\'/\'\\\'\'}"
  local shell_cmd
  shell_cmd="cd '${escaped_root}' && exec /bin/zsh -lc 'npm run web'"
  log "spawning via osascript: $shell_cmd"
  # Detach stdio (</dev/null + redirect) so `do shell script` does not hang
  # waiting for the captured pipe to close.
  /usr/bin/osascript \
    -e "do shell script \"nohup /bin/sh -c \\\"$shell_cmd\\\" </dev/null >>${LOG_FILE} 2>&1 &\"" \
    >> "$LOG_FILE" 2>&1
  log "osascript returned"
}

if ! is_up; then
  log "server not up; starting"
  start_server_via_osascript
  deadline=$(( $(date +%s) + 45 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.4
    if is_up; then
      log "server is up"
      break
    fi
  done
  if ! is_up; then
    log "server failed to come up within 45s"
  fi
else
  log "server already up"
fi

log "opening Chrome"
/usr/bin/open -b com.google.Chrome "$WEB_URL" >> "$LOG_FILE" 2>&1 && { log "Chrome opened via bundle id"; exit 0; }
/usr/bin/open -a "Google Chrome" "$WEB_URL" >> "$LOG_FILE" 2>&1 && { log "Chrome opened via name"; exit 0; }
log "Chrome not found; falling back to default browser"
/usr/bin/open "$WEB_URL" >> "$LOG_FILE" 2>&1
LAUNCHER_BODY
} > "$LAUNCHER_BIN"

chmod +x "$LAUNCHER_BIN"

# Touch the bundle so Finder refreshes the icon cache.
touch "$APP_PATH"

echo "Created: $APP_PATH"
echo "Icon:    $ICNS_PATH"
