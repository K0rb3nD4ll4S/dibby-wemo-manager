# ─────────────────────────────────────────────────────────────────────────────
# Dibby Wemo Manager — service / bridge cleanup tool
#
# Run this when the desktop app's "Install Service" left orphaned files behind,
# or when an uninstall didn't fully remove the DibbyWemoScheduler service.
#
# What it cleans (in order, all idempotent):
#   1. Stops DibbyWemoScheduler service if running
#   2. Removes DibbyWemoScheduler from Windows Service Control Manager
#   3. Deletes C:\ProgramData\DibbyWemoManager\daemon\        (winsw + service XML)
#   4. Deletes C:\ProgramData\DibbyWemoManager\node-windows\  (deployed npm pkg)
#   5. Deletes C:\ProgramData\DibbyWemoManager\scheduler-standalone.js
#   6. Deletes C:\ProgramData\DibbyWemoManager\homekit-bridge\ (pairing trust)
#   7. Deletes C:\ProgramData\DibbyWemoManager\homekit-bridge-prefs.json
#   8. Deletes C:\ProgramData\DibbyWemoManager\node.exe       (deployed node binary)
#   9. Deletes C:\ProgramData\DibbyWemoManager\service-install.log (debug trace)
#
# What it KEEPS (intentionally — your real data):
#   - devices.json (your discovered Wemos)
#   - dwm-rules.json (your DWM rules)
#   - scheduler.log (history)
#   - The desktop app itself
#
# Run as Administrator. Safe to re-run.
# ─────────────────────────────────────────────────────────────────────────────

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Continue'   # keep going even if individual steps fail
$svc       = 'DibbyWemoScheduler'
$dataDir   = 'C:\ProgramData\DibbyWemoManager'

Write-Host ''
Write-Host '── Dibby Wemo Manager — service cleanup ──' -ForegroundColor Cyan
Write-Host ''

# 1. Stop the service if running
Write-Host "[1/7] Stopping $svc service..." -NoNewline
$svcObj = Get-Service -Name $svc -ErrorAction SilentlyContinue
if ($svcObj) {
    if ($svcObj.Status -eq 'Running') {
        Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
        # Wait up to 10 s for it to actually stop
        for ($i = 0; $i -lt 10; $i++) {
            Start-Sleep -Seconds 1
            $svcObj = Get-Service -Name $svc -ErrorAction SilentlyContinue
            if ($svcObj.Status -eq 'Stopped') { break }
        }
        Write-Host ' stopped.' -ForegroundColor Green
    } else {
        Write-Host ' already stopped.' -ForegroundColor Yellow
    }
} else {
    Write-Host ' not installed.' -ForegroundColor Gray
}

# 2. Delete service from SCM
Write-Host "[2/7] Removing $svc from Windows Service Control Manager..." -NoNewline
$result = sc.exe delete $svc 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host ' removed.' -ForegroundColor Green
} elseif ($result -match '1060|does not exist') {
    Write-Host ' was not registered.' -ForegroundColor Gray
} else {
    Write-Host " sc delete returned: $result" -ForegroundColor Yellow
}

# 3-9. Delete the leftover folders/files
$paths = @(
    @{ p = "$dataDir\daemon";                          n = '[3/9] daemon directory' },
    @{ p = "$dataDir\node-windows";                    n = '[4/9] deployed node-windows' },
    @{ p = "$dataDir\scheduler-standalone.js";         n = '[5/9] deployed scheduler-standalone.js' },
    @{ p = "$dataDir\homekit-bridge";                  n = '[6/9] HomeKit bridge state (pairings will be lost)' },
    @{ p = "$dataDir\homekit-bridge-prefs.json";       n = '[7/9] HomeKit bridge preferences' },
    @{ p = "$dataDir\node.exe";                        n = '[8/9] deployed node.exe (~91 MB)' },
    @{ p = "$dataDir\service-install.log";             n = '[9/9] service-install debug log' }
)
foreach ($entry in $paths) {
    Write-Host "$($entry.n) at $($entry.p)..." -NoNewline
    if (Test-Path $entry.p) {
        try {
            Remove-Item -LiteralPath $entry.p -Recurse -Force -ErrorAction Stop
            Write-Host ' removed.' -ForegroundColor Green
        } catch {
            Write-Host " could not remove: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host ' not present.' -ForegroundColor Gray
    }
}

Write-Host ''
Write-Host 'Done. The service is fully cleaned up and you can now reinstall it from Dibby Settings.' -ForegroundColor Cyan
Write-Host 'Your devices.json, DWM rules, and scheduler.log were preserved.' -ForegroundColor Gray
Write-Host ''
