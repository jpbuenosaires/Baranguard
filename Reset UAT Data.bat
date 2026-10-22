@echo off
title Baranguard - Reset UAT / demo / eval data
REM Rebuilds baranguard_uiseed (simulated Dao data, 67 incidents from Sep 1 to today). Takes 1-2 minutes.
REM Run it before EACH tester's session: the scenarios change the data.
"C:\Program Files\Git\bin\bash.exe" "%~dp0backend\scripts\reset-uiseed.sh"
echo.
echo Reset exited with code %ERRORLEVEL%.
pause
