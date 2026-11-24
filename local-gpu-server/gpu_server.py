"""
StemForge Local GPU Server
==========================
Runs on http://127.0.0.1:8000 (this computer only) and provides:

  * Project library ("drafts"): every imported song is saved to a project folder
    (default Documents\\StemForge\\Projects) and survives closing the app.
  * Processing jobs with live progress: Demucs separation on the NVIDIA GPU (Fast / Balanced /
    High quality), optional lead/rhythm guitar split, Basic Pitch polyphonic transcription,
    drum transcription (ADTOF when installed) and tempo / beat-grid detection.
  * .sfg project files (open / save), Audacity-style audio export through FFmpeg, settings.
  * The built web app (../dist) for the StemForge.exe desktop launcher.

Start (Windows):  .\\start_windows.ps1   (or StemForge.exe / ..\\start-stemforge.ps1)
"""

from __future__ import annotations

import os
from pathlib import Path

_HERE = Path(__file__).resolve().parent
os.environ.setdefault("TORCH_HOME", str(_HERE / "models"))

import json
import re
import shutil
import tempfile
import threading
from typing import Any, Dict, Optional

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from stemforge_server import SERVER_VERSION, export as sf_export, pipeline, projects, settings
from stemforge_server.pipeline import JobCancelled, ProcessOptions, Progress

# Only the StemForge web app running on this computer may call the server.
_DEFAULT_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"
ALLOWED_ORIGIN_REGEX = os.environ.get("STEMFORGE_ALLOWED_ORIGIN_REGEX", _DEFAULT_ORIGIN_REGEX)
_origin_re = re.compile(ALLOWED_ORIGIN_REGEX)

