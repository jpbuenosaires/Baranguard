# Baranguard - one-click startup, run by double-clicking "Start
# Baranguard.bat" at the repo root. Starts Apache (which now also serves
# the API on :8081 -- see below) and MySQL if not already running, then
# opens the web dashboard in the default browser.
#
# This is a MANUAL launcher -- it does NOT make anything start just
# because the laptop is powered on. For that (no double-click, no login
# even needed), a separate script exists: install-autostart-services.ps1,
# which needs a one-time Administrator prompt to register a Windows
# Scheduled Task. This script needs no elevation at all: it only starts
# ordinary processes under the current user, the same as starting Apache/
# MySQL from the XAMPP Control Panel, minus the manual steps.
#
# Safe to double-click more than once: each piece is skipped if it's
# already running.

# -Quiet: for the Windows-login auto-start (see install-startup-shortcut.ps1).
# Skips opening the browser and the "press any key" wait, and gives the
# machine a moment to finish logging in before touching XAMPP.
param([switch]$Quiet)

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot

Write-Host "Starting Baranguard..."
Write-Host ""
if ($Quiet) { Start-Sleep -Seconds 15 }

# 1. Apache
if (Get-Process httpd -ErrorAction SilentlyContinue) {
    Write-Host "[OK] Apache is already running."
} else {
    Write-Host "Starting Apache..."
    Start-Process -FilePath "C:\xampp\apache_start.bat" -WindowStyle Hidden
    Start-Sleep -Seconds 2
    if (Get-Process httpd -ErrorAction SilentlyContinue) {
        Write-Host "[OK] Apache started."
    } else {
        Write-Host "[!!] Apache did not start -- open the XAMPP Control Panel and check for errors."
    }
}

# 2. MySQL. Checked by the port backend/.env's DB_PORT names, NOT by
# process name: a machine can have an unrelated MySQL (e.g. a MySQL80
# Windows service on 3306) whose mysqld.exe would otherwise make this
# skip starting XAMPP's MariaDB, leaving the API with no database.
$dbPort = 3306
$envFile = Join-Path $backendDir ".env"
if (Test-Path $envFile) {
    $portLine = Select-String -Path $envFile -Pattern '^\s*DB_PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($portLine) { $dbPort = [int]$portLine.Matches[0].Groups[1].Value }
}
function Test-DbListening { [bool](Get-NetTCPConnection -LocalPort $dbPort -State Listen -ErrorAction SilentlyContinue) }
if (Test-DbListening) {
    Write-Host "[OK] MySQL is already running (port $dbPort)."
} else {
    Write-Host "Starting MySQL (port $dbPort)..."
    Start-Process -FilePath "C:\xampp\mysql_start.bat" -WindowStyle Hidden
    Start-Sleep -Seconds 4
    if (Test-DbListening) {
        Write-Host "[OK] MySQL started."
    } else {
        Write-Host "[!!] MySQL did not start -- open the XAMPP Control Panel and check for errors."
    }
}

$phpCmd = Get-Command php.exe -ErrorAction SilentlyContinue
$phpExe = if ($phpCmd) { $phpCmd.Source } else { "C:\xampp\php\php.exe" }

# 3. API server on :8081 -- now served by XAMPP's own Apache via the
# vhost in httpd-vhosts.conf (DocumentRoot backend/public), now that
# XAMPP's php.exe was upgraded to 8.3.13 (2026-09-27, was 8.0.30 and
# couldn't load the backend's 8.1+ `readonly` properties). Apache step 1
# above starts this together with :80; this is just a listen check, no
# separate process to launch. The web dashboard (from localhost) and the
# Cloudflare tunnel's api.baranguardph.win ingress both expect it here.
if (Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "[OK] API server (port 8081) is up."
} else {
    Write-Host "[!!] API server (port 8081) is not listening -- check C:\xampp\apache\conf\extra\httpd-vhosts.conf and Apache's error log."
}

