@echo off
rem Registers this PC as a self-hosted GitHub Actions runner for the repo.
rem Needs a one-time registration token: repo Settings - Actions - Runners -
rem New self-hosted runner (it is consumed by config.cmd, not stored here).
setlocal enabledelayedexpansion
set "DIR=%~dp0"
set "TARGET=%DIR%actions-runner"
if "%REPO_URL%"=="" set /p "REPO_URL=Repo URL (https://github.com/owner/repo): "
if "%REG_TOKEN%"=="" set /p "REG_TOKEN=Registration token: "
if "%RUNNER_NAME%"=="" set "RUNNER_NAME=%COMPUTERNAME%-zen"
if "%RUNNER_VERSION%"=="" (
  echo resolving the latest runner version...
  for /f "tokens=*" %%v in ('powershell -NoProfile -Command "(Invoke-RestMethod https://api.github.com/repos/actions/runner/releases/latest).tag_name"') do set "TAG=%%v"
  set "RUNNER_VERSION=!TAG:v=!"
)
if "%RUNNER_VERSION%"=="" set /p "RUNNER_VERSION=Runner version (e.g. 2.329.0, API unreachable): "
if not exist "%TARGET%\config.cmd" (
  echo == downloading actions-runner-win-x64 %RUNNER_VERSION% ==
  mkdir "%TARGET%" 2>nul
  curl -sSL -o "%TARGET%\runner.zip" "https://github.com/actions/runner/releases/download/v%RUNNER_VERSION%/actions-runner-win-x64-%RUNNER_VERSION%.zip" || exit /b 1
  tar -xzf "%TARGET%\runner.zip" -C "%TARGET%" 2>nul || powershell -NoProfile -Command "Expand-Archive -Path '%TARGET%\runner.zip' -DestinationPath '%TARGET%' -Force" || exit /b 1
  del "%TARGET%\runner.zip"
)
cd /d "%TARGET%"
set "LABELS_ARG="
if not "%RUNNER_LABELS%"=="" set "LABELS_ARG=--labels %RUNNER_LABELS%"
call config.cmd --unattended --replace --url "%REPO_URL%" --token "%REG_TOKEN%" --name "%RUNNER_NAME%" %LABELS_ARG%
echo done.
echo   run foreground: %TARGET%\run.cmd
echo then pick 'self-hosted' in the panel's launch dialog.
