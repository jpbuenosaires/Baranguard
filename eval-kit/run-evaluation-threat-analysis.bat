@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  Baranguard AI Evaluation - Task 7/7: Analyzing incident patterns
echo ============================================
echo.
echo This tests how well the AI describes incident-count patterns without
echo making up numbers that weren't given to it. Nothing on this computer
echo is sent anywhere - everything runs locally, offline, same as before.
echo.
echo Only run this AFTER run-evaluation.bat has worked at least once -
echo it checks PHP/Ollama the same way, so if that one worked, this will
echo too.
echo.

REM --- 1. Check PHP is installed --------------------------------------
where php >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PHP was not found on this computer.
    echo.
    echo Please install it first - open Command Prompt and run:
    echo     winget install PHP.PHP
    echo Then close this window and double-click this file again.
    echo.
    pause
    exit /b 1
)

REM --- 2. Check .env exists (run-evaluation.bat creates it first) -----
if not exist ".env" (
    echo [ERROR] No ".env" file found yet.
    echo.
    echo Please run run-evaluation.bat first - it sets this up for you.
    echo.
    pause
    exit /b 1
)

REM --- Read OLLAMA_URL / OLLAMA_MODEL out of .env ----------------------
set "OLLAMA_URL_VAL="
set "OLLAMA_MODEL_VAL="
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    set "envkey=%%A"
    if not "!envkey:~0,1!"=="#" (
        if "%%A"=="OLLAMA_URL" set "OLLAMA_URL_VAL=%%B"
        if "%%A"=="OLLAMA_MODEL" set "OLLAMA_MODEL_VAL=%%B"
    )
)
if "%OLLAMA_URL_VAL%"=="" set "OLLAMA_URL_VAL=http://127.0.0.1:11434"

REM --- 3. Check Ollama is reachable and the model is pulled -----------
echo Checking that Ollama is running...
curl --connect-timeout 3 -s "%OLLAMA_URL_VAL%/api/tags" > "%TEMP%\baranguard_ollama_check.json" 2>nul
if errorlevel 1 goto :ollama_not_running

findstr /c:"%OLLAMA_MODEL_VAL%" "%TEMP%\baranguard_ollama_check.json" >nul
if errorlevel 1 (
    echo [ERROR] Ollama is running, but the model "%OLLAMA_MODEL_VAL%" is not pulled yet.
    echo.
    echo Open Command Prompt and run:
    echo     ollama pull %OLLAMA_MODEL_VAL%
    echo Then run this file again.
    echo.
    del "%TEMP%\baranguard_ollama_check.json" >nul 2>nul
    pause
    exit /b 1
)
del "%TEMP%\baranguard_ollama_check.json" >nul 2>nul
echo Ollama is running and the model is ready.
echo.
goto :smoke_test

:ollama_not_running
echo [ERROR] Could not reach Ollama at %OLLAMA_URL_VAL%.
echo.
echo Make sure Ollama is installed and running - it usually starts
echo automatically after installing (look for its icon in the system
echo tray near the clock). If it's not there, open "Ollama" from the
echo Start menu, then run this file again.
echo.
pause
exit /b 1

REM --- 4. Already have progress from an earlier run? Skip straight to  --
REM        resuming it automatically - no smoke test, no confirmation   --
REM        prompt, so closing this window and double-clicking the file  --
REM        again later just continues unattended.                      --
set "HAS_PROGRESS="
if exist "fixtures\eval-threat-stats-v1.threat-analysis.model.*.checkpoint.json" set "HAS_PROGRESS=1"
if defined HAS_PROGRESS (
    echo Found progress from an earlier run of this task - continuing
    echo automatically from where it left off...
    echo.
    goto :run_full
)

REM --- 5. Quick 1-record smoke test -------------------------------------
REM        --resume here too: without it, this would write its OWN     --
REM        1-record checkpoint on top of the real one and wipe out any  --
REM        existing progress. Harmless on a truly fresh run.            --
:smoke_test
echo Running a quick 1-record check first (about half a minute)...
echo.
php scripts\ai-evaluate.php --task=threat-analysis --engine=model --limit=1 --dry-run --verbose --resume
if errorlevel 1 (
    echo.
    echo [ERROR] The quick check above failed. Nothing else was run.
    echo If you're stuck, send a screenshot of this window.
    echo.
    pause
    exit /b 1
)
echo.
echo The quick check worked.
echo.

echo ============================================
echo Ready to run the full 25-record pattern-analysis test.
echo.
echo This set is much smaller than the others (25 records, not 350) - it
echo should finish in well under half an hour.
echo.
echo You can safely close this window at any point. Just double-click
echo this file again later - it picks up exactly where it left off
echo AUTOMATICALLY (no need to click through this message again), without
echo repeating work or affecting the other 6 tasks at all.
echo ============================================
echo.
pause

:run_full
php scripts\ai-evaluate.php --task=threat-analysis --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=60 --resume --save-results

echo.
echo ============================================
echo If you see an error above about Ollama being unavailable partway
echo through, that's fine - just run this file again and it'll pick up
echo from exactly where it left off.
echo.
echo When it finishes, please send back these two files from this
echo folder's "fixtures" subfolder:
echo   evaluation-results-threat-analysis-*.txt
echo   evaluation-log-threat-analysis-*.txt
echo.
echo Thank you for helping with this!
echo ============================================
pause
