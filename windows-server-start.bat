@echo off
setlocal
cd /d "%~dp0"

rem Starts the OBS Print Progress server and opens the setup page in your browser.
rem Keep this window open while you stream.

set PY=
where py >nul 2>&1 && set PY=py -3
if not defined PY (
    where python >nul 2>&1 && set PY=python
)
if not defined PY (
    echo Python 3 is required but was not found.
    echo.
    echo Install it from https://www.python.org/downloads/
    echo   (tick "Add python.exe to PATH" during setup^)
    echo or run:  winget install --id=Python.Python.3.12 -e
    echo.
    pause
    exit /b 1
)

%PY% server.py %*
if errorlevel 1 pause
