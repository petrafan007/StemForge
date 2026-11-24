"""
Audio export (Audacity-style): mix any selection of stems with the mixer's volume / pan,
optionally pitch-shift / time-stretch (Rubber Band), trim, normalize, then encode with
FFmpeg to WAV, AIFF, FLAC, MP3, Ogg Vorbis, Opus, M4A (AAC) or ALAC at any sample rate.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf

from .pipeline import MODEL_SR

FORMATS = {
    # id: (extension, mime type)
    "wav": (".wav", "audio/wav"),
    "aiff": (".aiff", "audio/aiff"),
    "flac": (".flac", "audio/flac"),
    "mp3": (".mp3", "audio/mpeg"),
    "ogg": (".ogg", "audio/ogg"),
    "opus": (".opus", "audio/ogg"),
    "m4a": (".m4a", "audio/mp4"),
    "alac": (".m4a", "audio/mp4"),
}
SAMPLE_RATES = (8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000)
MP3_RATES = (8000, 11025, 16000, 22050, 32000, 44100, 48000)


class ExportError(Exception):
    pass


def _f(spec: Dict[str, Any], key: str, default: float, lo: float, hi: float) -> float:
    try:
        return float(np.clip(float(spec.get(key, default)), lo, hi))
    except (TypeError, ValueError):
        return default


def _pan_stereo(audio: np.ndarray, pan: float) -> np.ndarray:
    """Web Audio StereoPannerNode algorithm for stereo input (matches what you hear in the app)."""
    pan = float(np.clip(pan, -1.0, 1.0))
    left, right = audio[0], audio[1]
    x = pan + 1.0 if pan <= 0 else pan
    g_l, g_r = float(np.cos(x * np.pi / 2)), float(np.sin(x * np.pi / 2))
    if pan <= 0:
        out = np.stack([left + right * g_l, right * g_r])
    else:
        out = np.stack([left * g_l, right + left * g_r])
    return out.astype(np.float32, copy=False)


def render_mix(
    stems_dir: Path, tracks: List[Dict[str, Any]], start: Optional[float], end: Optional[float], stem_gain: float = 1.0
) -> Tuple[np.ndarray, int]:
    """Mixes the selected stems. `stem_gain` is the headroom gain applied when the stems were saved;
    dividing by it restores the original song level."""
    level_comp = 1.0 / stem_gain if stem_gain > 0 else 1.0
    out: Optional[np.ndarray] = None
    sr = MODEL_SR
    for t in tracks:
        p = stems_dir / f"{t['id']}.flac"
        if not p.is_file():
            raise ExportError(f"Stem '{t['id']}' is not available in this project.")
        info = sf.info(str(p))
        sr = info.samplerate
        a = int(max(0.0, start or 0.0) * sr)
        b = int(end * sr) if end else info.frames
        b = max(a, min(info.frames, b))
        data, _ = sf.read(str(p), start=a, stop=b, dtype="float32", always_2d=True)
        audio = data.T
        if audio.shape[0] == 1:
            audio = np.repeat(audio, 2, axis=0)
        gain = float(np.clip(float(t.get("gain", 1.0)), 0.0, 8.0)) * level_comp
        audio = _pan_stereo(audio[:2] * gain, float(t.get("pan", 0.0)))
        if out is None:
            out = audio
        else:
            n = min(out.shape[1], audio.shape[1])
            out = (out[:, :n] + audio[:, :n]).astype(np.float32, copy=False)
    if out is None:
        raise ExportError("Select at least one track to export.")
    return out, sr


def _run_ffmpeg_raw(audio: np.ndarray, sr: int, filters: str) -> np.ndarray:
    cmd = [
        "ffmpeg", "-v", "error", "-nostdin", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0",
        "-af", filters, "-f", "f32le", "-ar", str(sr), "-ac", "2", "pipe:1",
    ]
    raw = np.ascontiguousarray(audio.T, dtype=np.float32).tobytes()
    proc = subprocess.run(cmd, input=raw, capture_output=True, check=False)
    if proc.returncode != 0:
        raise ExportError("Pitch/tempo processing failed: " + proc.stderr.decode("utf-8", "replace")[-300:])
    return np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()


def _codec_args(fmt: str, spec: Dict[str, Any], out_sr: int) -> List[str]:
    bits = int(spec.get("bitDepth") or 16)
    if fmt == "wav":
        return ["-c:a", {16: "pcm_s16le", 24: "pcm_s24le", 32: "pcm_f32le"}.get(bits, "pcm_s16le")]
    if fmt == "aiff":
        return ["-c:a", {16: "pcm_s16be", 24: "pcm_s24be", 32: "pcm_f32be"}.get(bits, "pcm_s16be")]
    if fmt == "flac":
        level = int(_f(spec, "flacLevel", 5, 0, 8))
        if bits >= 24:
            return ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-compression_level", str(level)]
        return ["-c:a", "flac", "-sample_fmt", "s16", "-compression_level", str(level)]
    if fmt == "alac":
        if bits >= 24:
            return ["-c:a", "alac", "-sample_fmt", "s32p", "-bits_per_raw_sample", "24"]
        return ["-c:a", "alac", "-sample_fmt", "s16p"]
    if fmt == "mp3":
        if spec.get("mp3Mode") == "vbr":
            return ["-c:a", "libmp3lame", "-q:a", str(int(_f(spec, "mp3Vbr", 2, 0, 9)))]
        return ["-c:a", "libmp3lame", "-b:a", f"{int(_f(spec, 'bitrate', 320, 32, 320))}k"]
    if fmt == "ogg":
        return ["-c:a", "libvorbis", "-q:a", str(round(_f(spec, "oggQuality", 6, 0, 10), 1))]
    if fmt == "opus":
        return ["-c:a", "libopus", "-b:a", f"{int(_f(spec, 'bitrate', 160, 16, 512))}k"]
    if fmt == "m4a":
        return ["-c:a", "aac", "-b:a", f"{int(_f(spec, 'bitrate', 256, 32, 512))}k"]
    raise ExportError(f"Unsupported format '{fmt}'.")


def export_audio(stems_dir: Path, spec: Dict[str, Any]) -> Tuple[Path, str, str]:
    """Renders and encodes the export. Returns (temp file path, extension, mime type)."""
    fmt = str(spec.get("format") or "wav").lower()
    if fmt not in FORMATS:
        raise ExportError(f"Unsupported format '{fmt}'.")
    ext, mime = FORMATS[fmt]
    tracks = spec.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        raise ExportError("Select at least one track to export.")

    start = spec.get("start")
    end = spec.get("end")
    start = float(start) if isinstance(start, (int, float)) and start > 0 else None
    end = float(end) if isinstance(end, (int, float)) and end > 0 else None
    if start is not None and end is not None and end <= start:
        raise ExportError("The export end time must be after the start time.")

    stem_gain = _f(spec, "stemGain", 1.0, 0.05, 1.0)
    audio, sr = render_mix(stems_dir, tracks, start, end, stem_gain)

    # Pitch shift / tempo change with Rubber Band (keeps pitch and speed independent)
    transpose = _f(spec, "transpose", 0, -12, 12)
    tempo = _f(spec, "tempo", 1.0, 0.25, 4.0)
    if abs(transpose) > 1e-6 or abs(tempo - 1.0) > 1e-6:
        opts = []
        if abs(transpose) > 1e-6:
            opts.append(f"pitch={2 ** (transpose / 12.0):.6f}")
        if abs(tempo - 1.0) > 1e-6:
            opts.append(f"tempo={tempo:.6f}")
        opts.append("pitchq=quality")
        audio = _run_ffmpeg_raw(audio, sr, "rubberband=" + ":".join(opts))

    # Fade in/out (ms) to avoid clicks on trimmed exports
    for key, side in (("fadeInMs", 0), ("fadeOutMs", 1)):
        ms = _f(spec, key, 0, 0, 20000)
        n = min(audio.shape[1], int(sr * ms / 1000))
        if n > 1:
            ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
            if side == 0:
                audio[:, :n] *= ramp
            else:
                audio[:, -n:] *= ramp[::-1]

    channels = 1 if int(spec.get("channels") or 2) == 1 else 2
    if channels == 1:
        audio = audio.mean(0, keepdims=True).repeat(2, axis=0)

    normalize = spec.get("normalize") or "clip"
    filters: List[str] = []
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if normalize == "peak" and peak > 0:
        target = 10 ** (_f(spec, "peakDb", -1.0, -30.0, 0.0) / 20.0)
        audio = audio * (target / peak)
    elif normalize == "loudness":
        lufs = _f(spec, "lufs", -14.0, -40.0, -5.0)
        filters.append(f"loudnorm=I={lufs}:TP=-1.0:LRA=11")
    elif normalize == "clip" and peak > 0.999:
        audio = audio * (0.999 / peak)

    out_sr = int(spec.get("sampleRate") or sr)
    if out_sr not in SAMPLE_RATES:
        out_sr = sr
    if fmt == "mp3" and out_sr not in MP3_RATES:
        out_sr = 48000 if out_sr > 48000 else 44100
    if fmt == "opus":
        out_sr = 48000

    fd, tmp_name = tempfile.mkstemp(suffix=ext, prefix="stemforge-export-")
    os.close(fd)
    out_path = Path(tmp_name)

    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "2", "-i", "pipe:0"]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-ar", str(out_sr), "-ac", str(channels)]
    cmd += _codec_args(fmt, spec, out_sr)
    meta = spec.get("metadata") if isinstance(spec.get("metadata"), dict) else {}
    for key in ("title", "artist", "album", "genre", "date", "track", "comment"):
        val = meta.get(key)
        if isinstance(val, (str, int)) and str(val).strip():
            clean = re.sub(r"[\r\n]+", " ", str(val))[:300]
            cmd += ["-metadata", f"{key}={clean}"]
    if fmt in ("m4a", "alac"):
        cmd += ["-f", "ipod"]
    elif fmt == "opus":
        cmd += ["-f", "opus"]
    cmd.append(str(out_path))

    proc = subprocess.run(cmd, input=np.ascontiguousarray(audio.T.astype(np.float32)).tobytes(), capture_output=True, check=False)
    if proc.returncode != 0:
        out_path.unlink(missing_ok=True)
        raise ExportError("Encoding failed: " + proc.stderr.decode("utf-8", "replace")[-400:])
    return out_path, ext, mime
