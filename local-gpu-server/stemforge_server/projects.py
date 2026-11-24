"""
Project library: every imported song becomes a project folder (a "draft") so nothing is
lost when the app closes. A project folder looks like:

    <projects dir>/<project id>/
        project.json          analysis, transcription and the user's saved state
        original.<ext>        the imported audio/video file (used for re-analysis)
        stems/<stem>.flac     separated stems (24-bit FLAC)

A .sfg file ("StemForge project") is a ZIP container of that folder:

    mimetype              "application/x-stemforge-project" (stored first, uncompressed)
    project.json
    stems/*.flac
    original/<file name>  (optional)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from .settings import projects_dir

SFG_MIMETYPE = "application/x-stemforge-project"
PROJECT_FORMAT = "stemforge-project"
PROJECT_VERSION = 1
STEM_IDS = ("vocals", "guitar", "guitar1", "guitar2", "lead", "bass", "drums", "keyboards")

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$")
_io_lock = threading.RLock()


class ProjectError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def slugify(text: str, max_len: int = 48) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", text or "").strip("-").lower()
    return (s[:max_len].strip("-")) or "song"


def validate_id(project_id: str) -> str:
    if not project_id or not _ID_RE.match(project_id) or ".." in project_id:
        raise ProjectError("Invalid project id.")
    return project_id


def root() -> Path:
    return projects_dir()


def project_dir(project_id: str) -> Path:
    return root() / validate_id(project_id)


def new_project_id(title: str) -> str:
    base = f"{datetime.now():%Y%m%d-%H%M%S}-{slugify(title)}"
    candidate = base
    n = 2
    while (root() / candidate).exists():
        candidate = f"{base}-{n}"
        n += 1
    return candidate


def stem_path(project_id: str, stem: str) -> Path:
    if stem not in STEM_IDS:
        raise ProjectError("Invalid stem name.")
    return project_dir(project_id) / "stems" / f"{stem}.flac"


def original_path(project_id: str) -> Optional[Path]:
    d = project_dir(project_id)
    for p in d.glob("original.*"):
        if p.is_file():
            return p
    return None


def load(project_id: str) -> Dict[str, Any]:
    p = project_dir(project_id) / "project.json"
    if not p.is_file():
        raise ProjectError("Project not found.")
    with _io_lock:
        return json.loads(p.read_text(encoding="utf-8"))


def save(project_id: str, doc: Dict[str, Any]) -> Dict[str, Any]:
    d = project_dir(project_id)
    d.mkdir(parents=True, exist_ok=True)
    doc["format"] = PROJECT_FORMAT
    doc["version"] = PROJECT_VERSION
    doc["id"] = project_id
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    tmp = d / "project.json.tmp"
    with _io_lock:
        tmp.write_text(raw, encoding="utf-8")
        os.replace(tmp, d / "project.json")
    return doc


def update(project_id: str, **fields: Any) -> Dict[str, Any]:
    with _io_lock:
        doc = load(project_id)
        doc.update(fields)
        return save(project_id, doc)


def save_state(project_id: str, state: Dict[str, Any], meta: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Saves the user's editable state (mixer, tempo overrides, notation choices, ...)."""
    with _io_lock:
        doc = load(project_id)
        doc["state"] = state
        if meta:
            for key in ("title", "artist", "album"):
                if key in meta and isinstance(meta[key], str):
                    doc[key] = meta[key][:300]
        doc["updatedAt"] = now_iso()
        return save(project_id, doc)


def folder_size_mb(d: Path) -> float:
    total = 0
    for p in d.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return round(total / (1024 * 1024), 1)


