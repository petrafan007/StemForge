"""Onset detection precision/recall per riff section (unique reference onsets, 30 ms tolerance)."""
import json
import sys
from collections import defaultdict
from pathlib import Path

import mir_eval
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from analyze_errors import section_of  # noqa: E402
from evaluate import load_channels  # noqa: E402
from stemforge_server import riff  # noqa: E402

sens = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
sep = sys.argv[3] if len(sys.argv) > 3 else "oraclebleed"
for song in sorted(p for p in Path(sys.argv[1]).iterdir() if (p / "truth.json").exists()):
    truth = json.loads((song / "truth.json").read_text())
    ref = np.array(sorted({round(n[0], 3) for n in truth["rhythm"]}))
    chans = load_channels(song / f"stems_{sep}" / "guitar.flac")
    est = riff.merge_onsets([riff.pick_onsets(riff.onset_envelope(c), sens) for c in chans])
    est = np.maximum(0, est - riff.ONSET_LAG)
    F, P, R = mir_eval.onset.f_measure(ref, est, window=0.03)
    m = mir_eval.util.match_events(ref, est, 0.03)
    bias = np.median([est[j] - ref[i] for i, j in m]) * 1000
    hit = {i for i, _ in m}
    per = defaultdict(lambda: [0, 0])
    for i, t in enumerate(ref):
        s = section_of(t, truth)
        per[s][0] += i in hit
        per[s][1] += 1
    print(f"{song.name}: onset F={F:.3f} P={P:.3f} R={R:.3f} bias={bias:+.1f}ms est={len(est)} ref={len(ref)} | " + " ".join(f"{k}:{v[0]}/{v[1]}" for k, v in per.items()))
