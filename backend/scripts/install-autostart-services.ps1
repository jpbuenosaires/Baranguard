# Baranguard - installs Apache, MariaDB, the Cloudflare tunnel, and the
# AI job worker so all four start automatically on boot and survive a
# reboot without anyone manually clicking "Start" in the XAMPP Control
# Panel, re-running `cloudflared tunnel run` by hand, or remembering to
# launch `ai-worker.php --daemon` themselves.
#
# Hit the first three gaps directly in a real session: Apache, MySQL, and
# the tunnel were all down after this workstation restarted, none of them
# registered as a Windows service. Hit the fourth in a separate real
# session: a user asked "why is my redaction not processing" and the
# answer was simply that nobody had started the AI worker at all -- there
# was no autostart for it, so every reboot silently stopped AI processing
# until a human noticed and ran the command by hand. This script fixes
# all four at once.
#
# The AI worker (step 4 below) runs as a Scheduled Task, not a native
# Windows service -- PHP has no built-in service wrapper the way
# httpd.exe/mysqld.exe/cloudflared do, and a Scheduled Task set to run
# "At startup" as SYSTEM with its own restart-on-failure policy gives the
# same practical guarantee (starts with no login required, restarts
# itself if it ever exits) without a third-party service-wrapper tool.
#
# MUST be run from an ELEVATED (Administrator) PowerShell prompt -
# installing a Windows service needs SCM access a normal user session
# doesn't have. Right-click PowerShell -> "Run as administrator", then:
#   powershell -ExecutionPolicy Bypass -File backend\scripts\install-autostart-services.ps1
#
# Idempotent: checks each service's existing state before acting, safe
# to re-run. Prints a pass/fail line per step, same convention as
# backend/scripts/bootstrap-db.sh.
#
# To UNDO this later (see the end of this file for the full cheat-sheet):
#   C:\xampp\apache\bin\httpd.exe -k uninstall -n "Apache2.4"
#   C:\xampp\mysql\bin\mysqld.exe --remove MySQL
#   cloudflared service uninstall

$ErrorActionPreference = "Stop"
$pass = 0
$fail = 0

function Write-Pass($msg) { Write-Host "[OK]   $msg" -ForegroundColor Green; $script:pass++ }
function Write-Info($msg) { Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; $script:fail++ }
function Write-Step($msg) { Write-Host ""; Write-Host "=== $msg ===" -ForegroundColor Yellow }

Write-Host "Baranguard local-service autostart install - $([DateTime]::UtcNow.ToString('o'))"

Write-Step "0. Confirm running as Administrator"
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Fail "Not running as Administrator. Re-launch PowerShell with 'Run as administrator' and try again."
    exit 1
}
Write-Pass "Running elevated"

Write-Step "1. Apache (Apache2.4 service)"
$apacheSvc = Get-Service -Name "Apache2.4" -ErrorAction SilentlyContinue
if ($apacheSvc) {
    Write-Info "Service 'Apache2.4' already installed (status: $($apacheSvc.Status))"
} else {
    $httpd = "C:\xampp\apache\bin\httpd.exe"
    if (-not (Test-Path $httpd)) {
        Write-Fail "$httpd not found - is XAMPP installed at C:\xampp?"
    } else {
        & $httpd -k install -n "Apache2.4"
        if ($LASTEXITCODE -eq 0) { Write-Pass "Installed Apache2.4 service" } else { Write-Fail "httpd.exe -k install failed (exit $LASTEXITCODE)" }
    }
}
try {
    sc.exe config Apache2.4 start=auto | Out-Null
    Start-Service -Name "Apache2.4" -ErrorAction SilentlyContinue
    Write-Pass "Apache2.4 set to auto-start and running"
} catch {
    Write-Fail "Could not configure/start Apache2.4: $_"
}

Write-Step "2. MariaDB (MySQL service)"
$mysqlSvc = Get-Service -Name "MySQL" -ErrorAction SilentlyContinue
if ($mysqlSvc) {
    Write-Info "Service 'MySQL' already installed (status: $($mysqlSvc.Status))"
} else {
    $mysqld = "C:\xampp\mysql\bin\mysqld.exe"
    $myIni = "C:\xampp\mysql\bin\my.ini"
    if (-not (Test-Path $mysqld)) {
        Write-Fail "$mysqld not found - is XAMPP installed at C:\xampp?"
    } else {
        & $mysqld --install MySQL --defaults-file="$myIni"
        if ($LASTEXITCODE -eq 0) { Write-Pass "Installed MySQL service" } else { Write-Fail "mysqld.exe --install failed (exit $LASTEXITCODE)" }
    }
}
try {
    sc.exe config MySQL start=auto | Out-Null
    Start-Service -Name "MySQL" -ErrorAction SilentlyContinue
    Write-Pass "MySQL set to auto-start and running"
} catch {
    Write-Fail "Could not configure/start MySQL: $_"
}

