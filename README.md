# StemForge

Free, local-first audio stem separator, MIDI studio, and guitar/bass tablature, chord, and sheet music workstation.

- **5-Stem Separation**: Splits MP3, WAV, FLAC, OGG, M4A, and AAC tracks into **Vocals, Guitar, Bass, Drums, and Keyboards**.
- **Two Separation Engines**:
  - **Local GPU (`local-gpu-server/`)**: Runs Meta's neural **`htdemucs_6s`** model directly on your NVIDIA RTX GPU (e.g. RTX 4070) for Moises-grade studio separation in ~8–15 seconds per song.
  - **Browser STFT Fallback**: Runs 100% in the browser via a Web Worker (2048-point STFT + 2D Median HPSS + Wiener masking) with zero setup.
- **Interactive Mixer**: Mute/Solo per track, 1-click **Instrumental (Mute Vocals)** / **Vocals Only** / **Bass & Drums** presets, per-stem volume faders, pitch transpose (`-6` to `+6` semitones), playback speed (`0.75x`–`1.25x`), loop, metronome click, and per-stem 16-bit WAV export.
- **MIDI Studio**: Transcribes **Keyboards** (Channel 1 Piano Roll) and **Drums** (GM Channel 10 Percussion Grid) with 1/4, 1/8, and 1/16 quantization, velocity filtering, live synth preview, and Standard MIDI File (`.mid`) export.
- **Guitar & Bass Notation**: Interactive 6-string Guitar and 4-string Bass **Tablature** (Standard, Drop D, Eb Standard + ASCII `.txt` export), **Chord Progression & SVG Fretboard Diagrams**, and engraved **SVG Sheet Music** (Treble & Bass clef).

---

## Quick Start (Local Installation)

### Prerequisites
- **Node.js 20+** (for the StemForge web app)
- **Python 3.10 or 3.11** + **FFmpeg** + **NVIDIA CUDA drivers** (for the RTX GPU neural engine in `local-gpu-server/`)

### 1. Install & Run the StemForge Web App
```bash
npm install
npm run dev
```
Open **http://localhost:3000** in your browser. No API keys or accounts are required.

### 2. Install & Start the Local GPU Server (NVIDIA RTX 4070 / CUDA)
The complete GPU server is already included in [`local-gpu-server/`](./local-gpu-server).

**Windows (PowerShell):**
```powershell
cd local-gpu-server
.\setup_windows.ps1
.\start_windows.ps1
```

**Linux / WSL2 / macOS:**
```bash
cd local-gpu-server
chmod +x setup_unix.sh start_unix.sh
./setup_unix.sh
./start_unix.sh
```

Once `uvicorn` is running at `http://127.0.0.1:8000`:
1. Open StemForge (**http://localhost:3000**) → **Library** tab.
2. Select **Local GPU (Demucs RTX)**.
3. Click **Test GPU Connection** (confirms your GPU model, VRAM, and `CUDA Ready`).
4. Drop any MP3, WAV, or FLAC file to separate it on your GPU.

---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite development server on `http://localhost:3000` |
| `npm run build` | Build production static bundle to `dist/` |
| `npm run preview` | Preview production build locally |
| `npm run lint` | Run TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Run all DSP, STFT, MIDI, Notation, and GPU client unit tests |

---

## Repository Structure

```text
├── local-gpu-server/
│   ├── gpu_server.py        # FastAPI + PyTorch CUDA + Demucs htdemucs_6s server
│   ├── requirements.txt     # Python dependencies for GPU server
│   ├── setup_windows.ps1    # One-command Windows RTX CUDA virtualenv installer
│   ├── start_windows.ps1    # One-command Windows server launcher
│   ├── setup_unix.sh        # One-command Linux/macOS installer
│   ├── start_unix.sh        # One-command Linux/macOS launcher
│   └── README.md            # Detailed GPU setup & troubleshooting guide
├── src/
│   ├── audio/
│   │   ├── audioEngine.ts       # Synchronized 5-stem Web Audio playback + master limiter
│   │   ├── demoSongs.ts         # 3 built-in multi-stem synthesized studio demos
│   │   ├── gpuClient.ts         # Local GPU server HTTP client & health checker
│   │   ├── midiEncoder.ts       # Standard MIDI File (Format 1) & 16-bit WAV encoder
│   │   ├── notationEngine.ts    # Fretboard tab mapper, chord detector & SVG staff math
│   │   ├── separationWorker.ts  # Off-thread Web Worker for STFT separation
│   │   ├── stemDsp.ts           # YIN pitch tracker, drum onset & chroma chord extractor
│   │   ├── stemSeparator.ts     # Dual-engine router (Local GPU Demucs / Browser STFT)
│   │   └── stftSeparator.ts     # 2048-pt STFT + 2D Median HPSS + Wiener stem separator
│   ├── components/
│   │   ├── Header.tsx           # Top workspace navigation
│   │   ├── TransportBar.tsx     # Play/Pause/Loop/Click/Key Transpose/Speed/Scrubber
│   │   ├── MixerView.tsx        # 5-stem waveforms, Mute/Solo, faders, presets, WAV export
│   │   ├── MidiStudioView.tsx   # Keyboards Piano Roll + GM Drums Grid + .mid export
│   │   ├── NotationView.tsx     # Guitar/Bass Tablature, Chord Diagrams & SVG Sheet Music
│   │   └── LibraryView.tsx      # GPU Engine setup, Audio Uploader & Studio Demos
│   └── App.tsx
└── package.json
```
