[CmdletBinding()]
param(
    [ipaddress] $LanHost,
    [ValidateRange(0, 65535)]
    [int] $Port = 0,
    [switch] $NoOpen
)

$previousDshHome = $env:DSH_HOME
$previousClientTitle = $env:DSH_CLIENT_TITLE
$launchArgs = @('--port', $Port.ToString())
if ($null -ne $LanHost) {
    $launchArgs += @('--host', $LanHost.ToString())
}
if ($NoOpen) {
    $launchArgs += '--no-open'
}

Push-Location -LiteralPath $PSScriptRoot
try {
    $env:DSH_HOME = Join-Path $env:LOCALAPPDATA 'YingluoHarness'
    $env:DSH_CLIENT_TITLE = [string][char]0x7EEB + [char]0x97F3
    node --import tsx/esm apps/cli/src/bin.ts web @launchArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Pop-Location
    $env:DSH_HOME = $previousDshHome
    $env:DSH_CLIENT_TITLE = $previousClientTitle
}
exit $exitCode
