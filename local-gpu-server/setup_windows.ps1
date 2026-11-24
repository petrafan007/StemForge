# StemForge Local GPU Setup Script for Windows (NVIDIA RTX / CUDA)
# Usage:  .\setup_windows.ps1            (auto-picks Python 3.12 / 3.11 / 3.10)
#         .\setup_windows.ps1 -Python "C:\Path\To\python.exe"
#         .\setup_windows.ps1 -WithAdtof (also installs the ADTOF neural drum transcriber)
#         .\setup_windows.ps1 -WithYourMT3 (also installs YourMT3+ as an optional full-chord transcriber)
#
# Everything is installed into local-gpu-server\.venv only. Nothing is installed globally,
# and other Python setups on this PC (e.g. ComfyUI's embedded Python) are never touched.

param(
    [string]$Python = "",
    [switch]$WithAdtof,
    [switch]$WithYourMT3
)

# ADTOF-pytorch (drum transcription trained on rock/metal rhythm-game charts). Pinned to the
# commit that was reviewed for StemForge. Model weights: CC BY-NC-SA 4.0 (non-commercial use).
$AdtofSpec = "adtof-pytorch @ git+https://github.com/xavriley/ADTOF-pytorch.git@85c192e78f716ea0b111cc8a5ee4a8f6a3a4f8a9"

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

if ($WithAdtof) {
    Write-Host "Installing ADTOF neural drum transcription (pinned commit) ..."
    & $venvPython -m pip install --no-deps $AdtofSpec
    if ($LASTEXITCODE -ne 0) { Write-Warning "ADTOF install failed; StemForge will use its built-in drum onset detector." }
}

# Model weights for BS-RoFormer-SW separation and Beat This! beat tracking (pinned SHA-256).
function Get-Model([string]$Url, [string]$Dest, [string]$Sha256) {
    if ((Test-Path $Dest) -and ((Get-FileHash $Dest -Algorithm SHA256).Hash -eq $Sha256)) {
        Write-Host "  $(Split-Path $Dest -Leaf): already installed"
        return
    }
    New-Item -ItemType Directory -Force (Split-Path $Dest) | Out-Null
    Write-Host "  downloading $(Split-Path $Dest -Leaf) ..."
    try {
        Invoke-WebRequest -Uri $Url -OutFile "$Dest.part" -UseBasicParsing
    } catch {
        Write-Warning "Download failed for $Url ($($_.Exception.Message))."
        return
    }
    $hash = (Get-FileHash "$Dest.part" -Algorithm SHA256).Hash
    if ($hash -ne $Sha256) {
        Remove-Item "$Dest.part" -Force
        Write-Warning "Checksum mismatch for $(Split-Path $Dest -Leaf) (got $hash); not installed."
        return
    }
    Move-Item -Force "$Dest.part" $Dest
}

Write-Host "Installing model weights (BS-RoFormer-SW ~700 MB, Beat This! ~80 MB, guitar model ~45 MB) ..."
$models = Join-Path $PSScriptRoot "models"
$rof = Join-Path $models "roformer\roformer-model-bs-roformer-sw-by-jarredou"
Get-Model "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/main/BS-Rofo-SW-Fixed.yaml" (Join-Path $rof "BS-Rofo-SW-Fixed.yaml") "52df622c95ff3c1f4e1389f476ed737581a2c2dc12324d52c9763be9ccd2be2b"
Get-Model "https://huggingface.co/enerjazzer/BS-ROFO-SW-Fixed/resolve/main/BS-Rofo-SW-Fixed.ckpt" (Join-Path $rof "BS-Rofo-SW-Fixed.ckpt") "24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e"
Get-Model "https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt" (Join-Path $models "beat_this\final0.ckpt") "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
# becruily's guitar separation model (Mel-Band RoFormer, ~45 MB): "SW + guitar model" separation choices
$gtr = Join-Path $models "roformer\mel-band-roformer-guitar-becruily"
Get-Model "https://huggingface.co/becruily/mel-band-roformer-guitar/resolve/main/becruily_guitar.ckpt" (Join-Path $gtr "becruily_guitar.ckpt") "83472bbf125774af5282d2e0b86df89eaf2dd45e8a4ec8d68e820ebf3e42a83c"
Get-Model "https://huggingface.co/becruily/mel-band-roformer-guitar/resolve/main/config_guitar_becruily.yaml" (Join-Path $gtr "config_guitar_becruily.yaml") "b681c3f886251b04b666b3f06e87ce65d7ec610e40b5d75915c01782e5444b0e"

if ($WithYourMT3) {
    # YourMT3+ (Apache-2.0): model code from the official Space at a pinned revision, checkpoint SHA-256 checked.
    Write-Host "Installing YourMT3+ (full-chord transcriber, ~560 MB) ..."
    & $venvPython -m pip install -r (Join-Path $PSScriptRoot "requirements-yourmt3.txt")
    if ($LASTEXITCODE -ne 0) { Write-Warning "YourMT3+ dependencies failed to install; Basic Pitch stays the full-chord transcriber." }
    else {
        $ymt3 = Join-Path $models "yourmt3"
        & $venvPython -c "from huggingface_hub import snapshot_download as s; s(repo_id='mimbres/YourMT3', repo_type='space', revision='5e66c1ea173a8186e0d20432b841d3180cc015b5', local_dir=r'$ymt3\space', allow_patterns=['amt/src/config/*.py','amt/src/model/*.py','amt/src/model/RoPE/*.py','amt/src/utils/*.py','README.md'])"
        if ($LASTEXITCODE -ne 0) { Write-Warning "YourMT3+ code download failed." }
        $ck = "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops"
        Get-Model "https://huggingface.co/mimbres/YourMT3/resolve/main/logs/2024/$ck/checkpoints/last.ckpt" (Join-Path $ymt3 "checkpoints\$ck\last.ckpt") "ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25"
    }
}

Write-Host "Verifying NVIDIA CUDA GPU detection and transcription model ..."
& $venvPython -c "import torch; ok = torch.cuda.is_available(); print('CUDA Available:', ok); print('GPU:', torch.cuda.get_device_name(0) if ok else 'CPU fallback')"
& $venvPython -c "from basic_pitch import build_icassp_2022_model_path, FilenameSuffix; from basic_pitch.inference import Model; Model(build_icassp_2022_model_path(FilenameSuffix.onnx)); print('Basic Pitch: OK')"

Write-Host ""
Write-Host "Setup complete! Run .\start_windows.ps1 (or ..\start-stemforge.ps1 for everything)." -ForegroundColor Green
