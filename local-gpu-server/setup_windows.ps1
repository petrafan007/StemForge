# StemForge Local GPU Setup Script for Windows (NVIDIA RTX / CUDA)
# Usage:  .\setup_windows.ps1            (auto-picks Python 3.12 / 3.11 / 3.10)
#         .\setup_windows.ps1 -Python "C:\Path\To\python.exe"
#
# Everything is installed into local-gpu-server\.venv only. Nothing is installed globally,
# and other Python setups on this PC (e.g. ComfyUI's embedded Python) are never touched.

param(
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "=== StemForge Local GPU Server Setup (NVIDIA CUDA) ===" -ForegroundColor Cyan

function Find-Python {
    # Prefer the Windows py launcher with a supported version.
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in @("3.12", "3.11", "3.10")) {
            $exe = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
        }
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

if (-not $Python) { $Python = Find-Python }
if (-not $Python -or -not (Test-Path $Python)) {
    Write-Error "No suitable Python found. Install Python 3.12 (64-bit) from https://www.python.org/downloads/ or pass -Python <path>."
}

$pyVersion = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])"
Write-Host "Using Python $pyVersion at $Python"
if (@("3.10", "3.11", "3.12") -notcontains $pyVersion) {
    Write-Warning "Python $pyVersion is untested with Demucs. Python 3.10-3.12 is recommended."
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning "FFmpeg was not found on PATH. Install it (winget install Gyan.FFmpeg) so MP3/M4A/AAC/video files decode."
} else {
    Write-Host "Found FFmpeg on PATH" -ForegroundColor Green
}

if (-not (Test-Path ".venv")) {
    Write-Host "Creating Python virtual environment in local-gpu-server\.venv ..."
    & $Python -m venv .venv
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

Write-Host "Upgrading pip ..."
& $venvPython -m pip install --upgrade pip

Write-Host "Installing PyTorch 2.7.1 + TorchAudio (CUDA 12.6 build) ..."
& $venvPython -m pip install "torch==2.7.1" "torchaudio==2.7.1" --index-url https://download.pytorch.org/whl/cu126
if ($LASTEXITCODE -ne 0) { Write-Error "PyTorch install failed." }

Write-Host "Installing Demucs, FastAPI server and transcription dependencies ..."
& $venvPython -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Error "Dependency install failed." }

Write-Host "Installing Spotify Basic Pitch (polyphonic audio-to-MIDI, ONNX backend) ..."
& $venvPython -m pip install --no-deps "basic-pitch==0.4.0"
if ($LASTEXITCODE -ne 0) { Write-Error "Basic Pitch install failed." }

Write-Host "Verifying NVIDIA CUDA GPU detection and transcription model ..."
& $venvPython -c "import torch; ok = torch.cuda.is_available(); print('CUDA Available:', ok); print('GPU:', torch.cuda.get_device_name(0) if ok else 'CPU fallback')"
& $venvPython -c "from basic_pitch import build_icassp_2022_model_path, FilenameSuffix; from basic_pitch.inference import Model; Model(build_icassp_2022_model_path(FilenameSuffix.onnx)); print('Basic Pitch: OK')"

Write-Host ""
Write-Host "Setup complete! Run .\start_windows.ps1 (or ..\start-stemforge.ps1 for everything)." -ForegroundColor Green
