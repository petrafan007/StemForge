# StemForge

Free, local-first stem separator, MIDI studio, and guitar/bass tab and sheet music workstation for Windows with an NVIDIA GPU. Everything runs on your own PC. No accounts, API keys, or uploads.

## What it does

- **Separates songs into tracks:** Vocals, Guitar, Bass, Drums, and Keyboards, plus an optional **Lead / Rhythm guitar split** (center-panned leads vs. hard-panned double-tracked rhythm guitars, common in rock and metal). Works with MP3, WAV, FLAC, OGG, M4A, AAC, AIFF, and the audio of MP4, MOV, MKV, and WEBM videos.
- **Three quality modes** on the GPU:
  - **Fast:** Meta's Demucs (`htdemucs_6s`), single pass.
  - **Balanced:** **BS-RoFormer-SW**, a 6-stem band-split RoFormer with much cleaner guitar and bass stems (about 30 s per 4-minute song on an RTX 4070).
  - **High:** the same model with 4× overlap (about 55 s). Demucs is the automatic fallback if the RoFormer weights are missing.
- **Pick the separation model per song** (Settings → This Song → *Re-separate with this model*, or the default under Settings → Processing):
  - BS-RoFormer SW (6 stems);
  - BS-RoFormer SW with the guitar taken from **becruily's dedicated guitar model** (Mel-Band RoFormer);
  - the two guitar models averaged (an ensemble);
  - Demucs.
  Try them on a song and keep whichever sounds cleanest.
- **Transcribes every part to MIDI:**
  - **Guitar, lead guitar and bass:** a **riff transcriber** built for distorted metal tones. It finds every pick attack, then reads the pitch from the waveform's periodicity rather than its spectrum, so distortion overtones don't become notes. It knows power chords (root + fifth, with or without the octave), follows hammer-ons, pull-offs and slides, and transcribes hard-panned double-tracked guitars separately before merging them. It also drops notes that are really bass, vocal or drum bleed, and uses the tuning's lowest string to keep chord roots in the right octave.
  - **Keys and vocals:** Spotify **Basic Pitch** transcribes polyphonic notes.
  - **Full guitar chords** the riff transcriber can't read: **Basic Pitch** or, optionally, **YourMT3+** (a 2024 multi-instrument transformer; install with `setup_windows.ps1 -WithYourMT3`). Pick per song next to *Re-transcribe*.
  - **Drums:** the optional **ADTOF** neural model, trained on rock and metal charts, or a built-in onset detector.
  - **Clean-up:** distorted power chords are simplified, and silent tracks are skipped, so you don't get phantom notes from bleed.
- **Tempo map, bars, key and time signature** are detected automatically. **Beat This!** tracks every beat and downbeat, so bars and the playhead follow the band's real tempo instead of drifting off a fixed BPM. Anything can be corrected per song, including ½×/2× tempo, a beat-grid nudge, 6/8 or 7/8, and key.
- **Bar lines that follow the music:** where the beat tracker's downbeats agree for several bars in a row that a section starts on another beat, the bar lines move with it, and odd-meter bars (3/4, 5/4 ...) appear in the tab, the sheet music, MusicXML, MIDI and the metronome. In the tab, *Bar lines* lets you start a bar on any beat or remove a bar line; your changes are saved with the song.
- **In-sync playback:** the playhead and the highlighted tab notes follow what you hear. The audio device's output latency is measured and compensated, notes light up at their real attack, and **Settings → Playback Sync** adds a manual delay for Bluetooth headphones.
- **Tabs and sheet music:**
  - Whole-part tab fingering: power-chord shapes, few position shifts in fast passages, and the same riff fingered the same way every time it repeats.
  - **Guitar 1 – Left / Guitar 2 – Right:** double-tracked rhythm guitars each get their own tab, sheet music, MusicXML part, text tab and MIDI track, next to the combined Rhythm Guitar tab. Each guitar's tab holds only that guitar's own notes: notes the other guitar plays (its sound leaking into this side) are left out.
  - **Correct the tab:** *Correct this tab* turns on an editor.
    - Click a fret to select it; type a fret number; ↑/↓ moves the note to another string, Shift+↑/↓ changes the pitch, Delete removes it; click an empty spot on a string to add a note; Ctrl+Z / Ctrl+Y undo and redo.
    - Corrections are saved with the song and used for the sheet music, MIDI and every export. They stay in place when you re-transcribe or change the tempo.
  - **Accuracy on your own music:** mark the bars you've checked (click the bar number) and StemForge scores the automatic transcription against them. Re-transcribe or re-separate with another model and the score shows which one gets your song more right.
  - **Auto-detected tunings:** Standard, Drop D, Eb, D, Drop C#, Drop C, C# and C standard, Drop B, B standard, Drop A, 7- and 8-string, and 4- or 5-string bass.
  - Chord charts (including power chords) and on-screen sheet music.
- **Two rhythm guitar tracks:** double-tracked rhythm guitars panned left and right are split into **Guitar 1 – Left** and **Guitar 2 – Right** mixer tracks, so you can solo either one. The two tracks add up exactly to the original guitar stem. Where the guitars play different notes, the other guitar is removed from each track; where both play the same note at the same moment they can't be told apart by position, so some of the other guitar stays audible there. Can be turned off in **Settings → Processing**.
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
| `npm test` | Unit tests (DSP, STFT, MIDI, notation, MusicXML, score export, music analysis, server API client) |

## Repository structure

```text
├── desktop/                      # StemForge.exe launcher (C#), icon, build script
├── local-gpu-server/
│   ├── gpu_server.py             # FastAPI app: projects, jobs, stems, export, settings, .sfg, web app
│   ├── stemforge_server/
│   │   ├── pipeline.py           # RoFormer / Demucs separation, guitar split, transcription, drums, tempo
│   │   ├── riff.py               # guitar / bass riff transcriber (pick attacks + periodicity)
│   │   ├── sides.py              # left / right rhythm guitar split into two tracks
│   │   ├── mel_band_roformer.py  # Mel-Band RoFormer (becruily guitar model), inference only, MIT
│   │   ├── ymt3_runner.py        # YourMT3+ full-chord transcription in its own process
│   │   ├── beats.py              # Beat This! beats & downbeats -> tempo map
│   │   ├── projects.py           # Project library + .sfg pack/unpack
│   │   ├── export.py             # Mixdown + FFmpeg encoding (Audacity-style options)
│   │   └── settings.py           # %LOCALAPPDATA%\StemForge\settings.json
│   ├── benchmarks/               # synthetic metal songs with answer keys + scoring (mir_eval)
│   ├── tests/                    # server unit tests (python -m unittest discover -s tests)
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
