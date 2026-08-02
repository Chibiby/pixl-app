; Cafe install helpers (ProgramData env template + operator notes).
; Included from build/installer.nsh — keep watchdog install logic there.
;
; electron-builder's bundled NSIS does not define $COMMONPROGRAMDATA /
; $PROGRAMDATA, so we expand %PROGRAMDATA% at runtime.

!macro pixlEnsureCafeDeps
  ExpandEnvStrings $R9 "%PROGRAMDATA%"
  CreateDirectory "$R9\Pixl"

  ; Seed .env.example only when missing. Never touch an existing .env.
  IfFileExists "$R9\Pixl\.env.example" pixl_env_example_done 0
    IfFileExists "$INSTDIR\resources\.env.example" 0 pixl_env_example_done
      CopyFiles /SILENT "$INSTDIR\resources\.env.example" "$R9\Pixl\.env.example"
  pixl_env_example_done:

  ; Operator checklist — refresh on each install (safe documentation overwrite).
  IfFileExists "$INSTDIR\resources\OPERATOR.txt" 0 pixl_operator_done
    CopyFiles /SILENT "$INSTDIR\resources\OPERATOR.txt" "$R9\Pixl\OPERATOR.txt"
  pixl_operator_done:
!macroend
