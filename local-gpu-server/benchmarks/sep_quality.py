"""Separation quality (SDR, dB) of the guitar and bass stems per riff section."""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf
sys.path.insert(0, str(Path(__file__).resolve().parent))
from analyze_errors import section_of  # noqa: E402

def sdr(ref, est):
    n = min(len(ref), len(est)); ref, est = ref[:n], est[:n]
    return 10 * np.log10((np.sum(ref ** 2) + 1e-9) / (np.sum((ref - est) ** 2) + 1e-9))

for song in sorted(p for p in Path(sys.argv[1]).iterdir() if (p / "truth.json").exists()):
    truth = json.loads((song / "truth.json").read_text())
    t = song / "stems_true"
    ref_g = sf.read(t / "rhythm.flac")[0].mean(1) + sf.read(t / "lead.flac")[0].mean(1)
    ref_b = sf.read(t / "bass.flac")[0].mean(1)
    for sep in sys.argv[2].split(","):
        d = song / f"stems_{sep}"
        if not (d / "guitar_full.flac").exists():
            continue
        est_g = sf.read(d / "guitar_full.flac")[0].mean(1)
        est_b = sf.read(d / "bass.flac")[0].mean(1)
        sr = 44100
        secs = {}
        for i in range(0, len(ref_g) - sr, sr):
            name = section_of(i / sr + 0.5, truth)
            secs.setdefault(name, []).append((sdr(ref_g[i:i+sr], est_g[i:i+sr]), sdr(ref_b[i:i+sr], est_b[i:i+sr])))
        line = " | ".join(f"{k}: gtr {np.median([a for a,_ in v]):5.1f} bass {np.median([b for _,b in v]):5.1f}" for k, v in secs.items())
        print(f"{song.name} {sep:9s} overall gtr {sdr(ref_g, est_g):5.1f} dB, bass {sdr(ref_b, est_b):5.1f} dB || {line}")
