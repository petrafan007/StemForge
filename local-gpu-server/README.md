# StemForge Local GPU Server (`htdemucs_6s`)

This directory contains the local Python GPU backend for StemForge. It runs Meta's **Hybrid Transformer Demucs 6-Stem (`htdemucs_6s`)** neural network directly on your NVIDIA RTX GPU (e.g., RTX 4070) and serves separated 16-bit WAV stems to the StemForge web app over `http://127.0.0.1:8000`.

## Requirements
- **Python 3.10 or 3.11** (recommended for PyTorch + Demucs wheels)
- **FFmpeg** on `PATH` (Windows: `winget install Gyan.FFmpeg` · Ubuntu: `sudo apt install ffmpeg` · macOS: `brew install ffmpeg`)
- **NVIDIA GPU Drivers** (for CUDA acceleration on RTX cards)

## Windows (PowerShell)
```powershell
cd local-gpu-server
.\setup_windows.ps1
.\start_windows.ps1
```
*(If PowerShell blocks script execution, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.)*

## Linux / WSL2 / macOS
```bash
cd local-gpu-server
chmod +x setup_unix.sh start_unix.sh
./setup_unix.sh
./start_unix.sh
```

## API Endpoints
- `GET /health` — Returns CUDA availability, detected GPU name, total VRAM, and model load status.
- `POST /separate?piano_only=false` — Accepts `multipart/form-data` `file` (MP3/WAV/FLAC/OGG/M4A/AAC), separates via `htdemucs_6s`, and returns URLs for `vocals`, `guitar`, `bass`, `drums`, and `keyboards`.
- `GET /stems/{job_id}/{stem}.wav` — Streams individual 16-bit stereo WAV stems.
- `DELETE /stems/{job_id}` — Cleans up temporary stem files once decoded by the browser.
