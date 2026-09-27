@echo off
title Baranguard - Starting...
REM Called by full path, not just "powershell" -- this machine's system
REM PATH is missing C:\Windows\System32\WindowsPowerShell\v1.0\, so a bare
REM "powershell" here silently failed with "not recognized" and the window
REM closed before the script ever ran. %SystemRoot% always resolves
REM regardless of PATH.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\scripts\start-baranguard.ps1"
echo.
echo start-baranguard.ps1 exited with code %ERRORLEVEL%.
pause
