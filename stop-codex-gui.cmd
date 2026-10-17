@echo off
setlocal enabledelayedexpansion
title Codex GUI - stop
cd /d "%~dp0"

set "PIDFILE=.codex-gui\bridge.pid"
set "PORT=8790"
set "PORTPID="
set "RECORDED="
set "ISOURS="
set "STOPPED="

echo ========================================
echo   Stopping Codex GUI
echo ========================================
echo.

rem --- 1. who actually owns the port? ---
rem The port holder is the real identity. A PID recorded in a file is NOT: after a
rem reboot Windows reuses PIDs, so a stale file could point at an unrelated
rem program. Killing by recorded PID alone was measured to kill a random process.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:"TCP.*:%PORT% .*LISTENING"') do set "PORTPID=%%a"

if exist "%PIDFILE%" set /p RECORDED=<"%PIDFILE%"

if not defined PORTPID (
  echo   nothing is listening on port %PORT%.
  if defined RECORDED echo   recorded pid %RECORDED% is stale - ignoring it.
  goto :report
)

echo   port %PORT% held by pid !PORTPID!
if defined RECORDED (
  if "!RECORDED!"=="!PORTPID!" (
    echo   matches the recorded pid.
  ) else (
    echo   recorded pid was !RECORDED! - stale, ignored.
  )
)

rem --- 2. confirm it really is our bridge before killing ---
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=!PORTPID!').CommandLine" 2^>nul`) do set "CMDLINE=%%L"
if defined CMDLINE (
  echo !CMDLINE! | find /I "bridge.cjs" >nul && set "ISOURS=1"
)

if not defined ISOURS (
  echo.
  echo   [WARN] pid !PORTPID! is NOT the Codex GUI bridge.
  echo          refusing to kill it.
  goto :report
)

rem --- 3. stop it ---
echo   confirmed: bridge.cjs
taskkill /PID !PORTPID! /T /F >nul 2>nul
set "STOPPED=1"

:report
del "%PIDFILE%" >nul 2>nul
echo.
netstat -ano | findstr /R /C:"TCP.*:%PORT% .*LISTENING" >nul 2>nul
if errorlevel 1 (set "PORTSTATE=released") else (set "PORTSTATE=STILL IN USE")

if defined STOPPED (
  echo   [OK] stopped pid !PORTPID!
) else if defined PORTPID (
  echo   [--] left pid !PORTPID! running
) else (
  echo   [--] nothing was running
)
echo   port %PORT% : !PORTSTATE!
echo.
echo ========================================

rem Keep the window open when double-clicked, so the result is visible.
rem Pass --no-pause when calling this from a script.
if /I "%~1"=="--no-pause" exit /b 0
echo Press any key to close this window...
pause >nul
exit /b 0
