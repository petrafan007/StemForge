"""Tries onset-envelope variants for distorted re-picked notes."""
import json
import sys
from pathlib import Path

import librosa
import mir_eval
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evaluate import load_channels  # noqa: E402
from stemforge_server import riff  # noqa: E402

SR, HOP = riff.SR, riff.HOP


def env_variant(x, n_fft=1024, lag=2, max_size=3, hf=0.0, fmin=40):
    S = librosa.feature.melspectrogram(y=x, sr=SR, n_fft=n_fft, hop_length=HOP, n_mels=128, fmin=fmin, fmax=10500, power=1.0)
    logS = np.log1p(100.0 * S)
    if hf:
        w = np.linspace(1.0, 1.0 + hf, logS.shape[0])[:, None]
        logS = logS * w
    return librosa.onset.onset_strength(S=logS, sr=SR, hop_length=HOP, lag=lag, max_size=max_size, center=False)


VARIANTS = {
    "base": dict(),
    "nfft512": dict(n_fft=512),
    "lag1": dict(lag=1),
    "hf2": dict(hf=2.0),
    "nfft512_hf2": dict(n_fft=512, hf=2.0),
    "nfft512_hf3_fmin200": dict(n_fft=512, hf=3.0, fmin=200),
}

songs = sorted(p for p in Path(sys.argv[1]).iterdir() if (p / "truth.json").exists())
data = []
for song in songs:
    truth = json.loads((song / "truth.json").read_text())
    ref = np.array(sorted({round(n[0], 3) for n in truth["rhythm"]}))
    chans = load_channels(song / "stems_oraclebleed" / "guitar.flac")
    data.append((song.name, ref, chans))
for name, kw in VARIANTS.items():
    for sens in (0.5, 0.65):
        res = []
        for sname, ref, chans in data:
            est = riff.merge_onsets([riff.pick_onsets(env_variant(c, **kw), sens) for c in chans])
            F, P, R = mir_eval.onset.f_measure(ref, est - riff.ONSET_LAG, window=0.03)
            res.append(f"{sname[:5]} F={F:.3f} P={P:.3f} R={R:.3f}")
        print(f"{name:22s} sens={sens}: " + " | ".join(res))
