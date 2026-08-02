; electron-builder NSIS include (default path: build/installer.nsh).
; Cafe ProgramData / operator notes live in pixl-cafe-deps.nsh.
; Watchdog registration runs elevated after files are copied (all-in-one cafe install).

!include "pixl-cafe-deps.nsh"

!macro customInstall
  !insertmacro pixlEnsureCafeDeps

  ; Register PixlWatchdog (WinSW + portable Node under resources\watchdog).
  ; Best-effort: a service failure must not roll back the app install.
  IfFileExists "$INSTDIR\resources\watchdog\install.cmd" 0 pixl_watchdog_install_done
    DetailPrint "Registering PixlWatchdog Windows service..."
    ; First arg becomes PIXL_EXE (supports non-default install directories).
    ExecWait '"$INSTDIR\resources\watchdog\install.cmd" "$INSTDIR\Pixl.exe"' $0
    DetailPrint "Watchdog install exit code: $0"
    ExpandEnvStrings $R9 "%PROGRAMDATA%"
    CreateDirectory "$R9\Pixl"
    FileOpen $1 "$R9\Pixl\watchdog-install.log" w
    FileWrite $1 "install.cmd exit=$0$\r$\n"
    FileWrite $1 "PIXL_EXE=$INSTDIR\Pixl.exe$\r$\n"
    FileClose $1
  pixl_watchdog_install_done:
!macroend

!macro customUnInstall
  ; electron-updater runs the uninstaller with isUpdated set — keep the service.
  ${IfNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\watchdog\uninstall.cmd" 0 pixl_watchdog_un_done
      DetailPrint "Removing PixlWatchdog Windows service..."
      ExecWait '"$INSTDIR\resources\watchdog\uninstall.cmd" --remove-files' $0
      DetailPrint "Watchdog uninstall exit code: $0"
    pixl_watchdog_un_done:
  ${EndIf}
!macroend
