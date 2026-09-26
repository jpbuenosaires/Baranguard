# Baranguard - one-click startup, run by double-clicking "Start
# Baranguard.bat" at the repo root. Starts Apache (which now also serves
# the API on :8081 -- see below) and MySQL if not already running, starts
# the AI worker daemon if not already running, then opens the web
# dashboard in the default browser.
#
# This is a MANUAL launcher -- it does NOT make anything start just
# because the laptop is powered on. For that (no double-click, no login
# even needed), a separate script exists: install-autostart-services.ps1,
# which needs a one-time Administrator prompt to register a Windows
# Scheduled Task. This script needs no elevation at all: it only starts
# ordinary processes under the current user, the same as starting Apache/
# MySQL from the XAMPP Control Panel and running ai-worker.php by hand,
# minus the manual steps.
#
# Safe to double-click more than once: each piece is skipped if it's
# already running, so this never starts a second AI worker daemon
# racing the first one over the same queue (AiJobQueue::
# requeueStaleProcessing()'s own doc explains why two workers isn't safe
# on this schema without a claimed_at column).

$ErrorActionPreference = "Continue"
$backendDir = Split-Path -Parent $PSScriptRoot

function Test-AiWorkerRunning {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'php.exe'" -ErrorAction SilentlyContinue
    return [bool]($procs | Where-Object { $_.CommandLine -like "*ai-worker.php*--daemon*" })
}

Write-Host "Starting Baranguard..."
Write-Host ""

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

# 4. AI worker daemon
if (Test-AiWorkerRunning) {
    Write-Host "[OK] AI worker is already running."
} else {
    Write-Host "Starting AI worker..."
    if (Test-Path $phpExe) {
        Start-Process -FilePath $phpExe -ArgumentList "scripts\ai-worker.php","--daemon" -WorkingDirectory $backendDir -WindowStyle Hidden
        Write-Host "[OK] AI worker started."
    } else {
        Write-Host "[!!] Could not find php.exe -- AI redaction/summary jobs will sit queued until this is fixed."
    }
}

# 5. Open the dashboard
Write-Host ""
Write-Host "Opening the dashboard..."
Start-Sleep -Seconds 1
Start-Process "http://localhost/baranguard/web/"

Write-Host ""
Write-Host "Done. This window will close in a few seconds."
Start-Sleep -Seconds 3