def list_projects() -> List[Dict[str, Any]]:
    out = []
    r = root()
    for d in r.iterdir():
        if not d.is_dir() or d.name.startswith("."):
            continue
        pj = d / "project.json"
        if not pj.is_file():
            continue
        try:
            doc = json.loads(pj.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        analysis = doc.get("analysis") or {}
        state = doc.get("state") or {}
        out.append(
            {
                "id": d.name,
                "title": doc.get("title") or d.name,
                "artist": doc.get("artist") or "",
                "album": doc.get("album") or "",
                "status": doc.get("status", "ready"),
                "error": doc.get("error"),
                "createdAt": doc.get("createdAt"),
                "updatedAt": doc.get("updatedAt"),
                "durationSec": (doc.get("source") or {}).get("durationSec"),
                "bpm": state.get("bpm") or analysis.get("bpm"),
                "stems": doc.get("stems") or [],
                "quality": (doc.get("processing") or {}).get("quality"),
                "sizeMB": folder_size_mb(d),
            }
        )
    out.sort(key=lambda x: x.get("updatedAt") or "", reverse=True)
    return out


def trash(project_id: str) -> Path:
    """Moves a project into <projects dir>/.trash instead of deleting it permanently."""
    d = project_dir(project_id)
    if not d.is_dir():
        raise ProjectError("Project not found.")
    t = root() / ".trash"
    t.mkdir(exist_ok=True)
    dest = t / f"{project_id}--deleted-{datetime.now():%Y%m%d-%H%M%S}"
    shutil.move(str(d), str(dest))
    return dest


# ----------------------------------------------------------------------------- .sfg files


def pack_sfg(project_id: str, include_original: bool = True) -> Path:
    """Writes the project to a temporary .sfg (ZIP) file and returns its path."""
    d = project_dir(project_id)
    doc = load(project_id)
    fd, tmp_name = tempfile.mkstemp(suffix=".sfg", prefix="stemforge-")
    os.close(fd)
    tmp = Path(tmp_name)
    with zipfile.ZipFile(tmp, "w", allowZip64=True) as z:
        z.writestr(zipfile.ZipInfo("mimetype"), SFG_MIMETYPE, compress_type=zipfile.ZIP_STORED)
        packed = dict(doc)
        orig = original_path(project_id)
        packed["packedOriginal"] = bool(include_original and orig)
        z.writestr("project.json", json.dumps(packed, ensure_ascii=False, indent=1), compress_type=zipfile.ZIP_DEFLATED)
        # the listed tracks plus the stems they come from (the guitar stem behind the two guitar tracks)
        for stem in [s for s in STEM_IDS if s in (doc.get("stems") or []) or (d / "stems" / f"{s}.flac").exists()]:
            sp = d / "stems" / f"{stem}.flac"
            if sp.is_file():
                z.write(sp, f"stems/{stem}.flac", compress_type=zipfile.ZIP_STORED)
        if include_original and orig:
            src_name = (doc.get("source") or {}).get("fileName") or orig.name
            safe = re.sub(r'[\\/:*?"<>|]+', "_", src_name)[:200] or orig.name
            z.write(orig, f"original/{safe}", compress_type=zipfile.ZIP_STORED)
    return tmp


def unpack_sfg(sfg_path: Path) -> str:
    """Imports a .sfg file into the project library and returns the project id."""
    if not zipfile.is_zipfile(sfg_path):
        raise ProjectError("This is not a StemForge project file.")
    with zipfile.ZipFile(sfg_path) as z:
        names = set(z.namelist())
        if "project.json" not in names:
            raise ProjectError("This .sfg file has no project.json.")
        if "mimetype" in names and z.read("mimetype").decode("ascii", "replace").strip() != SFG_MIMETYPE:
            raise ProjectError("This is not a StemForge project file.")
        doc = json.loads(z.read("project.json").decode("utf-8"))
        if doc.get("format") != PROJECT_FORMAT:
            raise ProjectError("Unknown project format.")
        if int(doc.get("version") or 0) > PROJECT_VERSION:
            raise ProjectError("This project was saved by a newer version of StemForge.")

        wanted = doc.get("id") if isinstance(doc.get("id"), str) else None
        pid: Optional[str] = None
        if wanted and _ID_RE.match(wanted) and ".." not in wanted:
            existing = root() / wanted
            if existing.exists():
                try:
                    current = load(wanted)
                    if current.get("updatedAt") == doc.get("updatedAt"):
                        return wanted  # identical project already in the library
                except Exception:  # noqa: BLE001
                    pass
                n = 2
                while (root() / f"{wanted}-copy{n if n > 2 else ''}").exists():
                    n += 1
                pid = f"{wanted}-copy{n if n > 2 else ''}"
            else:
                pid = wanted
        if not pid:
            pid = new_project_id(doc.get("title") or "imported")

        d = root() / pid
        (d / "stems").mkdir(parents=True, exist_ok=True)
        for name in names:
            if name.startswith("stems/") and name.endswith(".flac"):
                stem = name[len("stems/"):-len(".flac")]
                if stem in STEM_IDS:
                    with z.open(name) as src, open(d / "stems" / f"{stem}.flac", "wb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
            elif name.startswith("original/") and not name.endswith("/"):
                ext = Path(name).suffix.lower()[:6] or ".bin"
                if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
                    ext = ".bin"
                with z.open(name) as src, open(d / f"original{ext}", "wb") as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
        doc.pop("packedOriginal", None)
        doc["status"] = "ready" if doc.get("status") != "error" else "error"
        save(pid, doc)
        return pid


def wait_for_file_unlock(path: Path, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(path, "rb"):
                return
        except PermissionError:
            time.sleep(0.2)