# 4. Cloudflare tunnel (C-03) -- fronts baranguardph.win/api.baranguardph.win
# on this machine's real, DNS-registered tunnel ("baranguard", not the
# separate "baranguard-main" tunnel some other machine may have; whichever
# tunnel this machine's own ~/.cloudflared/config.yml names is what's
# routed here -- see docs/REFERENCE.md SS1 for why more than one tunnel can
# exist on the account at once). If the tunnel is already installed as a
# real Windows service (backend/scripts/install-autostart-services.ps1,
# needs a one-time elevated prompt), that service is authoritative and
# survives a reboot on its own -- this step only fills the gap for a
# machine that hasn't run that yet, the same "ordinary user process, no
# admin needed" spirit as Apache/MySQL above. Not proof the
# tunnel is public-reachable (that needs a real HTTP round-trip from
# outside), just that the local connector process is up.
$cfSvc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfSvc) {
    if ($cfSvc.Status -eq "Running") {
        Write-Host "[OK] Cloudflare tunnel is running as a Windows service."
    } else {
        Write-Host "[!!] Cloudflare tunnel service 'cloudflared' exists but is not running (status: $($cfSvc.Status)) -- start it from Services.msc or an elevated 'Start-Service cloudflared'."
    }
} else {
    $cfProc = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
    if ($cfProc) {
        Write-Host "[OK] Cloudflare tunnel is already running (PID $($cfProc[0].ProcessId))."
    } else {
        $cfCmd = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
        $cfExe = if ($cfCmd) {
            $cfCmd.Source
        } else {
            @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe") |
                Where-Object { Test-Path $_ } | Select-Object -First 1
        }
        $cfConfig = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
        if (-not $cfExe) {
            Write-Host "[!!] cloudflared is not installed -- the tunnel is not running, so baranguardph.win/api.baranguardph.win won't reach this machine. Install it (winget install --id Cloudflare.cloudflared -e), or ignore this if C-03 isn't in use yet."
        } elseif (-not (Test-Path $cfConfig)) {
            Write-Host "[!!] cloudflared is installed but $cfConfig is missing -- run backend\scripts\setup-cloudflare-tunnel.sh from a non-elevated Git Bash prompt first."
        } else {
            Write-Host "Starting Cloudflare tunnel..."
            Start-Process -FilePath $cfExe -ArgumentList "tunnel","run" -WindowStyle Hidden
            Start-Sleep -Seconds 2
            if (Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue) {
                Write-Host "[OK] Cloudflare tunnel started."
            } else {
                Write-Host "[!!] Cloudflare tunnel did not start -- check $cfConfig and this machine's Cloudflare authorization (~/.cloudflared/cert.pem)."
            }
        }
    }
}

# 4b. Background workers the safety paths depend on. Each is skipped when it
# is already running (or, for the two scheduled ones, already registered as a
# Task Scheduler task by install-scheduled-backup-jobs.ps1), so this is safe
# to click twice and never doubles up. The ingest daemon also holds a lock
# file, so a second copy exits on its own.
$backendRoot = Split-Path -Parent $PSScriptRoot
function Start-BaranguardWorker($label, $script, $argsList, $taskName) {
    if ($taskName -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Write-Host "[OK] $label is run by Scheduled Task '$taskName'."
        return
    }
    $running = Get-CimInstance Win32_Process -Filter "Name = 'php.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$script*" }
    if ($running) {
        Write-Host "[OK] $label is already running."
        return
    }
    Start-Process -FilePath $phpExe -ArgumentList (@("scripts\$script") + $argsList) -WorkingDirectory $backendRoot -WindowStyle Hidden
    Write-Host "[OK] $label started."
}
Start-BaranguardWorker "GSM inbound daemon (SOS-by-SMS, inbound texts)" "gsm-ingest-daemon.php" @("--daemon") "BaranguardGsmIngest"
Start-BaranguardWorker "Notification worker (SOS re-alert, ack timeout, SMS outbox)" "notification-worker.php" @("--daemon") "BaranguardNotificationWorker"
Start-BaranguardWorker "Dispatch offer sweeper" "dispatch-offer-sweeper.php" @("--daemon") "BaranguardDispatchOfferSweeper"

if ($Quiet) {
    Write-Host ""
    Write-Host "Done (quiet start)."
    exit 0
}

# 5. Open the dashboard
Write-Host ""
Write-Host "Opening the dashboard..."
Start-Sleep -Seconds 1
Start-Process "http://localhost/baranguard/web/"

Write-Host ""
Write-Host "Done. Press any key to close this window..."
# Stays open until dismissed -- the old fixed 3-second Start-Sleep closed
# before anyone could read the checklist above, especially the [!!] lines
# that only show up when something didn't start. ReadKey needs a real
# console; falls back to a longer sleep if this ever runs somewhere
# without one (e.g. launched non-interactively) so it can't hang forever.
try {
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
} catch {
    Start-Sleep -Seconds 20
}
