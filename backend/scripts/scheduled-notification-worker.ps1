# Baranguard - Task Scheduler entry point for notification-worker.php --once
# (SOS re-alert for unacknowledged SOS, FCM ack timeout, SMS outbox drain).
# Registered by install-scheduled-backup-jobs.ps1 as
# BaranguardNotificationWorker, every minute. Silent when nothing is due: the
# rolling log is appended only when there is output.

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "notification-worker.log"

$phpExe = (Get-Command php.exe -ErrorAction SilentlyContinue).Source
if (-not $phpExe) { $phpExe = "C:\xampp\php\php.exe" }

Push-Location $backendDir
$output = & $phpExe "scripts\notification-worker.php" "--once" 2>&1
$code = $LASTEXITCODE
Pop-Location

if ($output -or $code -ne 0) {
    $output | Out-String | Add-Content -Path $logFile
    "exit code: $code ($(Get-Date -Format o))" | Add-Content -Path $logFile
}
