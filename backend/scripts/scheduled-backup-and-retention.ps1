# Baranguard - Task Scheduler entry point for the DAILY backup +
# retention job (Sprint 8's C2: "nothing is scheduled" -- REMAINING.md
# section C, docs/REMAINING.md's "Current priority" item 2).
#
# Does two things in order, each independently safe to fail without
# blocking the other from being tried:
#   1. backend/scripts/backup.sh   -- fresh encrypted backup + prunes old
#      backup FILES past BACKUP_RETENTION_DAYS (legal-hold-aware, fails
#      closed -- see that script's own header).
#   2. backend/scripts/retention-job.php (no --dry-run) -- purges DB ROWS
#      past their section 11 retention period (legal-hold-aware). This is
#      REAL, IRREVERSIBLE deletion by design -- retention-job.php's own
#      header explains why an unattended daily run is the intended
#      steady state once the FIRST run on a given database has been
#      reviewed by hand (a --dry-run was run and read before this task
#      was ever registered -- see DEVLOG 2026-09-26 (35)/(36)).
#
# backup.sh/restore-drill.sh are plain bash scripts that read
# DB_*/BACKUP_ENCRYPTION_PASSPHRASE from the PROCESS environment (they
# don't source backend/.env themselves) -- this wrapper reads exactly
# those keys out of backend/.env with a targeted grep (never a blanket
# `set -a; . .env`, which inverts config/env.php's own "already-set env
# var wins" precedence rule -- see docs/REFERENCE.md section 8) and passes
# them through explicitly.
#
# Not meant to be run by hand day-to-day (though it's safe to -- both
# underlying scripts are idempotent/safe to re-run per their own docs).
# Registered by install-scheduled-backup-jobs.ps1.

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $backendDir ".env"
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("backup-retention-{0}.log" -f (Get-Date -Format "yyyyMMdd'T'HHmmss"))

function Get-EnvValue($key) {
    if (-not (Test-Path $envFile)) { return $null }
    $line = Select-String -Path $envFile -Pattern "^\s*$key\s*=(.*)$" | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
    return $null
}

$dbHost = Get-EnvValue "DB_HOST"
$dbPort = Get-EnvValue "DB_PORT"
$dbName = Get-EnvValue "DB_NAME"
$dbUser = Get-EnvValue "DB_USER"
$dbPassword = Get-EnvValue "DB_PASSWORD"
$passphrase = Get-EnvValue "BACKUP_ENCRYPTION_PASSPHRASE"

"=== Baranguard scheduled backup + retention -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append

if (-not $passphrase) {
    "[FAIL] BACKUP_ENCRYPTION_PASSPHRASE not found in backend\.env -- backup skipped." | Tee-Object -FilePath $logFile -Append
} else {
    $bashExe = "C:\Program Files\Git\bin\bash.exe"
    if (-not (Test-Path $bashExe)) { $bashExe = "bash" }
    $env:DB_HOST = $dbHost
    $env:DB_PORT = $dbPort
    $env:DB_NAME = $dbName
    $env:DB_USER = $dbUser
    $env:DB_PASSWORD = $dbPassword
    $env:BACKUP_ENCRYPTION_PASSPHRASE = $passphrase
    "--- backup.sh ---" | Tee-Object -FilePath $logFile -Append
    & $bashExe "scripts/backup.sh" 2>&1 | Tee-Object -FilePath $logFile -Append
    "backup.sh exit code: $LASTEXITCODE" | Tee-Object -FilePath $logFile -Append
}

$phpExe = (Get-Command php.exe -ErrorAction SilentlyContinue).Source
if (-not $phpExe) { $phpExe = "C:\xampp\php\php.exe" }
"--- retention-job.php ---" | Tee-Object -FilePath $logFile -Append
Push-Location $backendDir
& $phpExe "scripts\retention-job.php" 2>&1 | Tee-Object -FilePath $logFile -Append
"retention-job.php exit code: $LASTEXITCODE" | Tee-Object -FilePath $logFile -Append
Pop-Location

"=== Done -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append
