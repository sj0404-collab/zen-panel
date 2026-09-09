@echo off
rem Zen Panel on a local PC, no GitHub Actions: starts npm-hub and the desktop panel.
setlocal
set "ROOT=%~dp0.."
node --version >nul 2>&1 || (echo Node.js 20+ is required: https://nodejs.org/ & exit /b 1)
if not exist "%ROOT%\npm-hub\node_modules" (
  echo == installing npm-hub dependencies ^(first run only^) ==
  cd /d "%ROOT%\npm-hub" && call npm ci --no-audit --no-fund || exit /b 1
)
if "%PORT%"=="" set PORT=8090
if "%HUB_TOKEN%"=="" echo tip: set HUB_TOKEN=... to gate the hub with a token ^(?zt=^)
echo == starting npm-hub on :%PORT% ==
cd /d "%ROOT%\npm-hub"
start "zen-hub" /min node src\server.js
if exist "%ROOT%\desktop\node_modules" (
  echo == opening the desktop panel ==
  cd /d "%ROOT%\desktop" && start "zen-panel" npm start
) else (
  echo desktop shell not installed - open the hub directly:
  echo install it later: cd desktop ^&^& npm install ^&^& npm start
)
echo   hub:      http://localhost:%PORT%/
echo   desktop:  http://localhost:%PORT%/d
echo   mobile:   http://localhost:%PORT%/m
echo stop the hub with pc-local\stop.bat
