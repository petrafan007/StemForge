"""
StemForge Local GPU Server (NVIDIA CUDA + Meta htdemucs_6s + Spotify Basic Pitch)
================================================================================
Runs locally on your PC (e.g. NVIDIA RTX 4070) so StemForge can:

  1. Separate MP3 / WAV / FLAC / OGG / M4A / AAC audio -- or the audio track of
     MP4 / MKV / MOV / WEBM video -- into 5 neural stems:
     Vocals, Guitar, Bass, Drums and Keyboards (Demucs htdemucs_6s on the GPU).
  2. Transcribe the melodic stems to *polyphonic* MIDI notes (chords included)
     with Spotify's Basic Pitch model, and estimate the song tempo.

Setup / start (Windows):  .\\setup_windows.ps1   then   .\\start_windows.ps1
Manual start:  .venv\\Scripts\\python -m uvicorn gpu_server:app --host 127.0.0.1 --port 8000

Model weights are cached in ./models (TORCH_HOME) so nothing is written to the
shared %USERPROFILE%\\.cache\\torch folder used by other tools such as ComfyUI.
"""

from __future__ import annotations

import os
from pathlib import Path

# Keep Demucs weights inside this project (git-ignored) instead of the shared user cache.
_HERE = Path(__file__).resolve().parent
os.environ.setdefault("TORCH_HOME", str(_HERE / "models"))

import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

MODEL_NAME = "htdemucs_6s"
JOB_ROOT = Path(tempfile.gettempdir()) / "stemforge_gpu_jobs"
JOB_ROOT.mkdir(parents=True, exist_ok=True)
JOB_TTL_SECONDS = 60 * 30  # Auto-expire old temp stems after 30 minutes
STEM_NAMES = ("vocals", "guitar", "bass", "drums", "keyboards")

# Only the StemForge web app running on this computer may call the server.
# (Any website you visit could otherwise upload files to http://127.0.0.1:8000.)
_DEFAULT_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
ALLOWED_ORIGIN_REGEX = os.environ.get("STEMFORGE_ALLOWED_ORIGIN_REGEX", _DEFAULT_ORIGIN_REGEX)
_origin_re = re.compile(ALLOWED_ORIGIN_REGEX)

