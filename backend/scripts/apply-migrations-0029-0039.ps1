# Baranguard - applies migrations 0029..0039 to ONE database, after taking a
# backup. Run from a normal PowerShell prompt in the repo root:
#   powershell -ExecutionPolicy Bypass -File backend\scripts\apply-migrations-0029-0039.ps1 -Database baranguard_uiseed
# It asks for the MySQL root password (typed, never stored). Stops at the first
# error. NOT safe to re-run on a database that already has some of these
# applied: 0029 drops the blotter/AI tables for good, and the others add
# columns/tables that already exist -> check first with -DryRun.

param(
    [Parameter(Mandatory = $true)][string]$Database,
    [string]$DbUser = "root",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$mysql = "C:\xampp\mysql\bin\mysql.exe"
$dump = "C:\xampp\mysql\bin\mysqldump.exe"
$migDir = Join-Path (Split-Path -Parent $PSScriptRoot) "migrations"
$backupDir = Join-Path (Split-Path -Parent $PSScriptRoot) "backups"
$files = Get-ChildItem $migDir -Filter "00*.sql" |
    Where-Object { $_.Name -notlike "*.down.sql" -and [int]($_.Name.Substring(0,4)) -ge 29 -and [int]($_.Name.Substring(0,4)) -le 39 } |
    Sort-Object Name

Write-Host "Database : $Database"
Write-Host "Migrations to apply, in order:"
$files | ForEach-Object { Write-Host "  $($_.Name)" }
if ($DryRun) { Write-Host "(dry run - nothing done)"; exit 0 }

$cred = Read-Host "MySQL password for '$DbUser' (blank if none)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred))
$passArg = if ($plain) { "-p$plain" } else { $null }
$base = @("-u", $DbUser) + @($passArg | Where-Object { $_ })

$answer = Read-Host "This changes '$Database' (0029 drops blotter/AI tables permanently). A backup is taken first. Type YES to continue"
if ($answer -ne "YES") { Write-Host "Cancelled."; exit 1 }

New-Item -ItemType Directory -Force $backupDir | Out-Null
$stamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$bak = Join-Path $backupDir "pre-migrate-$Database-$stamp.sql"
& $dump @base --single-transaction --routines $Database "--result-file=$bak"
if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] Backup failed - nothing was changed."; exit 1 }
Write-Host "[OK] Backup: $bak"

foreach ($f in $files) {
    Write-Host "Applying $($f.Name) ..."
    Get-Content $f.FullName -Raw | & $mysql @base $Database
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] $($f.Name) failed. Stopped. Restore from $bak if needed."
        exit 1
    }
    Write-Host "[OK]   $($f.Name)"
}
Write-Host "All migrations applied. Reload the dashboard."
