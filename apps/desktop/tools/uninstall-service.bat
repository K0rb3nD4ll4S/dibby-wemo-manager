@echo off
:: ────────────────────────────────────────────────────────────────────────────
:: Dibby Wemo Manager — service cleanup launcher (UAC self-elevating)
:: Right-click → "Run as administrator", or just double-click and click Yes
:: when Windows asks for admin rights.
:: ────────────────────────────────────────────────────────────────────────────

:: Self-elevate if not already admin
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

:: Run the cleanup script
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-service.ps1"

echo.
echo Press any key to close this window...
pause >nul
