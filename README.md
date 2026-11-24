# StemForge

Free, local-first audio stem separator, MIDI studio, and guitar/bass tablature, chord, and sheet music workstation. Everything runs on your own PC. No accounts, API keys, or uploads to the cloud.

- **5-Stem Separation**: Splits MP3, WAV, FLAC, OGG, M4A, AAC (and the audio of MP4 / MOV / MKV / WEBM videos) into **Vocals, Guitar, Bass, Drums, and Keyboards**.
- **Two Engines**:
  - **Local GPU (`local-gpu-server/`)**: Meta's **`htdemucs_6s`** neural separator on your NVIDIA GPU (a 4-minute song takes seconds on an RTX 4070), plus Spotify's **Basic Pitch** for *polyphonic* note transcription (chords included) and librosa tempo detection.
  - **Browser STFT fallback**: Runs entirely in the browser (STFT + HPSS + Wiener masking) with zero setup. MIDI in this mode is single-note only.
- **Mixer**: Mute/Solo, Instrumental / Vocals Only / Bass & Drums presets, per-stem faders, pitch transpose (±6 semitones), speed (0.75×–1.25×), loop, metronome, and per-stem 16-bit WAV export.
- **MIDI Studio**: Piano rolls for **Keyboards, Guitar, Bass, Vocals** plus a GM **Drums** grid, 1/4–1/16 quantize, velocity filter, synth preview, and `.mid` export per stem or as one multi-track **All Stems** file.
- **Notation**: Guitar (6-string) and Bass (4-string) **Tablature** with chord-aware fingering (Standard, Drop D, Eb), chord diagrams, on-screen sheet music, and exports as ASCII `.txt`, `.svg`, and **MusicXML** (notation + TAB staves, or a full band score) for MuseScore, Guitar Pro, Sibelius, Finale, and Dorico.

---

## Quick Start (Windows)

Prerequisites: **Node.js 20+**, **Python 3.10–3.12 (64-bit)**, **FFmpeg** on `PATH`, and a recent **NVIDIA driver**. See **[SETUP.md](./SETUP.md)** for details and troubleshooting.

```powershell
git clone https://github.com/petrafan007/StemForge.git
cd StemForge
npm install

# One-time GPU engine setup (creates an isolated local-gpu-server\.venv)
cd local-gpu-server
.\setup_windows.ps1
cd ..

# Every time: start the GPU server + web app (or double-click "Start StemForge.cmd")
.\start-stemforge.ps1
```

Then in the app (http://localhost:3000): **Library** → **Local GPU (Demucs RTX)** → **Test GPU Connection** → drop a song or video.

### Desktop app (StemForge.exe + desktop shortcut)

```powershell
.\desktop\build-desktop-app.ps1
```

This builds `StemForge.exe` in the StemForge folder and adds a **StemForge** shortcut to your desktop. Double-click it and StemForge:
1. starts the GPU server in the background (no console window), which also serves the app at http://127.0.0.1:8000,
2. opens StemForge in its own app window (Edge/Chrome app mode) with the GPU engine already selected,
3. stops the server and frees GPU memory when you close the window.

It rebuilds the web app automatically when the source changes (for example after a `git pull`). Server output is written to `logs\stemforge-server.log`. The exe is built locally and is not committed to git.

Linux / WSL2 / macOS: `cd local-gpu-server && ./setup_unix.sh && ./start_unix.sh`, then `npm run dev` in the repo root.

---

## Scripts

| Command | Description |
| --- | --- |
| `.\start-stemforge.ps1` | Start the GPU server (new window) and the web app, and open the browser |
| `npm run dev` | Start only the web app on `http://localhost:3000` (this computer only) |
| `npm run build` | Build the production static bundle into `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm test` | Unit tests (DSP, STFT, MIDI, notation, MusicXML, GPU client) |

---

## Repository Structure

```text
├── local-gpu-server/
│   ├── gpu_server.py        # FastAPI + PyTorch CUDA: Demucs htdemucs_6s + Basic Pitch + tempo
│   ├── requirements.txt     # Python dependencies (PyTorch is installed first by the setup script)
│   ├── setup_windows.ps1    # Windows installer (isolated .venv, pinned CUDA PyTorch)
│   ├── start_windows.ps1    # Windows server launcher
│   ├── setup_unix.sh / start_unix.sh
│   └── README.md            # API reference
├── src/
│   ├── audio/
│   │   ├── audioEngine.ts       # Synchronized 5-stem Web Audio playback + master limiter
│   │   ├── demoSongs.ts         # Built-in multi-stem demo songs
│   │   ├── gpuClient.ts         # Local GPU server client (health, separate, unload, note conversion)
│   │   ├── midiEncoder.ts       # Standard MIDI File & 16-bit WAV encoders
│   │   ├── musicXml.ts          # MusicXML 4.0 score writer (notation + TAB, grand staff)
│   │   ├── notationEngine.ts    # Chord-aware tab mapper, chord voicings, staff math
│   │   ├── separationWorker.ts  # Web Worker for browser STFT separation
│   │   ├── stemDsp.ts           # Browser YIN pitch tracker, drum onsets, chroma chords
│   │   ├── stemSeparator.ts     # Engine router (Local GPU / Browser STFT) + project builder
│   │   └── stftSeparator.ts     # STFT + 2D median HPSS + Wiener stem separator
│   ├── components/              # Header, TransportBar, Mixer, MIDI Studio, Notation, Library
│   └── App.tsx
├── start-stemforge.ps1          # One-command launcher (Windows)
└── Start StemForge.cmd          # Double-click launcher (Windows)
```

## Privacy

The web app only listens on `127.0.0.1`, and the GPU server only accepts requests from pages served by `localhost` / `127.0.0.1`. Your audio never leaves your computer. Personal audio, exports, and downloaded model weights are git-ignored.
