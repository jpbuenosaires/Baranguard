# Baranguard - Task Scheduler entry point for gsm-ingest-daemon.php --daemon
# (inbound SMS: SOS-by-SMS envelopes and human texts). Registered at logon by
# install-scheduled-backup-jobs.ps1 as BaranguardGsmIngest. The daemon holds a
# lock file, so a second copy (e.g. the launcher's) exits immediately.

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$phpExe = (Get-Command php.exe -ErrorAction SilentlyContinue).Source
if (-not $phpExe) { $phpExe = "C:\xampp\php\php.exe" }

# No console for php (see scheduled-notification-worker.ps1); the daemon's output goes straight to the log.
Start-Process -FilePath $phpExe -ArgumentList "scripts\gsm-ingest-daemon.php","--daemon" -WorkingDirectory $backendDir `
    -NoNewWindow -Wait -RedirectStandardOutput (Join-Path $logDir "gsm-ingest.log") -RedirectStandardError (Join-Path $logDir "gsm-ingest.err.log")
