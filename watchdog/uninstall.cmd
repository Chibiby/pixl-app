@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0uninstall-service.js" %*
  exit /b %ERRORLEVEL%
)

REM Fallback if runtime was already copied only to ProgramData.
if exist "%ProgramData%\Pixl\watchdog\node.exe" (
  "%ProgramData%\Pixl\watchdog\node.exe" "%~dp0uninstall-service.js" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%~dp0uninstall-service.js" %*
  exit /b %ERRORLEVEL%
)

echo ERROR: No Node runtime found to run uninstall-service.js
exit /b 1