app = FastAPI(title="StemForge Local GPU Server", version=SERVER_VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


@app.middleware("http")
async def private_network_access(request: Request, call_next):
    """Answer Chromium's Private Network Access preflight only for local origins."""
    origin = request.headers.get("origin")
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network"):
        if not origin or not _origin_re.match(origin):
            return Response(status_code=403)
        resp = Response(status_code=204)
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        resp.headers["Vary"] = "Origin"
        return resp
    response = await call_next(request)
    if origin and _origin_re.match(origin):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ----------------------------------------------------------------------------- helpers


def _http(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except projects.ProjectError as exc:
        raise HTTPException(status_code=404 if "not found" in str(exc).lower() else 400, detail=str(exc)) from exc


def _safe_filename(name: str, fallback: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name or "").strip(" .")
    return cleaned[:150] or fallback


async def _save_upload(upload: UploadFile, dest: Path) -> int:
    size = 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as fh:
        while chunk := await upload.read(1024 * 1024):
            fh.write(chunk)
            size += len(chunk)
    return size


def _delete_file(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


# ----------------------------------------------------------------------------- jobs

_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _job_status(pid: str) -> Dict[str, Any]:
    with _jobs_lock:
        job = _jobs.get(pid)
        if job:
            return {k: v for k, v in job.items() if k != "cancel"}
    doc = _http(projects.load, pid)
    status = doc.get("status", "ready")
    return {"status": status, "stage": None, "percent": 100 if status == "ready" else 0, "error": doc.get("error")}


def _start_job(pid: str, opts: ProcessOptions, *, is_new: bool) -> None:
    cancel_event = threading.Event()
    with _jobs_lock:
        if pid in _jobs and _jobs[pid]["status"] == "processing":
            raise HTTPException(status_code=409, detail="This song is already being processed.")
        _jobs[pid] = {"status": "processing", "stage": "Waiting for the GPU", "percent": 0, "error": None, "cancel": cancel_event}

    def on_progress(stage: str, percent: float) -> None:
        with _jobs_lock:
            _jobs[pid].update(stage=stage, percent=round(percent, 1))

    def worker() -> None:
        try:
            doc = projects.load(pid)
            original = projects.original_path(pid)
            if original is None:
                raise RuntimeError("The original audio file for this project is missing, so it cannot be re-analyzed.")
            if not is_new:
                projects.update(pid, status="processing", error=None)
            result = pipeline.run_job(
                projects.project_dir(pid), original, opts, Progress(on_progress, cancel_event), existing_stems=doc.get("stems") or []
            )
            doc = projects.load(pid)
            doc["status"] = "ready"
            doc["error"] = None
            doc["stems"] = result["stems"]
            doc["analysis"] = result["analysis"]
            doc["transcription"] = result["transcription"]
            src = doc.setdefault("source", {})
            src["durationSec"] = result["durationSec"]
            proc = doc.setdefault("processing", {})
            proc["options"] = opts.to_dict()
            if result.get("separation"):
                proc.update(
                    {
                        "separation": result["separation"],
                        "device": pipeline.get_device(),
                        "gpu": pipeline.get_gpu_name(),
                        "quality": opts.quality,
                    }
                )
            doc["updatedAt"] = projects.now_iso()
            projects.save(pid, doc)
            with _jobs_lock:
                _jobs[pid].update(status="ready", stage="Done", percent=100)
        except JobCancelled:
            with _jobs_lock:
                _jobs[pid].update(status="cancelled", stage="Cancelled", error=None)
            try:
                if is_new:
                    projects.trash(pid)
                else:
                    projects.update(pid, status="ready")
            except Exception:  # noqa: BLE001
                pass
        except Exception as exc:  # noqa: BLE001
            msg = str(exc) or type(exc).__name__
            with _jobs_lock:
                _jobs[pid].update(status="error", error=msg)
            try:
                if is_new:
                    projects.update(pid, status="error", error=msg)
                else:
                    projects.update(pid, status="ready")
            except Exception:  # noqa: BLE001
                pass

    threading.Thread(target=worker, name=f"job-{pid}", daemon=True).start()


def _recover_interrupted() -> None:
    try:
        for p in projects.list_projects():
            if p["status"] == "processing":
                projects.update(p["id"], status="error", error="Processing was interrupted (StemForge was closed).")
    except Exception:  # noqa: BLE001
        pass


_recover_interrupted()

# ----------------------------------------------------------------------------- health & settings


@app.get("/health")
def health():
    info = pipeline.vram_info()
    return {
        "ok": True,
        "version": SERVER_VERSION,
        "model": "htdemucs_6s",
        "device": pipeline.get_device(),
        "cuda": pipeline.get_device() == "cuda",
        "gpu": pipeline.get_gpu_name(),
        "vram_gb": info["vram_gb"],
        "vram_free_gb": info["vram_free_gb"],
        "model_loaded": bool(pipeline.loaded_models()),
        "models_loaded": pipeline.loaded_models(),
        "ffmpeg": pipeline.ffmpeg_available(),
        "transcriber": "basic-pitch" if pipeline.basic_pitch_model() is not None else None,
        "drum_transcriber": "adtof" if pipeline.adtof_available() else "onsets",
        "projects_dir": str(settings.projects_dir()),
        "projects": True,
    }


@app.post("/unload")
def unload():
    """Frees the separation / drum models from GPU memory (e.g. before a big ComfyUI job)."""
    return {"unloaded": pipeline.unload_models()}


@app.get("/settings")
def get_settings():
    return {
        "settings": settings.load_settings(),
        "defaultProjectsDir": str(settings.default_projects_dir()),
        "projectsDir": str(settings.projects_dir()),
    }


@app.put("/settings")
def put_settings(body: Dict[str, Any] = Body(...)):
    data = body.get("settings") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail='Expected {"settings": {...}}')
    folder = (data.get("projects") or {}).get("folder") if isinstance(data.get("projects"), dict) else None
    if folder:
        try:
            Path(os.path.expandvars(folder)).mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"Cannot use that projects folder: {exc}") from exc
    try:
        settings.save_settings(data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"settings": data, "projectsDir": str(settings.projects_dir())}


def _pick_folder(initial: Optional[str]) -> Optional[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        path = filedialog.askdirectory(
            initialdir=initial or str(settings.documents_dir()), title="Choose a folder for StemForge", mustexist=False
        )
    finally:
        root.destroy()
    return os.path.normpath(path) if path else None


@app.post("/dialog/folder")
async def dialog_folder(body: Dict[str, Any] = Body(default={})):
    initial = body.get("initial") if isinstance(body, dict) else None
    try:
        path = await run_in_threadpool(_pick_folder, initial if isinstance(initial, str) else None)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"Could not open the folder picker: {exc}") from exc
    return {"path": path}


@app.post("/reveal")
def reveal(body: Dict[str, Any] = Body(default={})):
    """Opens the projects folder (or one project's folder) in Windows Explorer."""
    pid = body.get("projectId") if isinstance(body, dict) else None
    target = _http(projects.project_dir, pid) if pid else settings.projects_dir()
    if not target.exists():
        raise HTTPException(status_code=404, detail="Folder not found.")
    if hasattr(os, "startfile"):
        os.startfile(str(target))  # noqa: S606 - opens Explorer on a folder StemForge owns
    return {"path": str(target)}


# ----------------------------------------------------------------------------- projects


@app.get("/projects")
def list_all_projects():
    items = projects.list_projects()
    with _jobs_lock:
        for it in items:
            job = _jobs.get(it["id"])
            if job and job["status"] == "processing":
                it["status"] = "processing"
                it["stage"] = job["stage"]
                it["percent"] = job["percent"]
    return {"projects": items, "projectsDir": str(settings.projects_dir())}


@app.post("/projects")
async def create_project(file: UploadFile = File(...), options: str = Form(default="{}")):
    try:
        opts_raw = json.loads(options or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid options JSON.") from exc
    if not isinstance(opts_raw, dict):
        opts_raw = {}
    opts = ProcessOptions.from_dict(opts_raw)
    opts.separate = True

    file_name = _safe_filename(Path(file.filename or "song").name, "song.wav")
    title_guess = Path(file_name).stem
    pid = projects.new_project_id(title_guess)
    d = projects.project_dir(pid)
    ext = Path(file_name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext or ""):
        ext = ".bin"
    original = d / f"original{ext}"
    size = await _save_upload(file, original)
    if size == 0:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(status_code=400, detail="Empty file received.")

    info = await run_in_threadpool(pipeline.probe, original)
    tags = info.get("tags") or {}
    clean_title = re.sub(r"^\d{1,3}\s*[-._ ]\s*", "", title_guess).replace("_", " ").strip() or title_guess
    now = projects.now_iso()
    initial_state = opts_raw.get("initialState")
    doc = {
        "title": tags.get("title") or clean_title,
        "artist": tags.get("artist") or "",
        "album": tags.get("album") or "",
        "createdAt": now,
        "updatedAt": now,
        "status": "processing",
        "error": None,
        "source": {
            "fileName": file_name,
            "format": ext.lstrip(".").upper(),
            "durationSec": info.get("durationSec"),
            "sampleRate": info.get("sampleRate"),
            "channels": info.get("channels"),
            "sizeBytes": size,
        },
        "processing": {"options": opts.to_dict(), "quality": opts.quality},
        "stems": [],
        "state": initial_state if isinstance(initial_state, dict) else {},
    }
    projects.save(pid, doc)
    _start_job(pid, opts, is_new=True)
    return {"id": pid, "title": doc["title"]}


@app.get("/projects/{pid}")
def get_project(pid: str):
    return _http(projects.load, pid)


@app.get("/projects/{pid}/status")
def project_status(pid: str):
    return _job_status(pid)


@app.put("/projects/{pid}/state")
def put_state(pid: str, body: Dict[str, Any] = Body(...)):
    state = body.get("state") if isinstance(body, dict) else None
    if not isinstance(state, dict):
        raise HTTPException(status_code=400, detail='Expected {"state": {...}}')
    if len(json.dumps(state)) > 2_000_000:
        raise HTTPException(status_code=413, detail="Project state is too large.")
    meta = {k: body.get(k) for k in ("title", "artist", "album") if isinstance(body.get(k), str)}
    doc = _http(projects.save_state, pid, state, meta)
    return {"ok": True, "updatedAt": doc.get("updatedAt")}


@app.post("/projects/{pid}/reprocess")
def reprocess(pid: str, body: Dict[str, Any] = Body(default={})):
    doc = _http(projects.load, pid)
    opts = ProcessOptions.from_dict(body)
    if not doc.get("stems"):
        opts.separate = True
    _start_job(pid, opts, is_new=False)
    return {"ok": True}


@app.post("/projects/{pid}/cancel")
def cancel(pid: str):
    with _jobs_lock:
        job = _jobs.get(pid)
        if not job or job["status"] != "processing":
            return {"cancelled": False}
        job["cancel"].set()
    return {"cancelled": True}


@app.delete("/projects/{pid}")
def delete_project(pid: str):
    with _jobs_lock:
        job = _jobs.get(pid)
        if job and job["status"] == "processing":
            raise HTTPException(status_code=409, detail="Cancel processing before deleting this song.")
    dest = _http(projects.trash, pid)
    return {"deleted": True, "trashPath": str(dest)}


_pitch_locks: Dict[str, threading.Lock] = {}
_pitch_locks_guard = threading.Lock()


def _pitch_shifted_stem(src: Path, dest: Path, semitones: int) -> Path:
    """Renders (once) a pitch-shifted copy of a stem with Rubber Band; tempo is unchanged."""
    with _pitch_locks_guard:
        lock = _pitch_locks.setdefault(str(dest), threading.Lock())
    with lock:
        if dest.is_file() and dest.stat().st_mtime >= src.stat().st_mtime:
            return dest
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".tmp.flac")
        ratio = 2 ** (semitones / 12.0)
        cmd = [
            "ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src),
            "-af", f"rubberband=pitch={ratio:.6f}:pitchq=quality",
            "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", str(tmp),
        ]
        import subprocess

        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail="Pitch shifting failed: " + proc.stderr.decode("utf-8", "replace")[-300:])
        os.replace(tmp, dest)
        return dest


