# Starts everything StemForge needs:
#   1. the local GPU server (Demucs + Basic Pitch) on http://127.0.0.1:8000 in its own window
#   2. the StemForge web app on http://localhost:3000 in this window, and opens your browser
#
# Usage (PowerShell, from this folder):  .\start-stemforge.ps1
#        or double-click "Start StemForge.cmd"
# Options:  -NoGpu   start only the web app (browser STFT engine)

param(
    [switch]$NoGpu
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

function Test-GpuServer {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:8000/health" -TimeoutSec 2
        return [bool]$r.ok
    } catch {
        return $false
    }
}

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "Installing web app dependencies (first run) ..." -ForegroundColor Cyan
    npm install
}

if (-not $NoGpu) {
    $venvPython = Join-Path $root "local-gpu-server\.venv\Scripts\python.exe"
    if (-not (Test-Path $venvPython)) {
        Write-Warning "GPU server is not set up yet. Run: cd local-gpu-server; .\setup_windows.ps1"
        Write-Warning "Continuing with the browser-only engine."
    } elseif (Test-GpuServer) {
        Write-Host "GPU server already running on http://127.0.0.1:8000" -ForegroundColor Green
    } else {
        Write-Host "Starting GPU server in a new window ..." -ForegroundColor Cyan
        $gpuScript = Join-Path $root "local-gpu-server\start_windows.ps1"
        Start-Process -FilePath "powershell.exe" -ArgumentList @(
            "-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$gpuScript`""
        ) -WorkingDirectory (Join-Path $root "local-gpu-server")

        $deadline = (Get-Date).AddSeconds(90)
        while ((Get-Date) -lt $deadline -and -not (Test-GpuServer)) {
            Start-Sleep -Milliseconds 750
        }
        if (Test-GpuServer) {
            Write-Host "GPU server is ready." -ForegroundColor Green
        } else {
            Write-Warning "GPU server did not answer yet - check its window for errors."
        }
    }
}

Write-Host ""
Write-Host "Starting StemForge web app on http://localhost:3000 (Ctrl+C to stop) ..." -ForegroundColor Cyan
Write-Host "In the app: Library tab -> Local GPU (Demucs RTX) -> Test GPU Connection." -ForegroundColor DarkGray
npm run dev -- --open
