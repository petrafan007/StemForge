# StemForge Local PC & GPU Engine Setup Guide

This guide covers everything needed to run **StemForge** and its bundled **local GPU engine** (Demucs `htdemucs_6s` separation + Basic Pitch polyphonic transcription) on Windows with an NVIDIA RTX GPU, with Linux/WSL2/macOS notes at the end.

No API keys, subscriptions, or cloud accounts are required.

---

## 1. Prerequisites

Check what you already have first. Install only what's missing, and don't add a second copy of something that already works.

```powershell
git --version
node -v          # v20 or newer
python --version # 3.10, 3.11 or 3.12 (or check: py -0p)
ffmpeg -version
nvidia-smi       # lists your GPU and driver version
```

Install anything missing (Windows, `winget`):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
winget install --id Gyan.FFmpeg -e
```

Close and reopen PowerShell after installing so the new commands are on `PATH`.

**Python version:** use 3.10–3.12 (64-bit). The setup script picks one automatically through the `py` launcher, or you can pass `-Python C:\path\to\python.exe`. Python 3.13+ is not yet supported by all of the audio packages.

**NVIDIA driver:** any recent Game Ready or Studio driver (560+). You do **not** need the CUDA Toolkit, because the PyTorch wheel bundles the CUDA 12.6 runtime.

**Other PyTorch apps (ComfyUI, etc.):** StemForge installs everything into its own `local-gpu-server\.venv` and caches models in `local-gpu-server\models`. It never touches global Python packages, other virtual environments, ComfyUI's embedded Python, or `%USERPROFILE%\.cache\torch`.

---

## 2. Get the Code & Install the Web App

```powershell
git clone https://github.com/petrafan007/StemForge.git
cd StemForge
npm install
npm test        # optional: unit tests
npm run lint    # optional: TypeScript check
```

---

## 3. Set Up the Local GPU Engine (one time)

```powershell
cd local-gpu-server
.\setup_windows.ps1
cd ..
```

> If PowerShell blocks the script, run `powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1`.

The script:
1. Picks Python 3.12/3.11/3.10 and checks for FFmpeg.
2. Creates an isolated virtual environment at `local-gpu-server\.venv`.
3. Installs **PyTorch 2.7.1 + TorchAudio (CUDA 12.6)**, pinned so later updates don't break it.
4. Installs `requirements.txt`: Demucs 4.0.1, FastAPI/uvicorn, soundfile, and the Basic Pitch runtime (onnxruntime, librosa, pretty-midi, …).
5. Installs **Basic Pitch 0.4.0** with `--no-deps`, because its package metadata would otherwise pull an old TensorFlow on Python 3.11+. StemForge uses its ONNX model instead.
6. Verifies CUDA sees your GPU and that the Basic Pitch model loads.

The download is about 3 GB (mostly PyTorch), and the environment takes about 5 GB on disk.

---

## 4. Daily Use

### Desktop app (recommended)

Build the launcher and desktop shortcut once:

```powershell
.\desktop\build-desktop-app.ps1
```

From then on, double-click **StemForge** on your desktop. A small "Starting…" splash appears while the GPU engine loads (about 5–10 seconds). StemForge then opens in its own window with the Local GPU engine already selected. Close the window and the GPU engine stops, giving the VRAM back to ComfyUI or games. If startup fails, check `logs\stemforge-server.log`.

### Developer mode

Double-click **`Start StemForge.cmd`**, or run:

```powershell
.\start-stemforge.ps1
```

This opens the GPU server in its own window (http://127.0.0.1:8000), starts the web app (http://localhost:3000), and opens your browser. Close the windows or press Ctrl+C to stop.

In the app:
1. **Library** → select **Local GPU (Demucs RTX)** → **Test GPU Connection**. You should see your GPU, free VRAM, *Polyphonic MIDI (Basic Pitch)*, and *CUDA Ready*.
2. Drop a song (MP3, WAV, FLAC, OGG, M4A, AAC) or a video (MP4, MOV, MKV, WEBM).
3. Use **Mixer** for stems and WAV export, **MIDI Studio** for per-stem or all-stem `.mid`, and **Notation** for tabs, chords, sheet music, and **MusicXML** (open it in MuseScore to edit or print).

The first separation downloads the `htdemucs_6s` weights (~50 MB) into `local-gpu-server\models`.

---

## 5. Sharing the GPU with ComfyUI

Both apps can be installed side by side without conflicts. While they're running, they share 12 GB of VRAM:
- StemForge uses roughly 3–4 GB during a separation and frees it afterwards.
- If ComfyUI has a large model loaded, a separation can fail with *"The GPU ran out of memory…"*. Unload ComfyUI's models (Manager → *Unload Models*) or close it, then try again.
- Before a big ComfyUI job, click **Free GPU Memory** in StemForge's Library tab to release the separation model.

---

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `CUDA Available: False` | Update the NVIDIA driver; re-run `setup_windows.ps1` (it reinstalls the CUDA PyTorch build). |
| *Basic Pitch not installed* in the Library tab | Re-run `setup_windows.ps1`; check the last line says `Basic Pitch: OK`. |
| MP3/M4A/video won't decode | Install FFmpeg and reopen the terminal. The Library health line should show it's available. |
| *GPU ran out of memory* | Free VRAM in ComfyUI / other GPU apps, or click **Free GPU Memory**. |
| `Address already in use` on 8000 or 3000 | Close the other program, or run `.\local-gpu-server\start_windows.ps1 -Port 8001` and change the server URL in the Library tab. |
| Browser asks to allow access to local network devices | Click **Allow**. The GPU server only answers pages served from localhost. |

---

## Linux / WSL2 / macOS

```bash
sudo apt install -y git nodejs npm python3.12 python3.12-venv ffmpeg   # or your distro's equivalent
npm install
cd local-gpu-server && ./setup_unix.sh && ./start_unix.sh   # terminal 1
npm run dev                                                 # terminal 2 (repo root)
```
