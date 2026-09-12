@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  Baranguard AI Evaluation - Friend Test Kit
echo ============================================
echo.
echo This tests how well a local AI model removes personal information
echo from 200 made-up sample incident reports. Nothing on this computer
echo is sent anywhere - everything runs locally, offline.
echo.

REM --- 1. Check PHP is installed --------------------------------------
where php >nul 2>nul
if errorlevel 1 (
    echo [ERROR] PHP was not found on this computer.
    echo.
    echo Please install it first - open Command Prompt and run:
    echo     winget install PHP.PHP
    echo Then close this window and double-click run-evaluation.bat again.
    echo.
    pause
    exit /b 1
)

REM --- 2. Check .env exists, bootstrap it on first run ----------------
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo A ".env" settings file was just created for you in this folder.
    echo.
    echo Please open ".env" in Notepad, check the model name matches
    echo exactly what you ran "ollama pull" with, save it, then run
    echo this file again.
    echo.
    pause
    exit /b 0
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

REM --- 4. Quick 3-record smoke test before committing to the full run --
:smoke_test
echo Running a quick 3-record check first (about a minute or two)...
echo.
php scripts\ai-evaluate.php --engine=model --dataset=fixtures\redaction-eval-sample.json --limit=3 --dry-run --verbose
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

REM --- 5. The real 200-record run, paced and resumable -----------------
echo ============================================
echo Ready to run the full 200-record test.
echo.
echo This can take SEVERAL HOURS depending on your computer, and will
echo pause for a couple of minutes every 20 records to rest your CPU
echo (you'll see "resting..." messages - that's expected).
echo.
echo You can safely close this window at any point and run this file
echo again later - it always picks up exactly where it left off and
echo never redoes work or loses progress.
echo ============================================
echo.
pause

php scripts\ai-evaluate.php --engine=model --dataset=fixtures\redaction-eval-v1.json --dry-run --verbose --batch-size=20 --rest-seconds=120 --resume --save-results

echo.
echo ============================================
echo If you see an error above about Ollama being unavailable partway
echo through, that's fine - your progress up to that point is saved.
echo Just run this file again to continue from there.
echo.
echo When the run finishes completely, please send back these two
echo files from this folder:
echo   evaluation-results-*.txt
echo   evaluation-log-*.txt
echo.
echo Thank you for helping with this!
echo ============================================
pause
