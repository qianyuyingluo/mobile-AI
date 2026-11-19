@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0.." || exit /b 1
node "%~dp0server.mjs" --desktop %*
set "launchExit=%ERRORLEVEL%"
popd
if not "%launchExit%"=="0" pause
exit /b %launchExit%