@app.get("/projects/{pid}/stems/{stem_file}")
async def get_stem(pid: str, stem_file: str, transpose: int = 0):
    if not stem_file.endswith(".flac"):
        raise HTTPException(status_code=404, detail="Invalid stem name")
    stem = stem_file[: -len(".flac")]
    p = _http(projects.stem_path, pid, stem)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="Stem not found")
    transpose = max(-12, min(12, int(transpose)))
    if transpose and stem != "drums":
        cached = projects.project_dir(pid) / "cache" / f"pitch{transpose:+d}" / stem_file
        p = await run_in_threadpool(_pitch_shifted_stem, p, cached, transpose)
    return FileResponse(str(p), media_type="audio/flac", filename=stem_file)


@app.get("/projects/{pid}/sfg")
async def download_sfg(pid: str, original: bool = True):
    doc = _http(projects.load, pid)
    path = await run_in_threadpool(_http, projects.pack_sfg, pid, original)
    name = _safe_filename(doc.get("title") or pid, "project") + ".sfg"
    return FileResponse(
        str(path), media_type="application/x-stemforge-project", filename=name, background=BackgroundTask(_delete_file, path)
    )


@app.post("/projects/import")
async def import_sfg(file: UploadFile = File(...)):
    fd, tmp = tempfile.mkstemp(suffix=".sfg")
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        await _save_upload(file, tmp_path)
        pid = await run_in_threadpool(_http, projects.unpack_sfg, tmp_path)
    finally:
        _delete_file(tmp_path)
    return {"id": pid}


