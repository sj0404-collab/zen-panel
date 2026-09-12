@echo off
title NPM Hub
cd /d "%~dp0"
echo.
echo   ◆ NPM Hub — Universal npm tools manager
echo.

REM Check if already running
netstat -ano | findstr ":8090" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo   ⚠ NPM Hub is already running on port 8090!
    echo   Opening browser...
    start http://localhost:8090
    pause
    exit /b
)

if "%1"=="" (
    echo   Starting on http://localhost:8090
    echo.
    node src/server.js
) else (
    echo   Starting with tunnel: %1
    echo.
    node src/server.js --tunnel=%1
)
pause
