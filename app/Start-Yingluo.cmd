@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0" || exit /b 1
set "DSH_HOME=%LOCALAPPDATA%\YingluoHarness"
node --import tsx/esm apps/cli/src/bin.ts web --port 0 %*
set "launchExit=%ERRORLEVEL%"
popd
if not "%launchExit%"=="0" pause
exit /b %launchExit%