@app.post("/projects/import-path")
async def import_sfg_path(body: Dict[str, Any] = Body(...)):
    """Used by StemForge.exe when a .sfg file is double-clicked in Explorer."""
    raw = body.get("path") if isinstance(body, dict) else None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail="Missing path.")
    p = Path(raw)
    if p.suffix.lower() != ".sfg" or not p.is_file():
        raise HTTPException(status_code=400, detail="Only existing .sfg files can be opened.")
    pid = await run_in_threadpool(_http, projects.unpack_sfg, p)
    return {"id": pid}


@app.post("/projects/{pid}/export/audio")
async def export_audio(pid: str, spec: Dict[str, Any] = Body(...)):
    doc = _http(projects.load, pid)
    stems_dir = projects.project_dir(pid) / "stems"
    separation = (doc.get("processing") or {}).get("separation") or {}
    spec["stemGain"] = separation.get("gain", 1.0)  # restores the original song level
    try:
        path, ext, mime = await run_in_threadpool(sf_export.export_audio, stems_dir, spec)
    except sf_export.ExportError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    base = spec.get("fileName") if isinstance(spec.get("fileName"), str) else (doc.get("title") or pid)
    if base.lower().endswith(ext):
        base = base[: -len(ext)]
    name = _safe_filename(base, "export") + ext
    return FileResponse(str(path), media_type=mime, filename=name, background=BackgroundTask(_delete_file, path))


# ----------------------------------------------------------------------------- desktop mode (serve the web app)

_DIST_DIR = Path(os.environ.get("STEMFORGE_DIST_DIR", str(_HERE.parent / "dist")))
if (_DIST_DIR / "index.html").is_file():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="webapp")
