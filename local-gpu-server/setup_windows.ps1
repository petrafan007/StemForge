# StemForge Local GPU Setup Script for Windows (NVIDIA RTX / CUDA 12.4)
# Usage: .\setup_windows.ps1

$ErrorActionPreference = "Stop"

Write-Host "=== StemForge Local GPU Server Setup (NVIDIA CUDA) ===" -ForegroundColor Cyan

# Check Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python was not found on PATH. Install Python 3.10 or 3.11 from https://www.python.org/downloads/ and check 'Add Python to PATH'."
}

$pyVersion = python --version
Write-Host "Found $pyVersion"

# Check FFmpeg (needed for MP3, M4A, AAC, FLAC decoding)
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "FFmpeg was not found on PATH. Install it with: winget install Gyan.FFmpeg (then restart your terminal) so MP3/M4A/AAC files decode cleanly."
} else {
    Write-Host "Found FFmpeg on PATH" -ForegroundColor Green
}

# Create virtual environment
if (-not (Test-Path ".venv")) {
    Write-Host "Creating Python virtual environment in local-gpu-server\.venv ..."
    python -m venv .venv
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "Upgrading pip ..."
& $venvPython -m pip install --upgrade pip

Write-Host "Installing PyTorch + TorchAudio with CUDA 12.4 for NVIDIA RTX ..."
& $venvPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

Write-Host "Installing Demucs + FastAPI server dependencies ..."
& $venvPython -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")

Write-Host "Verifying NVIDIA CUDA GPU detection ..."
& $venvPython -c "import torch; ok = torch.cuda.is_available(); print('CUDA Available:', ok); print('GPU:', torch.cuda.get_device_name(0) if ok else 'CPU fallback')"

Write-Host ""
Write-Host "Setup complete! Run .\start_windows.ps1 to start the GPU server on http://127.0.0.1:8000" -ForegroundColor Green
