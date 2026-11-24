#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== StemForge Local GPU Server Setup ==="

PYTHON_BIN="${PYTHON_BIN:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Error: python3 not found. Please install Python 3.10 - 3.12." >&2
  exit 1
fi

echo "Found $($PYTHON_BIN --version)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Warning: ffmpeg not found on PATH. Install ffmpeg for full MP3/M4A/AAC support."
fi

if [ ! -d ".venv" ]; then
  echo "Creating virtual environment in local-gpu-server/.venv ..."
  "$PYTHON_BIN" -m venv .venv
fi

.venv/bin/python -m pip install --upgrade pip

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPU detected — installing PyTorch 2.7.1 with CUDA 12.6 ..."
  .venv/bin/python -m pip install "torch==2.7.1" "torchaudio==2.7.1" --index-url https://download.pytorch.org/whl/cu126
else
  echo "Installing standard PyTorch (Apple Silicon MPS / CPU) ..."
  .venv/bin/python -m pip install "torch==2.7.1" "torchaudio==2.7.1"
fi

echo "Installing Demucs, FastAPI and transcription dependencies ..."
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip install --no-deps "basic-pitch==0.4.0"

.venv/bin/python -c "import torch; print('CUDA Available:', torch.cuda.is_available(), '| Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else ('MPS' if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available() else 'CPU'))"

echo ""
echo "Setup complete! Run ./start_unix.sh to launch the GPU server on http://127.0.0.1:8000"
