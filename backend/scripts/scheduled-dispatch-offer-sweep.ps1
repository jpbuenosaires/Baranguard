# Baranguard - Task Scheduler entry point for the night-time dispatch offer
# sweeper (Wave 2). Runs backend/scripts/dispatch-offer-sweeper.php --once,
# registered by install-scheduled-backup-jobs.ps1 as
# BaranguardDispatchOfferSweeper, every minute.
#
# The sweeper prints nothing when no offer is due, so this wrapper appends to
# ONE rolling log only when there is output (a log file per minute would be
# 1440 files a day).

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "dispatch-offer-sweeper.log"

$phpExe = (Get-Command php.exe -ErrorAction SilentlyContinue).Source
if (-not $phpExe) { $phpExe = "C:\xampp\php\php.exe" }

Push-Location $backendDir
$output = & $phpExe "scripts\dispatch-offer-sweeper.php" "--once" 2>&1
$code = $LASTEXITCODE
Pop-Location

if ($output -or $code -ne 0) {
    $output | Out-String | Add-Content -Path $logFile
    "exit code: $code ($(Get-Date -Format o))" | Add-Content -Path $logFile
}
