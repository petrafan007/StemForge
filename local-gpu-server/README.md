# StemForge Local GPU Server

Python backend for StemForge. It runs locally (http://127.0.0.1:8000) and:

1. Separates audio, or the audio track of a video, into **vocals, guitar, bass, drums, keyboards** with Meta's **Hybrid Transformer Demucs 6-stem (`htdemucs_6s`)** on your NVIDIA GPU.
2. Transcribes the guitar, bass, keyboards, and vocal stems into **polyphonic MIDI notes** with Spotify's **Basic Pitch** (ONNX on the CPU) and estimates the tempo with librosa.

Everything installs into `local-gpu-server/.venv`. Model weights are cached in `local-gpu-server/models` (`TORCH_HOME`), not in the shared `~/.cache/torch`, so other PyTorch tools on the machine (e.g. ComfyUI) are unaffected.

## Requirements
- **Python 3.10–3.12** (64-bit)
- **FFmpeg** on `PATH` (needed for MP3/M4A/AAC and video files)
- **NVIDIA driver** recent enough for CUDA 12.6 (any 560+ driver). The CUDA runtime ships inside the PyTorch wheel, so you don't need the CUDA Toolkit.

## Windows
```powershell
cd local-gpu-server
.\setup_windows.ps1          # auto-picks Python 3.12/3.11/3.10, or: -Python C:\path\python.exe
.\start_windows.ps1          # or ..\start-stemforge.ps1 to start the web app too
```

## Linux / WSL2 / macOS
```bash
cd local-gpu-server
./setup_unix.sh
./start_unix.sh
```

## API
| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | `ok`, `gpu`, `cuda`, `vram_gb`, `vram_free_gb`, `model_loaded`, `ffmpeg`, `transcriber` |
| `/separate?piano_only=false&transcribe=true` | POST | `multipart/form-data` field `file`. Returns stem URLs plus `transcription` (`bpm` and per-stem notes as `[start_sec, end_sec, midi, velocity]`) |
| `/stems/{job_id}/{stem}.wav` | GET | Streams a 16-bit stereo WAV stem |
| `/stems/{job_id}` | DELETE | Deletes a job's temp files (they also expire after 30 minutes) |
| `/unload` | POST | Frees the Demucs model from VRAM (handy before a big ComfyUI job) |

### Sharing the GPU with other apps
Only one separation runs at a time, and VRAM is released after each job. If the GPU is full (for example, ComfyUI has a large model loaded), `/separate` returns HTTP 503 with a message asking you to free VRAM. Unload ComfyUI's models (Manager → *Unload Models*) or close it, then try again.

### Security
CORS and Chrome's Private Network Access preflight are allowed only for `http(s)://localhost`, `127.0.0.1`, or `[::1]` origins, so other websites can't send files to your server. Override with the `STEMFORGE_ALLOWED_ORIGIN_REGEX` environment variable if needed.
