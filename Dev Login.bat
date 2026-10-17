@echo off
rem Opens the web dashboard already signed in (localhost only, for UI editing).
rem Creates web\dev-login.local.json (gitignored) on first run; edit it to change user.
rem Needs Apache + MySQL running (use "Start Baranguard.bat" first if not).
setlocal
set "CFG=%~dp0web\dev-login.local.json"
if not exist "%CFG%" (
  > "%CFG%" echo {"username":"admin.dao","password":"Demo@2026"}
  echo Created %CFG%
)
start "" "http://localhost/baranguard/web/?dev_login=1"
endlocal
