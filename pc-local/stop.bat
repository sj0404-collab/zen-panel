@echo off
rem Stops the hub started by start.bat.
taskkill /FI "WINDOWTITLE eq zen-hub*" /F >nul 2>&1 && echo hub stopped || echo no hub running (or close its window by hand)
