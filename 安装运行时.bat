@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Install Runtime
powershell -NoProfile -ExecutionPolicy Bypass -File "launcher\prepare.ps1" -Force
echo.
pause
endlocal
