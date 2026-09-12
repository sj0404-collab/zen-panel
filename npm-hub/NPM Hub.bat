@echo off
title ◆ NPM Hub — Launcher
cd /d "%~dp0"
echo.
echo   ╔═══════════════════════════════════════╗
echo   ║     ◆ NPM Hub v1.0                   ║
echo   ║     Universal AI Tools Manager        ║
echo   ╚═══════════════════════════════════════╝
echo.
echo   How to start?
echo.
echo   [1] Local only      (localhost:8090)
echo   [2] Local + Network (all IPs: 192.168.x.x, 172.x.x.x etc)
echo   [3] With ngrok tunnel (public URL)
echo   [4] With cloudflare tunnel (public URL)
echo   [5] With localtunnel (public URL)
echo.
echo   Tunnel tools install:
echo     • ngrok:       choco install ngrok
echo     • cloudflared: choco install cloudflared
echo     • localtunnel: npm install -g localtunnel
echo.
set /p choice="   Enter 1-5: "

if "%choice%"=="1" goto local
if "%choice%"=="2" goto network
if "%choice%"=="3" goto ngrok
if "%choice%"=="4" goto cloudflare
if "%choice%"=="5" goto localtunnel
goto local

:local
echo.
echo   Starting locally on http://localhost:8090
echo.
node src/server.js
pause
exit

:network
echo.
echo   Starting on all network interfaces...
echo   Access from phone via your LAN IP (192.168.x.x or 172.x.x.x)
echo.
node src/server.js
pause
exit

:ngrok
echo.
echo   Starting with ngrok tunnel...
echo.
node src/server.js --tunnel=ngrok
pause
exit

:cloudflare
echo.
echo   Starting with cloudflare tunnel...
echo.
node src/server.js --tunnel=cloudflare
pause
exit

:localtunnel
echo.
echo   Starting with localtunnel...
echo.
node src/server.js --tunnel=localtunnel
pause
exit
