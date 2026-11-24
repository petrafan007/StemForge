"""
Beat and downbeat tracking with Beat This! (Foscarin, Schlüter & Widmer, ISMIR 2024,
https://github.com/CPJKU/beat_this) turned into a consistent tempo map.

A fixed BPM grid drifts against real recordings (human tempo, pushes and drags), which makes
tab bars and the playhead slide away from the music. The tracker gives every beat's real time.
Trackers sometimes switch metrical level between sections (half-time / double-time feel), so the
beats are regularised to ONE level for the whole song; bar lines come from the downbeats.
"""

from __future__ import annotations

import logging
import threading
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

log = logging.getLogger("stemforge")

MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "beat_this" / "final0.ckpt"
_lock = threading.Lock()
_model = None


def available() -> bool:
    try:
        import beat_this  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return MODEL_PATH.is_file()


def _get_model():
    global _model
    with _lock:
        if _model is None:
            import torch
            from beat_this.inference import Audio2Beats

            dev = "cuda" if torch.cuda.is_available() else "cpu"
            # local checkpoint -> beat_this loads it with torch.load(weights_only=True)
            _model = Audio2Beats(checkpoint_path=str(MODEL_PATH), device=dev, float16=False, dbn=False)
        return _model


def unload() -> bool:
    global _model
    with _lock:
        had = _model is not None
        _model = None
        return had


def loaded() -> bool:
    return _model is not None


def track(mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Beat and downbeat times (seconds) of a mono signal."""
    model = _get_model()
    beats, downbeats = model(np.ascontiguousarray(mono, dtype=np.float32), sr)
    return np.asarray(beats, dtype=np.float64), np.asarray(downbeats, dtype=np.float64)


def regularize(beats: Sequence[float], period: float) -> List[float]:
    """Keeps one metrical level: beats at roughly half the period (double-time stretches) are skipped,
    gaps of ~2x, 3x... the period (half-time stretches, breaks) are filled evenly."""
    out = [float(beats[0])]
    for b in beats[1:]:
        last = out[-1]
        gap = float(b) - last
        r = gap / period
        if r < 0.66:
            continue
        n = int(round(r)) if r >= 1.5 else 1
        for k in range(1, n):
            out.append(last + gap * k / n)
        out.append(float(b))
    return out


def tempo_map(
    beats: Sequence[float],
    downbeats: Sequence[float],
    duration: float,
    tempo_min: float = 40.0,
    tempo_max: float = 300.0,
) -> Optional[Dict[str, Any]]:
    """
    Regularised beat times covering the whole song, starting on a bar line at or before 0 s.
    Returns {"beats", "bpm", "beatOffsetSec", "timeSignature", "bpmCandidates"} or None.
    """
    b = np.asarray(beats, dtype=np.float64)
    if len(b) < 8:
        return None
    period = float(np.median(np.diff(b)))
    # keep the level inside the user's tempo range
    while 60.0 / period > tempo_max and 60.0 / (period * 2) >= tempo_min * 0.95:
        period *= 2
    while 60.0 / period < tempo_min and 60.0 / (period / 2) <= tempo_max * 1.05:
        period /= 2
    if period < 0.15 or period > 2.0:
        return None
    if abs(period - float(np.median(np.diff(b)))) > 0.25 * period:
        # the chosen level differs from the tracked one: rebuild from the tracked beats
        tracked = float(np.median(np.diff(b)))
        if period > tracked:  # halve: keep every other beat
            b = b[::2] if len(b) >= 16 else b
        else:  # double: insert midpoints
            mids = (b[:-1] + b[1:]) / 2
            b = np.sort(np.concatenate([b, mids]))
    reg = np.array(regularize(b, period))
    ibi = np.diff(reg)
    period = float(np.median(ibi))

    # bars: beats per bar from the downbeat spacing, bar phase from the downbeats that match beats
    num = 4
    phase = 0
    d = np.asarray(downbeats, dtype=np.float64)
    if len(d) >= 4:
        idx = np.searchsorted(reg, d)
        near = []
        for t, i in zip(d, idx):
            cands = [j for j in (i - 1, i) if 0 <= j < len(reg)]
            if not cands:
                continue
            j = min(cands, key=lambda j: abs(reg[j] - t))
            if abs(reg[j] - t) < 0.3 * period:
                near.append(j)
        near = sorted(set(near))
        if len(near) >= 4:
            spacing = Counter(int(x) for x in np.diff(near) if 2 <= x <= 8)
            if spacing:
                mode = spacing.most_common(1)[0][0]
                num = {2: 4, 8: 4}.get(mode, mode)
            votes = Counter(j % num for j in near)
            phase = votes.most_common(1)[0][0]

    beats_out = list(reg)
    # first beat on a bar line, at or before 0 s (pickup notes keep positive beat numbers)
    first_ibi = float(ibi[0]) if len(ibi) else period
    pre = (num - phase) % num
    for _ in range(pre):
        beats_out.insert(0, beats_out[0] - first_ibi)
    while beats_out[0] > 0:
        for _ in range(num):
            beats_out.insert(0, beats_out[0] - first_ibi)
    last_ibi = float(ibi[-1]) if len(ibi) else period
    while beats_out[-1] < duration + last_ibi:
        beats_out.append(beats_out[-1] + last_ibi)

    bpm = 60.0 / period
    return {
        "beats": [round(x, 4) for x in beats_out],
        "bpm": round(bpm, 2),
        "beatOffsetSec": round(beats_out[0], 4),
        "timeSignature": [int(num), 4],
        "bpmCandidates": [round(bpm, 1), round(bpm / 2, 1), round(bpm * 2, 1)],
        # the tracker's own downbeats: where bars really start (odd-meter bars, shifted sections)
        "downbeats": [round(float(x), 4) for x in d],
    }
