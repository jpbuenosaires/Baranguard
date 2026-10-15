# Baranguard - resets the Chapter 4 test database (SIMULATED data, Barangay Dao only).
#
# Drops and rebuilds the database `baranguard_ch4` from scratch: applies every
# migration, then loads backend\scripts\seed-ch4.php. Run it before each test
# session so the next tester starts from the same clean data. It only ever
# touches a database named exactly "baranguard_ch4" - never `baranguard` or
# `baranguard_uiseed`.
#
# -Profile uat builds the FINAL-TESTING database `baranguard_uat` instead (same simulated
# Dao data plus the fixtures the UAT sign-off scenarios need; docs/UAT_DATA_REQUIREMENTS.md).
# Normally via "Reset UAT Data.bat". It likewise only ever touches its own database.
#
# Usage (normally via "Reset Chapter 4 Data.bat" at the repo root):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\reset-ch4.ps1
#   ... -PointAppTo ch4        make backend\.env use baranguard_ch4 (backs .env up first)
#   ... -PointAppTo uiseed     put backend\.env back on baranguard_uiseed
#   ... -Yes                   skip the "type RESET" prompt
#   ... -Days 30 -Seed 2026    window length / random seed passed to the seed script
#
# MySQL root: tries no password first (XAMPP default), then asks. The password is
# only passed to the child processes through environment variables, never written down.

param(
    [switch]$Yes,
    [ValidateSet("", "ch4", "uat", "uiseed")][string]$PointAppTo = "",
    [ValidateSet("ch4", "uat")][string]$Profile = "ch4",
    # With -Profile uat: build into baranguard_uiseed (the project's one test database) instead of baranguard_uat.
    [ValidateSet("", "uiseed")][string]$TargetDb = "",
    [int]$Days = 30,
    [int]$Seed = 2026
)

$ErrorActionPreference = "Stop"
# Keep a log next to the other runtime files so a failed run can be diagnosed afterwards.
try { $logDir = Join-Path (Split-Path -Parent $PSScriptRoot) "storage"; if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }; Start-Transcript -Path (Join-Path $logDir "ch4-reset.log") -Force | Out-Null } catch { }
trap { Write-Host "[FAIL] $($_.Exception.Message)"; try { Stop-Transcript | Out-Null } catch { }; exit 1 }
$DbName = if ($Profile -eq "uat") { if ($TargetDb -eq "uiseed") { "baranguard_uiseed" } else { "baranguard_uat" } } else { "baranguard_ch4" }
if ($TargetDb -eq "uiseed" -and $Profile -ne "uat") { Write-Host "[FAIL] -TargetDb uiseed only works with -Profile uat."; exit 1 }
$scriptDir = $PSScriptRoot
$backendDir = Split-Path -Parent $scriptDir
$migDir = Join-Path $backendDir "migrations"
$envFile = Join-Path $backendDir ".env"
$mysql = "C:\xampp\mysql\bin\mysql.exe"
$php = "C:\xampp\php\php.exe"
if (-not (Test-Path $mysql)) { Write-Host "[FAIL] $mysql not found - is XAMPP installed at C:\xampp?"; exit 1 }
if (-not (Test-Path $php)) { $cmd = Get-Command php.exe -ErrorAction SilentlyContinue; if ($cmd) { $php = $cmd.Source } else { Write-Host "[FAIL] php.exe not found."; exit 1 } }

function Get-EnvValue([string]$name, [string]$default) {
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern ("^\s*" + $name + "\s*=\s*(.*)$") | Select-Object -First 1
        if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
    }
    return $default
}

function Set-AppDatabase([string]$target) {
    if (-not (Test-Path $envFile)) { Write-Host "[FAIL] $envFile not found."; exit 1 }
    $bak = "$envFile.bak-before-ch4"
    if (-not (Test-Path $bak)) { Copy-Item $envFile $bak; Write-Host "[OK] Backed up .env to $bak" }
    $newName = switch ($target) { "ch4" { "baranguard_ch4" } "uat" { "baranguard_uat" } "db" { $DbName } default { "baranguard_uiseed" } }
    $text = Get-Content $envFile -Raw
    if ($text -notmatch "(?m)^\s*DB_NAME\s*=") { Write-Host "[FAIL] DB_NAME not found in .env"; exit 1 }
    $text = [regex]::Replace($text, "(?m)^(\s*DB_NAME\s*=).*$", ('${1}' + $newName))
    [System.IO.File]::WriteAllText($envFile, $text)
    Write-Host "[OK] backend\.env now uses $newName (no Apache restart needed)."
}

