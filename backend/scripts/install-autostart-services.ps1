# Baranguard - installs Apache, MariaDB, and the Cloudflare tunnel as
# real Windows services, so all three start automatically on boot and
# survive a reboot without anyone manually clicking "Start" in the XAMPP
# Control Panel or re-running `cloudflared tunnel run` by hand.
#
# Hit this gap directly in a real session: Apache, MySQL, and the tunnel
# were all down after this workstation restarted, none of them
# registered as a Windows service. This script fixes that once.
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

Write-Host ""
Write-Host "=== Summary: $pass ok, $fail failed ===" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
Get-Service -Name Apache2.4, MySQL, cloudflared -ErrorAction SilentlyContinue |
    Format-Table Name, Status, StartType -AutoSize

Write-Host ""
Write-Host "To UNDO this later (each also needs an elevated prompt):"
Write-Host '  C:\xampp\apache\bin\httpd.exe -k uninstall -n "Apache2.4"'
Write-Host '  C:\xampp\mysql\bin\mysqld.exe --remove MySQL'
Write-Host '  cloudflared service uninstall'
Write-Host ""
Write-Host "After this, stop/start these via Services.msc or 'net stop/start <name>' -- closing the XAMPP Control Panel window no longer stops them (that's the point)."

if ($fail -gt 0) { exit 1 }
