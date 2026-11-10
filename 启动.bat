@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AI Auto Remix

if not exist "runtime\node.exe"   goto prep
if not exist "runtime\ffmpeg.exe" goto prep
if not exist "runtime\ffprobe.exe" goto prep
goto run

:prep
powershell -NoProfile -ExecutionPolicy Bypass -File "launcher\prepare.ps1"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

:run
"runtime\node.exe" "launcher\start.mjs" %*
if errorlevel 1 (
  echo.
  pause
)
endlocal