Write-Step "3. Cloudflare tunnel (cloudflared service)"
$cfSvc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfSvc) {
    Write-Info "Service 'cloudflared' already installed (status: $($cfSvc.Status))"
} else {
    $configPath = "$env:USERPROFILE\.cloudflared\config.yml"
    if (-not (Test-Path $configPath)) {
        Write-Fail "$configPath not found - run backend\scripts\setup-cloudflare-tunnel.sh first (from a non-elevated Git Bash prompt; cloudflared tunnel login needs a normal user's browser session, not an elevated one)."
    } else {
        cloudflared service install
        if ($LASTEXITCODE -eq 0) { Write-Pass "Installed cloudflared service" } else { Write-Fail "cloudflared service install failed (exit $LASTEXITCODE)" }
    }
}
$cfSvcCheck = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfSvcCheck -and $cfSvcCheck.Status -ne "Running") {
    Start-Service -Name "cloudflared" -ErrorAction SilentlyContinue
}
if (Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue) {
    Write-Pass "cloudflared service present"
}

Write-Step "4. AI Worker (Scheduled Task - ai-worker.php --daemon)"
$taskName = "BaranguardAiWorker"
$backendDir = Split-Path -Parent $PSScriptRoot
$workerScript = Join-Path $PSScriptRoot "ai-worker.php"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Info "Scheduled task '$taskName' already registered (state: $($existingTask.State))"
} elseif (-not (Test-Path $workerScript)) {
    Write-Fail "$workerScript not found"
} else {
    $phpCmd = Get-Command php.exe -ErrorAction SilentlyContinue
    $phpExe = if ($phpCmd) { $phpCmd.Source } else { "C:\php-8.3.13\php.exe" }
    if (-not (Test-Path $phpExe)) {
        Write-Fail "Could not find php.exe (not on PATH, and $phpExe doesn't exist) - install PHP or add it to PATH first."
    } else {
        try {
            $action = New-ScheduledTaskAction -Execute $phpExe -Argument "scripts\ai-worker.php --daemon" -WorkingDirectory $backendDir
            $trigger = New-ScheduledTaskTrigger -AtStartup
            # SYSTEM + ServiceAccount logon type: starts with no user login
            # needed, same practical behaviour as Apache2.4/MySQL above.
            $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
            # ExecutionTimeLimit zero: the default 3-day limit would
            # otherwise forcibly kill a daemon that's SUPPOSED to run
            # forever. RestartCount/RestartInterval: the daemon's own loop
            # (ai-worker.php, fixed 2026-09-26) now survives Ollama being
            # down or crash-looping on its own, so this restart policy is
            # the safety net for anything else (e.g. MySQL not up yet the
            # instant this task fires at boot, before Apache2.4/MySQL above
            # have finished starting) -- not the primary resilience mechanism.
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
                -Description "Baranguard AI job worker - drains ai_processing_log via the local Ollama model. Starts at boot, restarts itself if it ever exits." | Out-Null
            Write-Pass "Registered scheduled task '$taskName' (starts at boot, no login needed, self-restarting)"
        } catch {
            Write-Fail "Could not register scheduled task '$taskName': $_"
        }
    }
}
$taskCheck = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskCheck -and $taskCheck.State -ne "Running") {
    try {
        Start-ScheduledTask -TaskName $taskName
        Write-Pass "Started '$taskName' now too, so it's draining the queue today rather than waiting for the next reboot"
    } catch {
        Write-Fail "Could not start '$taskName' now: $_"
    }
} elseif ($taskCheck) {
    Write-Info "'$taskName' is already running"
}

Write-Host ""
Write-Host "=== Summary: $pass ok, $fail failed ===" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Get-Service -Name Apache2.4, MySQL, cloudflared -ErrorAction SilentlyContinue |
    Format-Table Name, Status, StartType -AutoSize
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue |
    Format-Table TaskName, State -AutoSize

Write-Host ""
Write-Host "To UNDO this later (each also needs an elevated prompt):"
Write-Host '  C:\xampp\apache\bin\httpd.exe -k uninstall -n "Apache2.4"'
Write-Host '  C:\xampp\mysql\bin\mysqld.exe --remove MySQL'
Write-Host '  cloudflared service uninstall'
Write-Host '  Unregister-ScheduledTask -TaskName "BaranguardAiWorker" -Confirm:$false'
Write-Host ""
Write-Host "After this, stop/start Apache2.4/MySQL/cloudflared via Services.msc or 'net stop/start <name>' -- closing the XAMPP Control Panel window no longer stops them (that's the point). Stop/start the AI worker via Task Scheduler or 'Stop-ScheduledTask -TaskName BaranguardAiWorker' / 'Start-ScheduledTask -TaskName BaranguardAiWorker'."

if ($fail -gt 0) { exit 1 }
