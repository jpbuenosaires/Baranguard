# Baranguard - Task Scheduler entry point for the WEEKLY restore drill
# (Sprint 8's B3, paired with C2's daily backup+retention job --
# docs/REMAINING.md section B / "Current priority" item 2).
#
# Runs backend/scripts/restore-drill.sh for real once a week: takes a
# fresh backup, restores it into a disposable *_drill database, and
# fingerprint-compares it against the live database (table counts, row
# counts, FK count) -- the check that answers "can I actually recover
# from today's backup", not just "did a file get written." Non-
# destructive by construction (restore-drill.sh's own doc explains why);
# updates backend/backups/.last-restore-drill, which is what
# GET /system/health's restore_test_at / W20 Service Health display.
#
# Same targeted-env-read approach as scheduled-backup-and-retention.ps1
# (never a blanket `set -a; . .env` -- see that script's own comment).

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $backendDir ".env"
$logDir = Join-Path $backendDir "backups\scheduled-logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("restore-drill-{0}.log" -f (Get-Date -Format "yyyyMMdd'T'HHmmss"))

function Get-EnvValue($key) {
    if (-not (Test-Path $envFile)) { return $null }
    $line = Select-String -Path $envFile -Pattern "^\s*$key\s*=(.*)$" | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
    return $null
}

$passphrase = Get-EnvValue "BACKUP_ENCRYPTION_PASSPHRASE"

"=== Baranguard scheduled restore drill -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append

if (-not $passphrase) {
    "[FAIL] BACKUP_ENCRYPTION_PASSPHRASE not found in backend\.env -- drill skipped." | Tee-Object -FilePath $logFile -Append
} else {
    $bashExe = "C:\Program Files\Git\bin\bash.exe"
    if (-not (Test-Path $bashExe)) { $bashExe = "bash" }
    $env:BACKUP_ENCRYPTION_PASSPHRASE = $passphrase
    Push-Location $backendDir
    & $bashExe "scripts/restore-drill.sh" 2>&1 | Tee-Object -FilePath $logFile -Append
    "restore-drill.sh exit code: $LASTEXITCODE" | Tee-Object -FilePath $logFile -Append
    Pop-Location
}

"=== Done -- $(Get-Date -Format o) ===" | Tee-Object -FilePath $logFile -Append
