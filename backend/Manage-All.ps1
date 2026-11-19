param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [ValidateRange(1, 65535)][int]$Port = 3197
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$serverFile = Join-Path $PSScriptRoot 'server.mjs'
$origin = "http://127.0.0.1:$Port"
$logDirectory = Join-Path $env:LOCALAPPDATA 'YingluoWork\launcher'

function Get-Listener {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}
function Get-Control {
    Invoke-RestMethod -Uri "$origin/v1/control" -Method Post -Headers @{ Origin = $origin } -TimeoutSec 5
}
function Stop-OwnedService($listener) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $command = $process.CommandLine
    # Only stop a Node service explicitly launched from this checkout.
    if ($process.Name -ne 'node.exe' -or !$command -or
        !$command.Contains($serverFile)) {
        throw "Port $Port belongs to another process. It was not stopped."
    }
    Stop-Process -Id $process.ProcessId
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (!(Get-Listener)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Port $Port was not released."
}
function Open-Agent([string]$name, [string]$override, [string]$fallback) {
    if (Get-Process -Name $name -ErrorAction SilentlyContinue) {
        Write-Host "$name is already running."
        return
    }
    if ($override) {
        if (!(Test-Path -LiteralPath $override -PathType Leaf)) { throw "Invalid application path: $override" }
        Start-Process -FilePath $override -WindowStyle Hidden
        return
    }
    $app = Get-StartApps | Where-Object Name -eq $name | Select-Object -First 1
    if ($app) {
        Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $app.AppID) -WindowStyle Hidden
        return
    }
    if ($fallback -and (Test-Path -LiteralPath $fallback)) {
        Start-Process -FilePath $fallback -WindowStyle Hidden
        return
    }
    if ($name -eq 'Codex') {
        $package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
        if ($package) {
            $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
            $id = @($manifest.Package.Applications.Application)[0].Id
            Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $package.PackageFamilyName + '!' + $id) -WindowStyle Hidden
            return
        }
    }
    Write-Warning "$name was not found. Set AYANE_CODEX_EXE or AYANE_HARNESS_EXE to its installed executable."
}

try {
    $listener = Get-Listener
    if ($Action -eq 'Stop') {
        if ($listener) { Stop-OwnedService $listener }
        Write-Host "Ayane service stopped. Port $Port is free. Desktop agents remain open."
        exit 0
    }
    $node = (Get-Command node -ErrorAction Stop).Source
    $nodeVersion = [version]((& $node --version).TrimStart('v'))
    if ($nodeVersion -lt [version]'24.9.0') { throw 'Node.js 24.9 or newer is required.' }
    # Install the desktop plugin before opening Harness.
    Push-Location $projectRoot
    try { 'import("./backend/install-harness-sync.mjs").then(m => m.installHarnessSync())' | & $node --input-type=module }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Harness sync plugin setup failed.' }
    if ($listener) {
        $control = Get-Control
        if (!$control.desktopLibrary) {
            $summary = Invoke-RestMethod "$origin/v1/work" -Headers @{ Authorization = 'Bearer ' + $control.token }
            if (@($summary.sessions | Where-Object status -eq 'running').Count) {
                throw 'The old Work service has a running task. Finish it before restarting.'
            }
            Stop-OwnedService $listener
            $listener = $null
        }
    }
    $started = $null
    if (!$listener) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $started = Start-Process -FilePath $node -ArgumentList @(('"' + $serverFile + '"'), '--desktop', '--port', $Port) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "service-$Port.log") -RedirectStandardError (Join-Path $logDirectory "service-$Port.error.log")
        try {
            $control = $null
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                if ($started.HasExited) { throw "Service exited. Check $logDirectory" }
                try { $control = Get-Control } catch { $control = $null }
                if ($control.desktopLibrary) { break }
                Start-Sleep -Milliseconds 500
            }
            if (!$control.desktopLibrary) { throw 'Desktop sync did not become ready.' }
        } catch {
            if (!$started.HasExited) { Stop-Process -Id $started.Id }
            throw
        }
    }
    Open-Agent 'Codex' $env:AYANE_CODEX_EXE ''
    Open-Agent 'DeepSeek Harness' $env:AYANE_HARNESS_EXE 'D:\deepseek\DeepSeek Harness.exe'
    if (!$started) { Start-Process explorer.exe -ArgumentList "$origin/control" -WindowStyle Hidden }
    Write-Host "Ayane desktop sync is ready: $origin/control"
    Write-Host 'Use Stop-All.cmd to release the service port.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
