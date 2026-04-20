# Idempotent desktop shortcut for «AI Test Agent».
# If AI Test Agent.lnk already exists on the user Desktop, exits without doing anything.
# Otherwise runs create-desktop-shortcut.ps1 (same as npm run shortcut).
# Called from web-ui-server.js on Windows when the web UI starts.

$ErrorActionPreference = "Stop"
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "AI Test Agent.lnk"
if (Test-Path -LiteralPath $lnkPath) {
    exit 0
}
$createScript = Join-Path $PSScriptRoot "create-desktop-shortcut.ps1"
& $createScript