app = FastAPI(title="StemForge Local GPU Server", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_private_network_header(request: Request, call_next):
    """
    Chromium browsers send a Private Network Access preflight when a page talks to
    127.0.0.1. Answer it only for allowed (local) origins.
    """
    origin = request.headers.get("origin")
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network"):
        if not origin or not _origin_re.match(origin):
            return Response(status_code=403)
        resp = Response(status_code=204)
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Vary"] = "Origin"
        return resp

    response = await call_next(request)
    if origin and _origin_re.match(origin):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ---------------------------------------------------------------------------
# Device / model helpers
# ---------------------------------------------------------------------------

_model_lock = threading.Lock()
_gpu_job_lock = threading.Lock()  # one separation at a time keeps VRAM use predictable
_cached_model = None
_cached_device: Optional[str] = None
_jobs: Dict[str, float] = {}


def get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_gpu_name() -> str:
    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "Apple Silicon MPS"
    return "CPU (CUDA not detected)"


def get_vram_info() -> Dict[str, Optional[float]]:
    if not torch.cuda.is_available():
        return {"vram_gb": None, "vram_free_gb": None}
    free_b, total_b = torch.cuda.mem_get_info(0)
    return {
        "vram_gb": round(total_b / (1024**3), 1),
        "vram_free_gb": round(free_b / (1024**3), 1),
    }


def cleanup_expired_jobs() -> None:
    now = time.time()
    expired = [jid for jid, ts in list(_jobs.items()) if now - ts > JOB_TTL_SECONDS]
    for jid in expired:
        _jobs.pop(jid, None)
        shutil.rmtree(JOB_ROOT / jid, ignore_errors=True)


def load_demucs_model():
    global _cached_model, _cached_device
    with _model_lock:
        if _cached_model is not None:
            return _cached_model, _cached_device
        from demucs.pretrained import get_model

        device = get_device()
        model = get_model(MODEL_NAME)
        model.to(device)
        model.eval()
        _cached_model = model
        _cached_device = device
        return _cached_model, _cached_device


def unload_demucs_model() -> bool:
    global _cached_model, _cached_device
    with _model_lock:
        was_loaded = _cached_model is not None
        _cached_model = None
        _cached_device = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return was_loaded


def decode_audio_to_stereo_tensor(input_path: Path, target_sr: int) -> torch.Tensor:
    """
    Decodes audio (or the first audio stream of a video) via ffmpeg -> float32 stereo
    at target_sr, falling back to soundfile (WAV/FLAC/OGG) if ffmpeg is not on PATH.
    """
    if shutil.which("ffmpeg"):
        cmd = [
            "ffmpeg", "-v", "error", "-i", str(input_path),
            "-vn", "-map", "0:a:0",
            "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(target_sr),
            "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode == 0 and len(proc.stdout) > 0:
            audio = np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
            return torch.from_numpy(audio)
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        if input_path.suffix.lower() in {".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"}:
            raise HTTPException(
                status_code=400,
                detail=f"Could not read an audio track from this video ({err[-1] if err else 'ffmpeg failed'}).",
            )

    try:
        data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail="Could not decode this file. Install FFmpeg for MP3/M4A/AAC/video support.",
        ) from exc
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    tensor = torch.from_numpy(data.T.copy())
    if sr != target_sr:
        import torchaudio

        tensor = torchaudio.functional.resample(tensor, sr, target_sr)
    return tensor


def save_wav_16bit(path: Path, tensor_2xN: torch.Tensor, sample_rate: int) -> None:
    arr = tensor_2xN.detach().cpu().numpy().T
    peak = float(np.max(np.abs(arr))) if arr.size > 0 else 0.0
    if peak > 0.98:
        arr = arr * (0.96 / peak)
    sf.write(str(path), arr, sample_rate, subtype="PCM_16")


# ---------------------------------------------------------------------------
# Polyphonic transcription (Spotify Basic Pitch, ONNX on CPU) + tempo
# ---------------------------------------------------------------------------

# Per-stem Basic Pitch settings: frequency range keeps each instrument in its register.
TRANSCRIBE_SETTINGS = {
    "guitar": {"min_freq": 75.0, "max_freq": 1400.0, "onset": 0.5, "frame": 0.3, "min_ms": 70},
    "bass": {"min_freq": 30.0, "max_freq": 400.0, "onset": 0.5, "frame": 0.3, "min_ms": 90},
    "keyboards": {"min_freq": 27.5, "max_freq": 4200.0, "onset": 0.5, "frame": 0.3, "min_ms": 70},
    "vocals": {"min_freq": 75.0, "max_freq": 1100.0, "onset": 0.6, "frame": 0.35, "min_ms": 110},
}

_bp_lock = threading.Lock()
_bp_model = None
_bp_error: Optional[str] = None


def load_basic_pitch():
    """Returns the Basic Pitch model, or None if the package is unavailable."""
    global _bp_model, _bp_error
    with _bp_lock:
        if _bp_model is not None or _bp_error is not None:
            return _bp_model
        try:
            from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
            from basic_pitch.inference import Model

            _bp_model = Model(build_icassp_2022_model_path(FilenameSuffix.onnx))
        except Exception as exc:  # noqa: BLE001
            _bp_error = f"{type(exc).__name__}: {exc}"
            _bp_model = None
        return _bp_model


def transcribe_stem(path: Path, stem: str) -> List[List[float]]:
    """Returns [[start_sec, end_sec, midi_pitch, velocity_1_127], ...] sorted by start."""
    from basic_pitch.inference import predict

    model = load_basic_pitch()
    if model is None:
        return []
    cfg = TRANSCRIBE_SETTINGS[stem]
    _, _, note_events = predict(
        str(path),
        model,
        onset_threshold=cfg["onset"],
        frame_threshold=cfg["frame"],
        minimum_note_length=cfg["min_ms"],
        minimum_frequency=cfg["min_freq"],
        maximum_frequency=cfg["max_freq"],
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    notes = []
    for start, end, pitch, amplitude, _bends in note_events:
        velocity = int(max(1, min(127, round(float(amplitude) * 127))))
        notes.append([round(float(start), 4), round(float(end), 4), int(pitch), velocity])
    notes.sort(key=lambda n: (n[0], n[2]))
    return notes


def estimate_tempo(mono: np.ndarray, sr: int) -> Optional[float]:
    try:
        import librosa

        y = mono[: sr * 120]
        if sr != 22050:
            y = librosa.resample(y, orig_sr=sr, target_sr=22050)
        hop = 256
        tempo, beats = librosa.beat.beat_track(y=y, sr=22050, hop_length=hop)
        bpm = float(np.atleast_1d(tempo)[0])
        # The tempogram estimate is quantized to coarse bins (e.g. 117.45 instead of 120).
        # Refine it with a least-squares fit of the tracked beat times.
        if len(beats) >= 8:
            times = librosa.frames_to_time(beats, sr=22050, hop_length=hop)
            slope = float(np.polyfit(np.arange(len(times)), times, 1)[0])
            if slope > 0:
                refined = 60.0 / slope
                if abs(refined - bpm) / bpm < 0.08:
                    bpm = refined
        if not np.isfinite(bpm) or bpm <= 0:
            return None
        while bpm < 70:
            bpm *= 2
        while bpm > 180:
            bpm /= 2
        return round(bpm, 2)
    except Exception:  # noqa: BLE001
        return None


def run_transcription(job_dir: Path, mix_mono: np.ndarray, sr: int) -> Dict:
    t0 = time.perf_counter()
    if load_basic_pitch() is None:
        return {"engine": None, "error": f"Basic Pitch unavailable ({_bp_error})"}
    stems = list(TRANSCRIBE_SETTINGS.keys())
    with ThreadPoolExecutor(max_workers=len(stems) + 1) as pool:
        tempo_future = pool.submit(estimate_tempo, mix_mono, sr)
        futures = {s: pool.submit(transcribe_stem, job_dir / f"{s}.wav", s) for s in stems}
        notes = {}
        errors = {}
        for stem, fut in futures.items():
            try:
                notes[stem] = fut.result()
            except Exception as exc:  # noqa: BLE001
                notes[stem] = []
                errors[stem] = str(exc)
        bpm = tempo_future.result()
    result = {
        "engine": "basic-pitch",
        "bpm": bpm,
        "notes": notes,
        "elapsed_sec": round(time.perf_counter() - t0, 2),
    }
    if errors:
        result["errors"] = errors
    return result


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    cleanup_expired_jobs()
    info = get_vram_info()
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": get_device(),
        "cuda": torch.cuda.is_available(),
        "gpu": get_gpu_name(),
        "vram_gb": info["vram_gb"],
        "vram_free_gb": info["vram_free_gb"],
        "model_loaded": _cached_model is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "transcriber": "basic-pitch" if load_basic_pitch() is not None else None,
    }


@app.post("/unload")
def unload():
    """Frees the Demucs model from GPU memory (e.g. before a big ComfyUI job)."""
    return {"unloaded": unload_demucs_model()}


def _separate_job(job_id: str, job_dir: Path, in_path: Path, piano_only: bool, transcribe: bool) -> Dict:
    t0 = time.perf_counter()
    with _gpu_job_lock:
        try:
            model, device = load_demucs_model()
            target_sr = int(model.samplerate)
            wav = decode_audio_to_stereo_tensor(in_path, target_sr)

            # Normalize input per Demucs training convention
            ref = wav.mean(0)
            wav_mean = ref.mean()
            wav_std = ref.std() + 1e-8
            wav_norm = (wav - wav_mean) / wav_std

            from demucs.apply import apply_model

            with torch.no_grad():
                sources = apply_model(
                    model,
                    wav_norm.unsqueeze(0).to(device),
                    shifts=1,
                    split=True,
                    overlap=0.25,
                    progress=False,
                )[0]
            sources = (sources * wav_std + wav_mean).cpu()
        except torch.cuda.OutOfMemoryError as exc:
            unload_demucs_model()
            info = get_vram_info()
            raise HTTPException(
                status_code=503,
                detail=(
                    "The GPU ran out of memory"
                    + (f" (only {info['vram_free_gb']} GB free)" if info["vram_free_gb"] is not None else "")
                    + ". Another program such as ComfyUI is probably holding VRAM -- free its models "
                    "(ComfyUI: Manager > Unload Models) or close it, then try again."
                ),
            ) from exc
        finally:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    source_map = {name: sources[idx] for idx, name in enumerate(model.sources)}
    # htdemucs_6s sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
    keyboards = source_map["piano"] if piano_only else source_map["piano"] + source_map["other"]
    out = {
        "vocals": source_map["vocals"],
        "guitar": source_map["guitar"],
        "bass": source_map["bass"],
        "drums": source_map["drums"],
        "keyboards": keyboards,
    }
    for name, tensor in out.items():
        save_wav_16bit(job_dir / f"{name}.wav", tensor, target_sr)
    in_path.unlink(missing_ok=True)
    separation_sec = round(time.perf_counter() - t0, 2)

    transcription = None
    if transcribe:
        mix_mono = wav.mean(0).numpy().astype(np.float32)
        transcription = run_transcription(job_dir, mix_mono, target_sr)

    return {
        "job_id": job_id,
        "model": MODEL_NAME,
        "device": device,
        "gpu": get_gpu_name(),
        "sample_rate": target_sr,
        "elapsed_sec": separation_sec,
        "stems": {name: f"/stems/{job_id}/{name}.wav" for name in STEM_NAMES},
        "transcription": transcription,
    }


@app.post("/separate")
async def separate(
    file: UploadFile = File(...),
    piano_only: bool = Query(default=False, description="If false, merges Demucs piano + other synths into Keyboards"),
    transcribe: bool = Query(default=True, description="Also transcribe melodic stems to polyphonic MIDI notes"),
):
    cleanup_expired_jobs()

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    _jobs[job_id] = time.time()

    suffix = Path(file.filename or "track.wav").suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", suffix or ""):
        suffix = ".bin"
    in_path = job_dir / f"input{suffix}"

    try:
        size = 0
        with in_path.open("wb") as fh:
            while chunk := await file.read(1024 * 1024):
                fh.write(chunk)
                size += len(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty audio file received.")
        return await run_in_threadpool(_separate_job, job_id, job_dir, in_path, piano_only, transcribe)
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        _jobs.pop(job_id, None)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        _jobs.pop(job_id, None)
        raise HTTPException(status_code=500, detail=f"GPU separation failed: {exc}") from exc


@app.get("/stems/{job_id}/{stem_file}")
def get_stem(job_id: str, stem_file: str):
    if stem_file not in {f"{s}.wav" for s in STEM_NAMES}:
        raise HTTPException(status_code=404, detail="Invalid stem name")
    if not job_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid job ID")
    target = JOB_ROOT / job_id / stem_file
    if not target.exists():
        raise HTTPException(status_code=404, detail="Stem file expired or not found")
    return FileResponse(str(target), media_type="audio/wav", filename=stem_file)


@app.delete("/stems/{job_id}")
def delete_job(job_id: str):
    if not job_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid job ID")
    _jobs.pop(job_id, None)
    shutil.rmtree(JOB_ROOT / job_id, ignore_errors=True)
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Desktop mode: serve the built web app (../dist) from this same server so the
# StemForge.exe launcher only needs one local process: http://127.0.0.1:8000
# (Mounted last so the API routes above always take precedence.)
# ---------------------------------------------------------------------------
_DIST_DIR = Path(os.environ.get("STEMFORGE_DIST_DIR", str(_HERE.parent / "dist")))
if (_DIST_DIR / "index.html").is_file():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="webapp")
