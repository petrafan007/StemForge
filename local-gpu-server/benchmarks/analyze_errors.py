"""Breaks transcription errors down by riff type, chord role and false-positive kind."""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import mir_eval

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as ev  # noqa: E402


def section_of(t, truth):
    beat = 60 / truth["bpm"]
    bars = {"chug": 8, "gallop": 8, "power": 8, "run": 8, "tremolo": 4}
    t0 = 0.5
    for name in truth["sections"]:
        dur = bars[name.split("-")[0]] * 4 * beat
        if t < t0 + dur:
            return name
        t0 += dur
    return "end"


def analyze(song: Path, method: str, sep: str = "htdemucs", part: str = "rhythm"):
    truth = json.loads((song / "truth.json").read_text())
    stems = song / f"stems_{sep}"
    est = ev.METHODS[method](stems, part)
    ref = [[n[0], n[1], n[2]] for n in truth["rhythm"]] if part == "rhythm" else truth[part]
    ri = np.array([[n[0], n[1]] for n in ref]); rp = ev.midi_hz([n[2] for n in ref])
    ei = np.array([[n[0], max(n[1], n[0] + 0.01)] for n in est]); ep = ev.midi_hz([n[2] for n in est])
    match = mir_eval.transcription.match_notes(ri, rp, ei, ep, onset_tolerance=0.05, offset_ratio=None)
    hit_ref = {i for i, _ in match}
    hit_est = {j for _, j in match}

    # recall by section and by chord role
    by_sec = defaultdict(lambda: [0, 0])
    by_role = defaultdict(lambda: [0, 0])
    groups = defaultdict(list)
    for i, n in enumerate(ref):
        groups[round(n[0], 3)].append(i)
    for t, idxs in groups.items():
        low = min(ref[i][2] for i in idxs)
        for i in idxs:
            role = "single" if len(idxs) == 1 else {0: "root", 7: "fifth", 12: "octave"}.get(ref[i][2] - low, "other")
            sec = section_of(ref[i][0], truth)
            by_sec[sec][0] += i in hit_ref
            by_sec[sec][1] += 1
            by_role[role][0] += i in hit_ref
            by_role[role][1] += 1
    print(f"== {song.name} / {method} / {part}")
    print("   recall by section:", {k: f"{v[0]}/{v[1]}" for k, v in by_sec.items()})
    print("   recall by role:   ", {k: f"{v[0]}/{v[1]}" for k, v in by_role.items()})

    # false positives: relation to the nearest (in time) reference notes
    onsets = np.array([n[0] for n in ref])
    kinds = Counter()
    for j, n in enumerate(est):
        if j in hit_est:
            continue
        near = [ref[i] for i in np.where(np.abs(onsets - n[0]) < 0.12)[0]]
        if not near:
            kinds["no note nearby (bleed/noise)"] += 1
            continue
        pitches = {r[2] for r in near}
        if n[2] in pitches:
            kinds["right pitch, onset >50ms off (extra re-trigger)"] += 1
            continue
        d = sorted(n[2] - p for p in pitches)
        dd = min(d, key=abs)
        if any(x in (12, 19, 24, 28, 31) for x in d) and dd > 0:
            kinds["overtone above a played note"] += 1
        elif any(x in (-12, -24) for x in d):
            kinds["octave below a played note (subharmonic)"] += 1
        elif any(x in (-5, -7) for x in d):
            kinds["fifth/fourth below (intermod)"] += 1
        elif abs(dd) <= 2:
            kinds["wrong pitch by 1-2 semitones"] += 1
        else:
            kinds[f"other pitch ({dd:+d})"] += 1
    print("   false positives:", dict(kinds.most_common(8)))


if __name__ == "__main__":
    data = Path(sys.argv[1])
    method = sys.argv[2] if len(sys.argv) > 2 else "current"
    part = sys.argv[3] if len(sys.argv) > 3 else "rhythm"
    for song in sorted(p for p in data.iterdir() if (p / "truth.json").exists()):
        analyze(song, method, part=part)
