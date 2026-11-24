"""Looks at Basic Pitch's raw note/onset activations at the reference note onsets."""
import json
import logging
import sys
from pathlib import Path

import numpy as np

logging.disable(logging.WARNING)
from basic_pitch import FilenameSuffix, build_icassp_2022_model_path  # noqa: E402
from basic_pitch.inference import Model, run_inference  # noqa: E402

song = Path(sys.argv[1])
stem = sys.argv[2] if len(sys.argv) > 2 else "guitar"
part = sys.argv[3] if len(sys.argv) > 3 else "rhythm"
truth = json.loads((song / "truth.json").read_text())
model = Model(build_icassp_2022_model_path(FilenameSuffix.onnx))
sepdir = sys.argv[4] if len(sys.argv) > 4 else "stems_htdemucs"
out = run_inference(str(song / sepdir / f"{stem}.flac"), model)
note, onset = out["note"], out["onset"]  # (frames, 88), MIDI 21..108
fps = 22050 / 256
print("frames", note.shape, "fps", round(fps, 2))

ref = truth[part]
groups = {}
for n in ref:
    groups.setdefault(round(n[0], 3), []).append(n[2])
times = sorted(groups)
for sec_t in (2.0, 13.0, 23.0, 34.0, 45.0, 50.0):
    sel = [t for t in times if sec_t <= t < sec_t + 1.4][:6]
    print(f"--- t~{sec_t}s")
    for t in sel:
        f = int(round(t * fps))
        seg = note[f + 2 : f + 8].mean(0)  # 20-90 ms after the onset
        on = onset[max(0, f - 2) : f + 4].max(0)
        top = np.argsort(seg)[::-1][:5]
        print(f"  t={t:6.3f} ref={sorted(groups[t])} | note top: " + ", ".join(f"{21 + k}:{seg[k]:.2f}" for k in top)
              + " | onset@ref: " + ", ".join(f"{p}:{on[p - 21]:.2f}" for p in sorted(groups[t])))
