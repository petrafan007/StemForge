# StemForge Local GPU Server

The Python backend for StemForge. It runs on http://127.0.0.1:8000 (this computer only) and handles:

1. **Separation:** Meta's **Demucs** on your NVIDIA GPU.
   - **Fast:** `htdemucs_6s`, 1 pass.
   - **Balanced:** `htdemucs_6s`, 2 passes.
   - **High:** `htdemucs_ft` for vocals, bass, and drums, plus `htdemucs_6s` for guitar and piano.
   - **Optional lead/rhythm guitar split:** separates the center-panned guitar from the side-panned guitars.
2. **Transcription:**
   - **Melodic stems:** Spotify **Basic Pitch** (ONNX, CPU) transcribes polyphonic notes for guitar(s), bass, keyboards, and vocals.
   - **Silence gating:** keeps bleed from turning into phantom notes.
   - **Drums:** **ADTOF** if it's installed (`setup_windows.ps1 -WithAdtof`), otherwise a band-limited onset detector.
   - **Tempo:** librosa estimates the tempo and beat-grid offset within a genre-dependent tempo range.
3. **Project library:**
   - **Drafts** are saved in `Documents\StemForge\Projects` by default. The folder can be changed in Settings.
   - **`.sfg`** project files can be packed and unpacked.
4. **Export:** mixes any stems with volume and pan, applies optional Rubber Band pitch shift and time stretch, trims, fades, and normalizes, then encodes with FFmpeg.
5. **Desktop mode:** serves the built web app (`../dist`) for `StemForge.exe`.

Everything installs into `local-gpu-server/.venv`. Demucs weights are cached in `local-gpu-server/models` (`TORCH_HOME`), so other PyTorch tools such as ComfyUI are never touched.

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
