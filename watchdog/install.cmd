@echo off
setlocal
cd /d "%~dp0"

REM Optional first arg: full path to Pixl.exe (NSIS passes "$INSTDIR\Pixl.exe").
if not "%~1"=="" set "PIXL_EXE=%~1"

if not exist "%~dp0runtime\node.exe" (
  echo ERROR: Missing runtime\node.exe
  echo Rebuild the installer with: node scripts\fetch-watchdog-runtime.js
  exit /b 1
)

REM Cafe path: run installer with the bundled portable Node (no system Node / npm).
"%~dp0runtime\node.exe" "%~dp0install-service.js" %*
exit /b %ERRORLEVEL%
