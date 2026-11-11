@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Diagnose

if not exist "runtime\node.exe" (
  echo.
  echo   Runtime not installed. Run "Install Runtime.bat" first.
  echo.
  pause
  exit /b 1
)

"runtime\node.exe" "launcher\start.mjs" --check
echo.
pause
endlocal
