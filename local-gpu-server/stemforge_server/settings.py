"""
User settings storage.

The web app owns the settings schema and defaults; the server stores the JSON blob in
%LOCALAPPDATA%\\StemForge\\settings.json (shared with the StemForge.exe launcher) and
reads only the few keys it needs (projects folder).
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict

MAX_SETTINGS_BYTES = 256 * 1024
_lock = threading.Lock()


def app_data_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    d = Path(base) / "StemForge"
    d.mkdir(parents=True, exist_ok=True)
    return d


def settings_path() -> Path:
    return app_data_dir() / "settings.json"


def documents_dir() -> Path:
    """The user's real Documents folder (honours folder redirection, e.g. D:\\Documents)."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class GUID(ctypes.Structure):
                _fields_ = [
                    ("Data1", wintypes.DWORD),
                    ("Data2", wintypes.WORD),
                    ("Data3", wintypes.WORD),
                    ("Data4", ctypes.c_ubyte * 8),
                ]

            # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
            fid = GUID(0xFDD39AD0, 0x238F, 0x46AF, (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(out)) == 0:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                if path:
                    return Path(path)
        except Exception:  # noqa: BLE001
            pass
    return Path.home() / "Documents"


def default_projects_dir() -> Path:
    return documents_dir() / "StemForge" / "Projects"


def load_settings() -> Dict[str, Any]:
    p = settings_path()
    with _lock:
        if not p.is_file():
            return {}
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:  # noqa: BLE001
            return {}


def save_settings(data: Dict[str, Any]) -> Dict[str, Any]:
    raw = json.dumps(data, indent=2, ensure_ascii=False)
    if len(raw.encode("utf-8")) > MAX_SETTINGS_BYTES:
        raise ValueError("Settings are too large.")
    p = settings_path()
    tmp = p.with_suffix(".tmp")
    with _lock:
        tmp.write_text(raw, encoding="utf-8")
        os.replace(tmp, p)
    return data


def projects_dir() -> Path:
    """Folder where project drafts live (setting `projects.folder`, else Documents\\StemForge\\Projects)."""
    folder = None
    s = load_settings()
    proj = s.get("projects") if isinstance(s.get("projects"), dict) else None
    if proj and isinstance(proj.get("folder"), str) and proj["folder"].strip():
        folder = Path(os.path.expandvars(proj["folder"].strip()))
    d = folder or default_projects_dir()
    d.mkdir(parents=True, exist_ok=True)
    return d
