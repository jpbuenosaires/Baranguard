# Baranguard - makes Baranguard start by itself every time you sign in to
# Windows. No Administrator prompt needed: it puts a shortcut to
# "Start Baranguard.bat /quiet" in your own Startup folder.
#
# Run once (double-click is not enough; use PowerShell):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\install-startup-shortcut.ps1
# To remove it again:
#   powershell -ExecutionPolicy Bypass -File backend\scripts\install-startup-shortcut.ps1 -Remove
#
# This starts when you SIGN IN, not when the laptop is merely powered on.
# For start-at-boot without anyone logged in, use install-autostart-services.ps1
# (needs Administrator). Both can coexist: the launcher skips anything that
# is already running.

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$bat = Join-Path $repoRoot "Start Baranguard.bat"
$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "Baranguard.lnk"

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "[OK] Removed $lnk" }
    else { Write-Host "[INFO] Nothing to remove ($lnk not found)." }
    exit 0
}

if (-not (Test-Path $bat)) {
    Write-Host "[FAIL] $bat not found."
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $bat
$sc.Arguments = "/quiet"
$sc.WorkingDirectory = $repoRoot
$sc.WindowStyle = 7   # minimized
$sc.Description = "Starts Apache, MySQL and the Cloudflare tunnel for Baranguard"
$sc.Save()

Write-Host "[OK] Created $lnk"
Write-Host "     Baranguard will now start (minimized, no browser) each time you sign in."
Write-Host "     Test it now: double-click that shortcut, then open http://localhost/baranguard/web/"
