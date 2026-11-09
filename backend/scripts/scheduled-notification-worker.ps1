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

# php.exe gets its own console when started with `&`, and Windows Terminal (default terminal)
# then pops a window for it every run. -NoNewWindow + redirected output starts it with no console at all.
$outFile = Join-Path $logDir "notification-worker.stdout.tmp"
$errFile = Join-Path $logDir "notification-worker.stderr.tmp"
$proc = Start-Process -FilePath $phpExe -ArgumentList "scripts\notification-worker.php","--once" -WorkingDirectory $backendDir `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$code = $proc.ExitCode
$output = @(Get-Content $outFile, $errFile -ErrorAction SilentlyContinue)
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue

if ($output -or $code -ne 0) {
    $output | Out-String | Add-Content -Path $logFile
    "exit code: $code ($(Get-Date -Format o))" | Add-Content -Path $logFile
}
