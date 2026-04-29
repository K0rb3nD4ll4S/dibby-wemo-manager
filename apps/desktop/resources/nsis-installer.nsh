; ──────────────────────────────────────────────────────────────────────────────
; Custom NSIS hooks for Dibby Wemo Manager
;
; The DibbyWemoScheduler Windows service and its support files live OUTSIDE
; the install directory (under C:\ProgramData\DibbyWemoManager\), so the
; default NSIS uninstaller doesn't touch them. Without this hook, uninstalling
; Dibby leaves behind:
;   - DibbyWemoScheduler service registered with Windows (orphaned)
;   - C:\ProgramData\DibbyWemoManager\daemon\        (winsw + service XML)
;   - C:\ProgramData\DibbyWemoManager\node-windows\  (deployed npm pkg)
;   - C:\ProgramData\DibbyWemoManager\scheduler-standalone.js
;   - C:\ProgramData\DibbyWemoManager\homekit-bridge\ (HAP pairings)
;
; The customUnInstall macro fires after files are removed but before the
; uninstaller exits, so SC commands run from the original installer process
; (already elevated for uninstall) and we don't trigger an extra UAC prompt.
;
; User data we deliberately keep across uninstalls:
;   - devices.json
;   - dwm-rules.json
;   - scheduler.log
;   - homekit-bridge-prefs.json
; (User can wipe these manually with the bundled tools\uninstall-service.ps1
; if they want a truly fresh start.)
; ──────────────────────────────────────────────────────────────────────────────

; ── customInit: stop service + cleanup BEFORE files are written ─────────────
;
; Fires before the install begins (after license / install-dir prompts but
; before file copy). At this point the previous version's uninstaller may not
; have run yet — we still need to stop the existing service so its scheduler-
; standalone.js can be overwritten without ERROR_SHARING_VIOLATION.
!macro customInit
  SetShellVarContext all

  DetailPrint "Dibby: stopping any existing DibbyWemoScheduler service..."
  nsExec::ExecToLog 'sc.exe stop DibbyWemoScheduler'
  Sleep 1500

  ; Wipe stale runtime state so the new build's deployNodeWindows starts fresh
  RMDir /r "C:\ProgramData\DibbyWemoManager\daemon"
  RMDir /r "C:\ProgramData\DibbyWemoManager\node-windows"
  Delete  "C:\ProgramData\DibbyWemoManager\scheduler-standalone.js"
  Delete  "C:\ProgramData\DibbyWemoManager\node.exe"
  Delete  "C:\ProgramData\DibbyWemoManager\service-install.log"
!macroend

; ── customInstall: re-register service after files are in place ────────────
;
; After the new files are written, leave the service in a clean "ready to
; install via the in-app Settings → 🏠 HomeKit Bridge" state. We deliberately
; do NOT auto-install the service here because it requires the user to choose
; auto-start prefs and respond to UAC inside the app's normal flow.
!macro customInstall
  SetShellVarContext all
  DetailPrint "Dibby: install complete. Open Settings → HomeKit Bridge to install the scheduler service."
!macroend

!macro customUnInstall
  ; Switch shell-var context to "all users" so $APPDATA resolves to ProgramData
  ; (e.g. C:\ProgramData) instead of the per-user roaming directory.
  SetShellVarContext all

  DetailPrint "Dibby: stopping DibbyWemoScheduler service..."
  nsExec::ExecToLog 'sc.exe stop DibbyWemoScheduler'
  ; Give the service up to 2 s to stop before we yank its files
  Sleep 2000

  DetailPrint "Dibby: removing DibbyWemoScheduler service from Windows..."
  nsExec::ExecToLog 'sc.exe delete DibbyWemoScheduler'
  Sleep 500

  DetailPrint "Dibby: removing service support files (daemon, node-windows, scheduler-standalone, node.exe)..."
  RMDir /r "C:\ProgramData\DibbyWemoManager\daemon"
  RMDir /r "C:\ProgramData\DibbyWemoManager\node-windows"
  Delete  "C:\ProgramData\DibbyWemoManager\scheduler-standalone.js"
  Delete  "C:\ProgramData\DibbyWemoManager\node.exe"
  Delete  "C:\ProgramData\DibbyWemoManager\service-install.log"

  DetailPrint "Dibby: removing HomeKit bridge pairing data..."
  RMDir /r "C:\ProgramData\DibbyWemoManager\homekit-bridge"
  Delete  "C:\ProgramData\DibbyWemoManager\homekit-bridge-prefs.json"

  DetailPrint "Dibby: cleanup complete. devices.json, DWM rules, and scheduler.log were preserved."
!macroend
