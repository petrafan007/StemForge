# StemForge

Free, local-first stem separator, MIDI studio, and guitar/bass tab and sheet music workstation for Windows with an NVIDIA GPU. Everything runs on your own PC. No accounts, API keys, or uploads.

## What it does

- **Separates songs into tracks:** Vocals, Guitar, Bass, Drums, and Keyboards, plus an optional **Lead / Rhythm guitar split** (center-panned leads vs. hard-panned double-tracked rhythm guitars, common in rock and metal). Works with MP3, WAV, FLAC, OGG, M4A, AAC, AIFF, and the audio of MP4, MOV, MKV, and WEBM videos.
- **Three quality modes**, all using Meta's Demucs on the GPU:
  - **Fast:** single pass.
  - **Balanced:** 2 passes.
  - **High:** adds the fine-tuned `htdemucs_ft` model for cleaner drums, bass, and vocals (about 50 s per 4-minute song on an RTX 4070).
- **Transcribes every part to MIDI:**
  - **Melodic parts:** Spotify **Basic Pitch** transcribes polyphonic notes (chords included) for guitar(s), bass, keys, and vocal melody.
  - **Drums:** the optional **ADTOF** neural model, trained on rock and metal charts, or a built-in onset detector.
  - **Clean-up:** distorted power chords are simplified, and silent tracks are skipped, so you don't get phantom notes from bleed.
- **Tempo, beat grid, key and time signature** are detected automatically (up to 260 BPM with the Metal preset). Anything can be corrected per song, including ½×/2× tempo, beat-grid nudge, 6/8 or 7/8, and key.
- **Tabs and sheet music:**
  - Chord-aware tab fingering.
  - **Auto-detected tunings:** Standard, Drop D, Eb, D, Drop C#, Drop C, C# and C standard, Drop B, B standard, Drop A, 7- and 8-string, and 4- or 5-string bass.
  - Chord charts (including power chords) and on-screen sheet music.
- **Mixer:** mute, solo, volume, pan, and presets. **Key change** uses true pitch shifting (Rubber Band), so the tempo stays the same. Speed control and a metronome on the beat grid are included.
- **Projects that never get lost:**
  - Every imported song is saved as a draft in `Documents\StemForge\Projects`, and changes autosave.
  - The last song reopens on start.
  - **File → Save project** writes a single **`.sfg`** file. Double-click a `.sfg` in Explorer to open it.
- **Audacity-style export:**
  - **Audio:** WAV, AIFF, FLAC, ALAC, MP3 (CBR/VBR), AAC, Ogg Vorbis, or Opus at any sample rate, bit depth, or bitrate. Choose any tracks, either mixed down (optionally with your mixer settings) or one file per track. Range, fades, peak or loudness normalization, key and tempo, and metadata tags are all supported.
  - **MIDI:** any tracks as one Type 1 file, one Type 0 file, or separate files, with quantize (including triplets), General MIDI instrument per track, and PPQ.
  - **Score:** MusicXML with TAB staves for MuseScore, Guitar Pro, Sibelius, Finale, and Dorico, plus text tabs.
- **Settings page** with **genre presets** (Auto, Rock, **Metal**, Pop, Acoustic) that tune detection sensitivity, the shortest note kept, tempo range, and power-chord clean-up.

---

## Quick start (Windows)

Prerequisites: **Node.js 20+**, **Python 3.10–3.12 (64-bit)**, **FFmpeg** on `PATH`, and a recent **NVIDIA driver**. See **[SETUP.md](./SETUP.md)** for details.

```powershell
git clone https://github.com/petrafan007/StemForge.git
cd StemForge
npm install

# One-time GPU engine setup (isolated local-gpu-server\.venv). Add -WithAdtof for neural drum transcription.
cd local-gpu-server
.\setup_windows.ps1
cd ..

# Build StemForge.exe, the desktop shortcut, and the .sfg file type
.\desktop\build-desktop-app.ps1
```

Then double-click **StemForge** on your desktop. For developer mode, run `.\start-stemforge.ps1` or `npm run dev`.

### Metal and rock

Open **Settings → Genre & Transcription → Metal**, and turn on **Split lead and rhythm guitars**. Import a song. If the tempo is detected at half or double speed, fix it under **Settings → This Song**. Tunings are detected automatically, and you can override them per song.

---

## Scripts

| Command | Description |
| --- | --- |
| `.\desktop\build-desktop-app.ps1` | Build `StemForge.exe`, the desktop shortcut, and the `.sfg` file association |
| `.\start-stemforge.ps1` | Start the GPU engine (new window) and the dev web app |
| `npm run dev` | Web app only on `http://localhost:3000` |
| `npm run build` | Production build into `dist/` (served by the GPU engine in desktop mode) |
| `npm run lint` | TypeScript typecheck |
| `npm test` | Unit tests (DSP, STFT, MIDI, notation, MusicXML, music analysis, server API client) |

## Repository structure

```text
├── desktop/                      # StemForge.exe launcher (C#), icon, build script
├── local-gpu-server/
│   ├── gpu_server.py             # FastAPI app: projects, jobs, stems, export, settings, .sfg, web app
│   ├── stemforge_server/
│   │   ├── pipeline.py           # Demucs separation, guitar split, Basic Pitch, drums, tempo
│   │   ├── projects.py           # Project library + .sfg pack/unpack
│   │   ├── export.py             # Mixdown + FFmpeg encoding (Audacity-style options)
│   │   └── settings.py           # %LOCALAPPDATA%\StemForge\settings.json
│   ├── requirements.txt / setup_windows.ps1 / start_windows.ps1
├── src/
│   ├── audio/                    # audio engine, project model, music analysis, MIDI/MusicXML, server API
│   ├── components/               # Mixer, MIDI Studio, Notation, Library, Settings, Export dialog
│   ├── settings/appSettings.ts   # settings schema, defaults, genre presets
│   └── App.tsx
└── start-stemforge.ps1 / Start StemForge.cmd
```

## Privacy

The GPU engine listens only on `127.0.0.1` and only answers pages served from this computer. Your music, projects, exports, and model weights stay on your PC and are git-ignored.
