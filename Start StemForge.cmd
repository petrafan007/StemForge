@echo off
rem Double-click launcher: starts the StemForge GPU server and web app.
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-stemforge.ps1" %*
