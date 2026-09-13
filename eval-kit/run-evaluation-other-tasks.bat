@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  Baranguard AI Evaluation - Other 7 Tasks
echo ============================================
echo.
echo run-evaluation.bat already tests REDACTION (removing personal info) -
echo the most important one. This file tests the other 7 things the same
echo AI model does: writing case summaries, translating records, pulling
echo out complainant/respondent/contact details, classifying incidents,
echo drafting a formal blotter entry, composing SMS alerts, and analyzing
echo incident patterns. Nothing on this computer is sent anywhere -
echo everything runs locally, offline, same as before.
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

REM --- 4. Quick 1-record smoke test (on a task other than redaction, --
REM        since run-evaluation.bat already proved redaction works) ----
:smoke_test
echo Running a quick 1-record check first (about half a minute)...
echo.
php scripts\ai-evaluate.php --task=summary --engine=model --limit=1 --dry-run --verbose
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
echo Ready to run all 7 remaining tasks, one after another.
echo.
echo Five of these (summary, extraction, classification, blotter-assist,
echo translation) run against the same 350-record set as redaction, so
echo expect roughly the SAME LENGTH OF TIME AS THAT RUN, for EACH of the
echo five - this is the biggest ask of the bunch. The last two
echo (sms-compose, threat-analysis) use much smaller sets (35 and 25
echo records) and will finish far faster.
echo.
echo Same as before: you can safely close this window at any point and
echo run this file again later. Each task remembers its own progress
echo separately and picks up exactly where it left off - nothing is
echo redone or lost, and a task that already finished is skipped near-
echo instantly on a re-run.
echo ============================================
echo.
pause

echo.
echo === 1/7: summary ===
php scripts\ai-evaluate.php --task=summary --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo === 2/7: extraction ===
php scripts\ai-evaluate.php --task=extraction --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo === 3/7: classification ===
php scripts\ai-evaluate.php --task=classification --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo === 4/7: blotter-assist ===
php scripts\ai-evaluate.php --task=blotter-assist --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo === 5/7: translation (to Filipino/Tagalog) ===
php scripts\ai-evaluate.php --task=translation --translate-to=fil --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo === 6/7: sms-compose (much smaller, 35 records) ===
php scripts\ai-evaluate.php --task=sms-compose --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=60 --resume --save-results

echo.
echo === 7/7: threat-analysis (much smaller, 25 records) ===
php scripts\ai-evaluate.php --task=threat-analysis --engine=model --dry-run --verbose --batch-size=20 --rest-seconds=60 --resume --save-results

echo.
echo ============================================
echo All 7 tasks attempted. If any one shows an error above about
echo Ollama being unavailable partway through, that's fine - just run
echo this file again and it'll pick up from exactly where that task
echo left off, without repeating the tasks that already finished.
echo.
echo When everything above finishes cleanly, please send back every
echo file in this folder's "fixtures" subfolder that starts with:
echo   evaluation-results-
echo   evaluation-log-
echo (there should be up to 7 of each - one pair per task.)
echo.
echo Thank you again for helping with this!
echo ============================================
pause
