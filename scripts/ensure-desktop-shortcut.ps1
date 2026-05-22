# Idempotent desktop shortcut for «AI Test Coverage».
# If AI Test Coverage.lnk already exists on the user Desktop, exits without doing anything.
# Otherwise runs create-desktop-shortcut.ps1 (same as npm run shortcut).
# Called from web-ui-server.js on Windows when the web UI starts.

$ErrorActionPreference = "Stop"
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "AI Test Coverage.lnk"
$legacyLnkPath = Join-Path $desktop "AI Test Agent.lnk"
if (Test-Path -LiteralPath $lnkPath) {
    if (Test-Path -LiteralPath $legacyLnkPath) {
        Remove-Item -LiteralPath $legacyLnkPath -Force -ErrorAction SilentlyContinue
    }
    exit 0
}
$createScript = Join-Path $PSScriptRoot "create-desktop-shortcut.ps1"
& $createScript
