@echo off
setlocal
set PORT=8000
set URL=http://localhost:%PORT%/printer.html

echo Starting simple server on %URL%
echo Press Ctrl+C in the server window to stop it.
echo.
echo If Python is not installed, install from https://www.python.org/downloads/ or run:
echo   winget install --id=Python.Python.3 -e
echo.

where python >nul 2>&1
if %errorlevel% neq 0 (
    echo Python not found in PATH.
    pause
    exit /b 1
)

start "OBS Print Progress Server" cmd /k "cd /d %~dp0 && python -m http.server %PORT%"

echo Use this URL in an OBS Browser source (replace printer id):
echo   %URL%?printer=yourid
echo If loading fails due to CORS, add your OBS origin to Moonraker cors_domains (see README).
pause
