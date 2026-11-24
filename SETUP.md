# StemForge Local PC & GPU Engine Setup Guide

This guide covers every prerequisite, dependency, and command required to run **StemForge** and its bundled **Local GPU Neural Separation Engine (`Demucs htdemucs_6s`)** on your computer (optimized for Windows with an NVIDIA RTX GPU such as an RTX 4070, with Linux/WSL2/macOS equivalents included).

No external API keys, paid subscriptions, or cloud accounts are required—everything runs 100% locally on your machine.

---

## 1. Prerequisites to Install on Your Computer

Install these five tools before setting up the project.

### Windows 10 / 11 (Recommended via PowerShell `winget`)

Open **Windows Terminal** or **PowerShell** and run:

```powershell
# 1. Git (to clone the repository)
winget install --id Git.Git -e

# 2. Node.js 20 LTS or newer (runs the StemForge web app)
winget install --id OpenJS.NodeJS.LTS -e

# 3. Python 3.11 (recommended for PyTorch CUDA + Demucs compatibility)
winget install --id Python.Python.3.11 -e

# 4. FFmpeg (required to decode MP3, M4A, AAC, OGG, and FLAC files cleanly)
winget install --id Gyan.FFmpeg -e
```

> **Important:** After installing these packages, **close and reopen PowerShell** so `git`, `node`, `npm`, `python`, and `ffmpeg` are loaded into your `PATH`.
>
> **Note on Python version:** Use **Python 3.10 or 3.11** (64-bit). Newer versions like Python 3.13+ can occasionally lack prebuilt PyTorch CUDA or Demucs wheels. If you install Python from [python.org](https://www.python.org/downloads/), be sure to check **"Add python.exe to PATH"**.

### NVIDIA GPU Drivers (RTX 4070 / CUDA)
- Install or update to a recent **NVIDIA Game Ready** or **Studio Driver** (version 550+ recommended for CUDA 12.4).
- You do **not** need to install the full NVIDIA CUDA Toolkit separately—PyTorch's `cu124` wheels bundle the CUDA runtime libraries automatically.

### Linux (Ubuntu / Debian / WSL2)
```bash
sudo apt update
sudo apt install -y git nodejs npm python3.11 python3.11-venv python3-pip ffmpeg
```

### Verify Prerequisites
Run these commands in a fresh terminal to confirm everything is installed and visible:

```powershell
git --version
node -v          # Should be v20.x or higher
npm -v
python --version # Should be Python 3.10.x or 3.11.x
ffmpeg -version  # Should print FFmpeg build info
nvidia-smi       # Should list your NVIDIA RTX GPU (e.g. RTX 4070)
```

---

## 2. Clone the Repository & Install Web App Dependencies

```powershell
git clone <YOUR_GITHUB_REPO_URL>
cd <YOUR_REPO_FOLDER>

# Install frontend React / Vite / TypeScript dependencies
npm install
```

### Optional: Verify Web App Installation
```powershell
npm test
npm run lint
```
All 25 unit tests and TypeScript checks should pass.

---

## 3. Set Up the Bundled Local GPU Engine (`local-gpu-server/`)

All GPU backend files (`gpu_server.py`, `requirements.txt`, and setup/start scripts) are already included inside the repository's `local-gpu-server/` folder.

### Option A: Automated Setup Script (Recommended)

#### Windows (PowerShell)
```powershell
cd local-gpu-server
.\setup_windows.ps1
```

> **If PowerShell blocks script execution** (`running scripts is disabled on this system`), run:
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
> ```

#### Linux / WSL2 / macOS
```bash
cd local-gpu-server
chmod +x setup_unix.sh start_unix.sh
./setup_unix.sh
```

What the setup script does automatically:
1. Checks that `python` and `ffmpeg` are available on your `PATH`.
2. Creates an isolated Python virtual environment at `local-gpu-server/.venv`.
3. Upgrades `pip` inside `.venv`.
4. Installs **PyTorch + TorchAudio with CUDA 12.4** (`--index-url https://download.pytorch.org/whl/cu124`).
5. Installs all Python packages from `local-gpu-server/requirements.txt`:
   - `demucs>=4.0.1` (Meta's Hybrid Transformer Demucs `htdemucs_6s` 6-stem model)
   - `fastapi>=0.115.0` (Local HTTP API server)
   - `uvicorn[standard]>=0.32.0` (ASGI web server)
   - `python-multipart>=0.0.12` (Audio file upload handling)
   - `soundfile>=0.12.1` (WAV audio reading/writing)
   - `numpy>=1.26.0` (Audio array processing)
6. Verifies CUDA GPU detection and prints your detected GPU name.

### Option B: Manual Setup Commands (Step-by-Step)

If you prefer to run each step manually (or have a local AI assistant execute them one by one):

```powershell
cd local-gpu-server

# 1. Create and activate the virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1
# (On Linux/macOS: source .venv/bin/activate)

# 2. Upgrade pip
python -m pip install --upgrade pip

# 3. Install PyTorch + TorchAudio with NVIDIA CUDA 12.4 support
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 4. Install Demucs and FastAPI server dependencies
pip install -r requirements.txt

# 5. Verify your NVIDIA GPU is recognized by PyTorch
python -c "import torch; print('CUDA Available:', torch.cuda.is_available(), '| GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None')"
```

Expected output on an RTX 4070:
```text
CUDA Available: True | GPU: NVIDIA GeForce RTX 4070
```

---

## 4. Running StemForge (Daily Workflow)

You will run **two terminals** side by side: one for the GPU server and one for the web app.

### Terminal 1 — Start the Local GPU Server
**Windows (PowerShell):**
```powershell
cd local-gpu-server
.\start_windows.ps1
```
*(Or manually: `.\.venv\Scripts\python.exe -m uvicorn gpu_server:app --host 127.0.0.1 --port 8000`)*

**Linux / WSL2 / macOS:**
```bash
cd local-gpu-server
./start_unix.sh
```

The GPU server will start on **`http://127.0.0.1:8000`**.

### Terminal 2 — Start the StemForge Web App
From the repository root folder:
```powershell
npm run dev
```

Open **`http://localhost:3000`** in Chrome, Edge, Firefox, or Brave.

### Connect StemForge to Your GPU
1. Open the **Library** tab in StemForge.
2. Select **Local GPU (Demucs RTX)**.
3. Confirm the server URL is `http://127.0.0.1:8000` and click **Test GPU Connection**.
   - You should see your GPU name (e.g. `NVIDIA GeForce RTX 4070`) and **`CUDA Ready`**.
4. Drag and drop any **MP3, WAV, FLAC, OGG, M4A, or AAC** song to split it into **Vocals, Guitar, Bass, Drums, and Keyboards**.

> **First-Run Model Download:** The very first time you separate a song, Demucs automatically downloads the `htdemucs_6s` neural model weights (~180 MB) into your user cache (`%USERPROFILE%\.cache\torch\hub\checkpoints` on Windows or `~/.cache/torch/hub/checkpoints` on Linux/macOS). After that, the model stays cached on disk and in GPU VRAM—typical 3–4 minute songs separate in **~8–15 seconds** on an RTX 4070.

---

## 5. Health Check & API Endpoints

With the GPU server running, you can verify it directly in your browser or terminal:

```powershell
curl http://127.0.0.1:8000/health
```

Expected JSON response:
```json
{
  "status": "ok",
  "device": "cuda",
  "gpu": "NVIDIA GeForce RTX 4070",
  "model": "htdemucs_6s",
  "cuda_available": true,
  "ffmpeg_available": true
}
```

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | `GET` | Reports GPU model, CUDA availability, FFmpeg status, and Demucs model name |
| `/separate` | `POST` | Accepts an uploaded audio file (`multipart/form-data`), runs `htdemucs_6s`, and returns stem URLs |
| `/stems/{job_id}/{stem}` | `GET` | Streams each separated WAV stem (`vocals`, `guitar`, `bass`, `drums`, `keyboards`) |
| `/jobs/{job_id}` | `DELETE` | Cleans up temporary stem WAV files (also auto-expires after 30 minutes) |

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `CUDA Available: False` | CPU-only PyTorch was installed, or NVIDIA drivers are outdated | Reinstall PyTorch inside `.venv` using `--index-url https://download.pytorch.org/whl/cu124` and update your NVIDIA driver. |
| `python` not found or wrong version (`3.13+`) | Multiple Python versions installed | Use Python 3.11 explicitly: `py -3.11 -m venv .venv` on Windows. |
| `FFmpeg was not found` / MP3 or M4A fails to decode | FFmpeg isn't installed or terminal wasn't restarted | Run `winget install --id Gyan.FFmpeg -e`, then close and reopen your terminal. |
| PowerShell `UnauthorizedAccess` / script blocked | Default Windows execution policy | Run `powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1` (and same for `start_windows.ps1`). |
| `Address already in use` on port `8000` or `3000` | Another server is using the port | Close the conflicting process, or start `uvicorn` on another port (e.g. `--port 8001`) and update the Server URL in StemForge's Library tab. |
| Browser blocks connection to `127.0.0.1:8000` | Private Network Access prompt in Chromium browsers | Click **Allow** if Chrome/Edge asks to connect to local network devices; `gpu_server.py` already sends `Access-Control-Allow-Private-Network: true`. |
