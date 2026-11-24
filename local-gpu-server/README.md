# StemForge Local GPU Server

The Python backend for StemForge. It runs on http://127.0.0.1:8000 (this computer only) and handles:

1. **Separation** on your NVIDIA GPU:
   - **Fast:** Meta's Demucs `htdemucs_6s`, 1 pass.
   - **Balanced:** **BS-RoFormer-SW** (6 stems: vocals, guitar, bass, drums, piano, other), 2× overlap.
   - **High:** BS-RoFormer-SW with 4× overlap. Falls back to Demucs (`htdemucs_ft` + `htdemucs_6s`) if the RoFormer weights aren't installed.
   - **Optional lead/rhythm guitar split:** separates the center-panned guitar from the side-panned guitars.
2. **Transcription:**
   - **Guitar / lead / bass:** the riff transcriber (`stemforge_server/riff.py`):
     - one note per pick attack, from a SuperFlux-style onset detector weighted toward pick noise;
     - pitch from the YIN periodicity of the waveform, which is robust to distortion: single note vs. power chord (± octave) vs. not periodic;
     - pitch changes followed inside held notes (legato, slides);
     - left and right guitars transcribed separately, then merged;
     - when the two guitars play different parts somewhere (stretches where most of their attacks differ in pitch, not just scattered misreadings), each one is also kept as its own part (`transcription.guitarParts`: left / right). Where they play the same riff, both parts get the merged notes; elsewhere each part keeps its own notes, with Basic Pitch run on its own channel for full chords;
     - bleed from the bass, vocal and drum stems rejected;
     - the tuning's lowest string estimated in a first pass.
     Basic Pitch is used only where the audio isn't periodic (full chords).
   - **Keyboards and vocals:** Spotify **Basic Pitch** (ONNX, CPU) transcribes polyphonic notes.
   - **Silence gating:** keeps bleed from turning into phantom notes.
   - **Drums:** **ADTOF** if it's installed (`setup_windows.ps1 -WithAdtof`), otherwise a band-limited onset detector.
   - **Tempo map:** **Beat This!** (CPJKU, ISMIR 2024) finds every beat and downbeat. The beats are kept at one metrical level for the whole song (half-time and double-time stretches are folded), and bar lines come from the downbeats. librosa is the fallback.
3. **Project library:**
   - **Drafts** are saved in `Documents\StemForge\Projects` by default. The folder can be changed in Settings.
   - **`.sfg`** project files can be packed and unpacked.
4. **Export:** mixes any stems with volume and pan, applies optional Rubber Band pitch shift and time stretch, trims, fades, and normalizes, then encodes with FFmpeg.
5. **Desktop mode:** serves the built web app (`../dist`) for `StemForge.exe`.

Everything installs into `local-gpu-server/.venv`. Model weights (Demucs, BS-RoFormer-SW, Beat This!) live in `local-gpu-server/models`, so other PyTorch tools such as ComfyUI are never touched. `setup_windows.ps1` downloads the RoFormer and Beat This! weights and checks their SHA-256 hashes. Both are loaded tensors-only (`torch.load(weights_only=True)`).

### Benchmarks

`benchmarks/` renders synthetic metal songs with an exact answer key: Karplus-Strong guitars through an amp simulation, drop and standard tunings, chugs, gallops, tremolo, runs and power chords. Songs 1 and 2 double-track the rhythm guitars in unison. In song 3 the right guitar doubles runs a fifth up, harmonises a melody in thirds and plays its own melody over a chug riff, and each guitar has its own answer key. The transcribers are scored with mir_eval:

```powershell
.\.venv\Scripts\python.exe benchmarks\synth_metal.py benchmarks\data
.\.venv\Scripts\python.exe benchmarks\evaluate.py benchmarks\data --sep oraclebleed --methods current,riff --parts rhythm,bass,lead
.\.venv\Scripts\python.exe benchmarks\evaluate.py benchmarks\data --sep oraclebleed --methods riff --parts rhythm,left,right
```

