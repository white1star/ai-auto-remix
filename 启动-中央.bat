@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AI Auto Remix - Admin
if not exist "runtime\node.exe" goto nonode
"runtime\node.exe" "launcher\start-central.mjs" %*
if errorlevel 1 ( echo. & pause )
goto :eof
:nonode
echo.
echo   runtime\node.exe not found.
echo   Copy the runtime folder next to this file, or run 安装运行时.bat
echo.
pause
