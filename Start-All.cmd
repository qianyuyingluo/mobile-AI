@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\Manage-All.ps1" -Action Start %*
if errorlevel 1 pause
