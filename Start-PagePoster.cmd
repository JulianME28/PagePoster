@echo off
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Start-PagePoster.ps1"
exit /b %ERRORLEVEL%
