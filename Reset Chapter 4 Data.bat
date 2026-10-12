@echo off
title Baranguard - Reset Chapter 4 test data
REM Rebuilds the simulated Chapter 4 database (baranguard_ch4, Barangay Dao only)
REM and points the app at it. Run before each test session. Called by full path
REM because this machine's PATH is missing the PowerShell folder.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\scripts\reset-ch4.ps1" -PointAppTo ch4
echo.
echo reset-ch4.ps1 exited with code %ERRORLEVEL%.
pause
