# Baranguard - registers the Scheduled Tasks C2 box asks for ("nothing
# is scheduled" -- docs/REMAINING.md section C / "Current priority" item
# 2), paired with a real B3 restore-drill run (backend/DEVLOG.md
# 2026-09-26 (35)), plus the periodic PB digest (section G, (37)) since
# it's the same "needs a Scheduled Task" shape.
#
#   BaranguardBackupRetention  daily 02:00      -> scheduled-backup-and-retention.ps1
#   BaranguardRestoreDrill     weekly Sun 03:00 -> scheduled-restore-drill.ps1
#   BaranguardPbDigest         weekly Mon 06:00 -> scheduled-pb-digest.ps1 (7-day
#                              window, so each digest's range starts exactly where
#                              the previous one's ended)
#
# Deliberately NOT elevated / NOT SYSTEM, unlike install-autostart-
# services.ps1's AI-worker task. Both underlying scripts need
# backend/.env (ordinary file permissions, no special access) and the
# workstation is already required to stay logged in and never sleep
# (docs/SETUP.md 1.7's "must never sleep" note) for the 15-minute JWT
# polling to work at all -- so "only run while logged on", the default
# for a task registered without -Principal, is the correct, simpler
# choice here, and needs no Administrator prompt. Confirmed a bare
# Register-ScheduledTask call succeeds without elevation on this machine
# before writing this script (2026-09-26).
#
# Idempotent: re-registers (Unregister then Register) if a task with the
# same name already exists, same convention as install-autostart-
# services.ps1.
#
# Usage (ordinary PowerShell prompt, no "Run as administrator" needed):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\install-scheduled-backup-jobs.ps1

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot
$pass = 0
$fail = 0

function Write-Pass($msg) { Write-Host "[OK]   $msg" -ForegroundColor Green; $script:pass++ }
function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:fail++ }
function Write-Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Yellow }

function Install-BaranguardTask($taskName, $scriptName, $trigger) {
    $scriptPath = Join-Path $backendDir "scripts\$scriptName"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" `
        -WorkingDirectory $backendDir
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)

    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Info "Task '$taskName' already exists -- re-registering to pick up any changes."
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -ErrorAction Stop | Out-Null
        Write-Pass "Registered '$taskName'."
    } catch {
        Write-Fail "Could not register '$taskName': $($_.Exception.Message)"
    }
}

Write-Step "1. Daily backup + retention (02:00)"
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At "02:00"
Install-BaranguardTask "BaranguardBackupRetention" "scheduled-backup-and-retention.ps1" $dailyTrigger

Write-Step "2. Weekly restore drill (Sunday 03:00)"
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At "03:00"
Install-BaranguardTask "BaranguardRestoreDrill" "scheduled-restore-drill.ps1" $weeklyTrigger

Write-Step "3. Weekly PB digest (Monday 06:00)"
$digestTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "06:00"
Install-BaranguardTask "BaranguardPbDigest" "scheduled-pb-digest.ps1" $digestTrigger

Write-Step "Summary"
Get-ScheduledTask -TaskName "BaranguardBackupRetention", "BaranguardRestoreDrill", "BaranguardPbDigest" -ErrorAction SilentlyContinue |
    Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "$pass passed, $fail failed."
Write-Host ""
Write-Host "Logs land in backend\backups\scheduled-logs\. To run any job right now instead of waiting:"
Write-Host '  Start-ScheduledTask -TaskName "BaranguardBackupRetention"'
Write-Host '  Start-ScheduledTask -TaskName "BaranguardRestoreDrill"'
Write-Host '  Start-ScheduledTask -TaskName "BaranguardPbDigest"'
Write-Host "To remove any task:"
Write-Host '  Unregister-ScheduledTask -TaskName "BaranguardBackupRetention" -Confirm:$false'
Write-Host '  Unregister-ScheduledTask -TaskName "BaranguardRestoreDrill" -Confirm:$false'
Write-Host '  Unregister-ScheduledTask -TaskName "BaranguardPbDigest" -Confirm:$false'
Write-Host ""
Write-Host "These only run while a user is logged on (no elevation was needed to register" -ForegroundColor Yellow
Write-Host "them) -- matches this project's existing 'the dispatch PC must never sleep'" -ForegroundColor Yellow
Write-Host "requirement (docs/SETUP.md 1.7). If this workstation is ever set up to log" -ForegroundColor Yellow
Write-Host "off overnight, these tasks would need re-registering with a stored-credential" -ForegroundColor Yellow
Write-Host "principal instead, which DOES need an elevated prompt." -ForegroundColor Yellow
