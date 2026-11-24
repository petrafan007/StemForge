"""Calibration: YIN periodicity signatures of single notes vs power chords on the true guitar track."""
import json
import sys
from collections import defaultdict
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SR = 22050


def cmndf(x: np.ndarray, tau_max: int) -> np.ndarray:
    W = len(x) - tau_max
    x2 = np.concatenate([[0.0], np.cumsum(x * x)])
    e0 = x2[W]
    taus = np.arange(tau_max + 1)
    eT = x2[taus + W] - x2[taus]
    n = 1 << int(np.ceil(np.log2(len(x) + W)))
    corr = np.fft.irfft(np.fft.rfft(x, n) * np.conj(np.fft.rfft(x[:W], n)), n)[: tau_max + 1]
    d = np.maximum(e0 + eT - 2 * corr, 0)
    d[0] = 0
    cs = np.cumsum(d)
    cm = np.ones_like(d)
    cm[1:] = d[1:] * taus[1:] / np.maximum(cs[1:], 1e-12)
    return cm


def dmin_at(cm: np.ndarray, f: float, cents: float = 40) -> float:
    tau = SR / f
    lo = int(np.floor(tau * 2 ** (-cents / 1200)))
    hi = int(np.ceil(tau * 2 ** (cents / 1200)))
    if hi >= len(cm) or lo < 2:
        return float("nan")
    return float(cm[lo : hi + 1].min())


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


song = Path(sys.argv[1])
truth = json.loads((song / "truth.json").read_text())
y, sr = sf.read(song / "stems_true" / "rhythm.flac", always_2d=True)
if "--bleed" in sys.argv:
    for name, g in (("bass", 0.18), ("drums", 0.12), ("vocals", 0.12), ("lead", 0.2)):
        b, _ = sf.read(song / "stems_true" / f"{name}.flac", always_2d=True)
        y = y + g * b[: len(y)]
chans = [librosa.resample(y[:, c].astype(np.float32), orig_sr=sr, target_sr=SR) for c in (0, 1)]
groups = defaultdict(list)
for n in truth["rhythm"]:
    groups[round(n[0], 3)].append(n)
times = sorted(groups)
stats = defaultdict(list)
for i, t in enumerate(times):
    notes = groups[t]
    pitches = sorted(n[2] for n in notes)
    root = pitches[0]
    kind = "single" if len(pitches) == 1 else ("power" if pitches == [root, root + 7] else ("power8" if pitches == [root, root + 7, root + 12] else "other"))
    nxt = times[i + 1] if i + 1 < len(times) else t + 0.2
    a = int((t + 0.015) * SR)
    b = int(min(t + 0.015 + 0.09, nxt - 0.005) * SR)
    if b - a < int(0.03 * SR):
        continue
    g = hz(root) / (2 if kind.startswith("power") else 1)  # expected common period
    tau_max = min(b - a - 64, int(SR / 30))
    vals = []
    for ch in chans:
        seg = ch[a:b].astype(np.float64)
        if np.sqrt(np.mean(seg ** 2)) < 1e-4:
            continue
        cm = cmndf(seg, tau_max)
        vals.append((dmin_at(cm, hz(root)), dmin_at(cm, hz(root) / 2), dmin_at(cm, hz(root) * 1.5), float(cm[2:].min()), dmin_at(cm, hz(root) * 2), dmin_at(cm, hz(root) * 3)))
    if vals:
        stats[kind].append(np.nanmean(np.array(vals), axis=0))

for kind, rows in stats.items():
    a = np.array(rows)
    print(f"{kind:7s} n={len(a):4d}  d'(root) med {np.nanmedian(a[:,0]):.3f} p90 {np.nanpercentile(a[:,0],90):.3f} | "
          f"d'(root/2) med {np.nanmedian(a[:,1]):.3f} p10 {np.nanpercentile(a[:,1],10):.3f} p90 {np.nanpercentile(a[:,1],90):.3f} | "
          f"d'(fifth) med {np.nanmedian(a[:,2]):.3f} | d'(2f) med {np.nanmedian(a[:,4]):.3f} p10 {np.nanpercentile(a[:,4],10):.3f} | d'(3f) med {np.nanmedian(a[:,5]):.3f} p10 {np.nanpercentile(a[:,5],10):.3f}")
