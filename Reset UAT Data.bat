@echo off
title Baranguard - Reset UAT / final-evaluation data
REM Rebuilds the simulated UAT database (baranguard_uat, Barangay Dao only) and points the
REM app at it. Run it before EACH tester's session: the scenarios change the data
REM (dispatches, resolved incidents, submitted reports), so every tester starts from the same state.
REM Called by full path because this machine's PATH is missing the PowerShell folder.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\scripts\reset-ch4.ps1" -Profile uat -PointAppTo uat
echo.
echo reset-ch4.ps1 exited with code %ERRORLEVEL%.
pause
