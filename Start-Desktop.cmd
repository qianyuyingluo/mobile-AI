@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
node backend/server.mjs --desktop %*
set "launchExit=%ERRORLEVEL%"
if not "%launchExit%"=="0" pause
popd
exit /b %launchExit%
