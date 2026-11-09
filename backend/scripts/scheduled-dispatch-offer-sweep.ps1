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

# php.exe gets its own console when started with `&`, and Windows Terminal (default terminal)
# then pops a window for it every run. -NoNewWindow + redirected output starts it with no console at all.
$outFile = Join-Path $logDir "dispatch-offer-sweeper.stdout.tmp"
$errFile = Join-Path $logDir "dispatch-offer-sweeper.stderr.tmp"
$proc = Start-Process -FilePath $phpExe -ArgumentList "scripts\dispatch-offer-sweeper.php","--once" -WorkingDirectory $backendDir `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
$code = $proc.ExitCode
$output = @(Get-Content $outFile, $errFile -ErrorAction SilentlyContinue)
Remove-Item $outFile, $errFile -ErrorAction SilentlyContinue

if ($output -or $code -ne 0) {
    $output | Out-String | Add-Content -Path $logFile
    "exit code: $code ($(Get-Date -Format o))" | Add-Content -Path $logFile
}
