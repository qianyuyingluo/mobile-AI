@echo off
setlocal DisableDelayedExpansion
node "%~dp0server.mjs" --lan %*
set "launchExit=%ERRORLEVEL%"
if not "%launchExit%"=="0" pause
exit /b %launchExit%
