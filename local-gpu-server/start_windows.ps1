# Starts the StemForge Local GPU Server on http://127.0.0.1:8000
# Usage: .\start_windows.ps1 [-Port 8000]

param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found. Run .\setup_windows.ps1 first."
}

Set-Location $PSScriptRoot
# Keep model weights inside this project (git-ignored), not the shared user torch cache.
$env:TORCH_HOME = Join-Path $PSScriptRoot "models"

Write-Host "Starting StemForge Local GPU Server on http://127.0.0.1:$Port ..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop." -ForegroundColor DarkGray
& $venvPython -m uvicorn gpu_server:app --host 127.0.0.1 --port $Port
