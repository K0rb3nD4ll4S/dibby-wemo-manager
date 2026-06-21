@echo off
REM ────────────────────────────────────────────────────────────────────────
REM  Dibby Wemo — Clear All Wemo Firmware Rules
REM
REM  Launch wrapper for clear-wemo-rules.js.  Uses the bundled node.exe
REM  shipped with the Dibby Wemo Manager installer (one directory up from
REM  this tool's folder, under \resources\node.exe).  Falls back to a
REM  system-installed node if the bundled one isn't found, then errors
REM  out loudly if neither is available.
REM
REM  Always pauses at the end so the user can read the summary even when
REM  launched via a Start menu shortcut (cmd window would close instantly
REM  otherwise).
REM ────────────────────────────────────────────────────────────────────────
setlocal

REM Move into the tool's own directory so relative requires + node_modules
REM resolution works regardless of where the shortcut was invoked from.
cd /d "%~dp0"

REM Bundled node.exe lives one level up under \resources\node.exe when this
REM tool is installed at:
REM   C:\Program Files\Dibby Wemo Manager\resources\tools\clear-wemo-rules\
set "BUNDLED_NODE=%~dp0..\..\node.exe"

if exist "%BUNDLED_NODE%" (
    "%BUNDLED_NODE%" "%~dp0clear-wemo-rules.js"
) else (
    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  ERROR: Bundled node.exe not found at "%BUNDLED_NODE%"
        echo         and no system-installed Node.js found on PATH.
        echo.
        echo  Reinstall Dibby Wemo Manager to restore the bundled Node binary,
        echo  or install Node.js 18+ from https://nodejs.org and re-run this tool.
        echo.
        goto end
    )
    node "%~dp0clear-wemo-rules.js"
)

:end
echo.
pause
endlocal
