# Starts the StemForge Local GPU Separation Server on http://127.0.0.1:8000
# Usage: .\start_windows.ps1

$ErrorActionPreference = "Stop"

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run .\setup_windows.ps1 first."
}

Set-Location $PSScriptRoot
Write-Host "Starting StemForge Local GPU Server on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
& $venvPython -m uvicorn gpu_server:app --host 127.0.0.1 --port 8000
