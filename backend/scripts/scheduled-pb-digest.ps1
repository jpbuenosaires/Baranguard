# Baranguard - Task Scheduler entry point for the periodic PB digest (the
# periodic half; the content half is GET /reports/export?format=pdf).
#
# Runs backend/scripts/generate-pb-digest.php (no bash/curl involved,
# unlike the backup/restore-drill wrappers -- this is a pure PHP CLI
# script that already reads backend/.env itself via config/env.php, so
# there's no env-var plumbing to do here).

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("pb-digest-{0}.log" -f (Get-Date -Format "yyyyMMdd'T'HHmmss"))

$phpExe = (Get-Command php.exe -ErrorAction SilentlyContinue).Source
if (-not $phpExe) { $phpExe = "C:\xampp\php\php.exe" }

"=== Baranguard scheduled PB digest -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append
Push-Location $backendDir
& $phpExe "scripts\generate-pb-digest.php" 2>&1 | Tee-Object -FilePath $logFile -Append
"generate-pb-digest.php exit code: $LASTEXITCODE" | Tee-Object -FilePath $logFile -Append
Pop-Location
"=== Done -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append