$dbHost = Get-EnvValue "DB_HOST" "127.0.0.1"
$dbPort = Get-EnvValue "DB_PORT" "3306"
$appUser = Get-EnvValue "DB_USER" ""

if ($PointAppTo -eq "uiseed") { Set-AppDatabase "uiseed"; exit 0 }

Write-Host "Reset ($Profile profile) - database $DbName on ${dbHost}:${dbPort}"
if (-not $Yes) {
    $a = Read-Host "This DROPS and rebuilds $DbName (simulated data only). Type RESET to continue"
    if ($a -ne "RESET") { Write-Host "Cancelled."; exit 1 }
}

function Invoke-Mysql([string[]]$extra) {
    & $mysql "-h" $dbHost "-P" $dbPort "-u" "root" @extra | Out-Null
    return $LASTEXITCODE
}

# --- root password: blank first, then ask ---
$env:MYSQL_PWD = ""
$rc = Invoke-Mysql @("-e", "SELECT 1")
if ($rc -ne 0) {
    $sec = Read-Host "MySQL root password" -AsSecureString
    $env:MYSQL_PWD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    $rc = Invoke-Mysql @("-e", "SELECT 1")
    if ($rc -ne 0) { Write-Host "[FAIL] Could not log in to MySQL as root. Is MySQL running (Start Baranguard.bat)?"; exit 1 }
}
Write-Host "[OK] Connected to MySQL"

# --- rebuild the database ---
$rc = Invoke-Mysql @("-e", "DROP DATABASE IF EXISTS ``$DbName``; CREATE DATABASE ``$DbName`` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;")
if ($rc -ne 0) { Write-Host "[FAIL] Could not create $DbName"; exit 1 }
Write-Host "[OK] Fresh empty $DbName"

$files = Get-ChildItem $migDir -Filter "*.sql" | Where-Object { $_.Name -notlike "*.down.sql" } | Sort-Object Name
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)   # send the files to mysql as UTF-8
foreach ($f in $files) {
    Write-Host "  applying $($f.Name) ..."
    Get-Content -Raw -Encoding UTF8 -LiteralPath $f.FullName | & $mysql "-h" $dbHost "-P" $dbPort "-u" "root" "--default-character-set=utf8mb4" $DbName
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] Migration $($f.Name) failed. Stopped."; Stop-Transcript | Out-Null; exit 1 }
}
Write-Host "[OK] Applied $($files.Count) migrations"

# --- let the app's own DB user read/write the new database ---
if ($appUser) {
    $hosts = & $mysql "-h" $dbHost "-P" $dbPort "-u" "root" "-N" "-B" "-e" "SELECT host FROM mysql.user WHERE user='$appUser'"
    foreach ($h in $hosts) {
        if ($h) { $null = Invoke-Mysql @("-e", "GRANT SELECT, INSERT, UPDATE, DELETE ON ``$DbName``.* TO '$appUser'@'$h'; FLUSH PRIVILEGES;") }
    }
    Write-Host "[OK] Granted $appUser access to $DbName"
} else {
    Write-Host "[INFO] No DB_USER in .env - skipped the grant step."
}

# --- seed ---
$env:CH4_DB_USER = "root"
$env:CH4_DB_PASSWORD = $env:MYSQL_PWD
& $php (Join-Path $scriptDir "seed-ch4.php") "--db=$DbName" "--profile=$Profile" "--seed=$Seed" "--days=$Days"
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] Seed script failed."; exit 1 }
$env:MYSQL_PWD = ""; $env:CH4_DB_PASSWORD = ""

if ($PointAppTo -in @("ch4", "uat")) { Set-AppDatabase "db" }
else { Write-Host "[INFO] The app still uses its current database. Re-run with -PointAppTo $Profile to switch backend\.env to $DbName." }
Write-Host ""
Write-Host "Done. Accounts: admin.dao, secretary.dao, punong.dao, tanod.reyes (and 6 more tanods), password Demo@2026"
Write-Host "All data is SIMULATED test data - label it that way in Chapter 4."