Results (F-measure: 50 ms onset tolerance, 50 cents pitch tolerance):

| Part | Basic Pitch (previous engine) | Riff transcriber |
| --- | --- | --- |
| Rhythm guitar | F 0.67–0.72 (150–160 phantom notes/min) | F 0.92–0.96 (25–28 phantom notes/min) |
| Bass | F 0.30–0.44 (~200 phantom notes/min) | F 1.00 (0–2 phantom notes/min) |
| Lead guitar | F 0.05–0.06 (bleed became notes) | F 0.89–0.91 |

Both columns use the same stems: the true parts with simulated bleed from the other instruments (`--sep oraclebleed`).

Separate guitar parts, measured the same way:

- **Unison songs (1, 2):** no separate parts are made, which is correct.
- **Twin-guitar song (3):** separate parts are made. Each guitar is scored against its own take:
  - left guitar: F 0.90 (0.87 without the shared notes in unison sections);
  - right guitar: F 0.93;
  - combined rhythm guitar: F 0.93 against both takes together.
  - In the harmony sections each part keeps 92–97% of its notes.

The unit tests for this logic run with `.\.venv\Scripts\python.exe -m unittest discover -s tests`.

## Setup

```powershell
cd local-gpu-server
.\setup_windows.ps1              # add -WithAdtof for neural drum transcription
.\start_windows.ps1              # or use StemForge.exe / ..\start-stemforge.ps1
```

## API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | GPU, VRAM, models loaded, FFmpeg, transcribers, projects folder |
| `/settings` | GET / PUT | App settings JSON (`%LOCALAPPDATA%\StemForge\settings.json`) |
| `/projects` | GET | List project drafts (with live processing progress) |
| `/projects` | POST | Multipart `file` + `options` JSON (quality, splitGuitars, sensitivity, tempo range…). Starts a background job and returns `{id}` |
| `/projects/{id}` | GET | Full project document: analysis, transcription, saved state |
| `/projects/{id}/status` | GET | Job `status`, `stage`, `percent`, `error` |
| `/projects/{id}/state` | PUT | Autosave the user's state (mixer, tempo/key overrides, tunings…) and names |
| `/projects/{id}/reprocess` | POST | Re-run with new options (`separate: false` re-transcribes only) |
| `/projects/{id}/cancel` | POST | Cancel a running job |
| `/projects/{id}` | DELETE | Move the project to `<projects folder>/.trash` |
| `/projects/{id}/stems/{stem}.flac?transpose=N` | GET | Stream a stem. With `transpose`, returns a cached Rubber Band pitch-shifted copy |
| `/projects/{id}/sfg?original=true` | GET | Download the project as a `.sfg` file |
| `/projects/import` | POST | Import an uploaded `.sfg` file |
| `/projects/import-path` | POST | Import a local `.sfg` path (used by `StemForge.exe` for double-clicked files) |
| `/projects/{id}/export/audio` | POST | Render and encode an export (format, sampleRate, bitDepth, bitrate, tracks with gain/pan, range, fades, normalize, transpose/tempo, metadata) |
| `/dialog/folder` | POST | Native folder picker (for choosing the projects folder) |
| `/reveal` | POST | Open the projects folder (or one project) in Explorer |
| `/unload` | POST | Free GPU memory (e.g. before a big ComfyUI job) |

### Sharing the GPU
Only one separation runs at a time, and VRAM is released after each job. If the GPU is full (for example, ComfyUI has a big model loaded), the job fails with a clear message. Unload ComfyUI's models, or use Settings → Free GPU memory, then try again.

### Security
CORS and Chrome's Private Network Access preflight are allowed only for `localhost`, `127.0.0.1`, or `[::1]` origins. You can override this with `STEMFORGE_ALLOWED_ORIGIN_REGEX`. `/projects/import-path` accepts only existing `.sfg` files.
