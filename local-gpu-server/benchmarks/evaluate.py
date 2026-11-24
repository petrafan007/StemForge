"""
Scores guitar / bass transcription against the synthetic answer key.

  python evaluate.py <data_dir> [--sep htdemucs|roformer] [--methods current,...]

Separation runs once per song/separator and is cached as FLAC stems next to the mix.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import mir_eval

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from stemforge_server import pipeline  # noqa: E402


def midi_hz(m):
    return 440.0 * 2 ** ((np.asarray(m, dtype=float) - 69) / 12)


def score(ref: list, est: list, tol: float = 0.05) -> dict:
    """Onset-only note F1 (pitch within 50 cents) plus octave errors, phantom rate and onset bias."""
    if not est:
        return {"P": 0.0, "R": 0.0, "F": 0.0, "n_est": 0, "n_ref": len(ref)}
    ri = np.array([[n[0], max(n[1], n[0] + 0.01)] for n in ref])
    rp = midi_hz([n[2] for n in ref])
    ei = np.array([[n[0], max(n[1], n[0] + 0.01)] for n in est])
    ep = midi_hz([n[2] for n in est])
    P, R, F, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=tol, offset_ratio=None)
    # pitch-class (octave-agnostic) F1 -> how many errors are octave errors
    rpc = midi_hz([60 + (n[2] % 12) for n in ref])
    epc = midi_hz([60 + (n[2] % 12) for n in est])
    _, _, Fc, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rpc, ei, epc, onset_tolerance=tol, offset_ratio=None)
    # onset bias of matched notes
    match = mir_eval.transcription.match_notes(ri, rp, ei, ep, onset_tolerance=tol, offset_ratio=None)
    bias = [ei[j][0] - ri[i][0] for i, j in match]
    dur = max(n[1] for n in ref) - min(n[0] for n in ref)
    fp = len(est) - len(match)
    return {
        "P": round(P, 3),
        "R": round(R, 3),
        "F": round(F, 3),
        "F_octave_agnostic": round(Fc, 3),
        "onset_bias_ms": round(1000 * float(np.median(bias)), 1) if bias else None,
        "phantoms_per_min": round(60 * fp / max(1e-6, dur), 1),
        "n_est": len(est),
        "n_ref": len(ref),
    }


def separate_song(song_dir: Path, sep: str) -> Path:
    out = song_dir / f"stems_{sep}"
    if (out / "guitar.flac").exists():
        return out
    if sep == "oraclebleed":
        out.mkdir(exist_ok=True)
        t = song_dir / "stems_true"
        tr = {n: sf.read(t / f"{n}.flac", always_2d=True)[0] for n in ("rhythm", "lead", "bass", "drums", "vocals")}
        sr = 44100
        gtr = tr["rhythm"] + 0.15 * tr["bass"] + 0.12 * tr["drums"] + 0.12 * tr["vocals"] + 0.15 * tr["lead"]
        sf.write(out / "guitar.flac", gtr, sr, subtype="PCM_24")
        sf.write(out / "lead.flac", tr["lead"] + 0.2 * tr["rhythm"] + 0.12 * tr["vocals"] + 0.1 * tr["bass"], sr, subtype="PCM_24")
        sf.write(out / "guitar_full.flac", tr["rhythm"] + tr["lead"] + 0.15 * tr["bass"] + 0.12 * tr["drums"] + 0.12 * tr["vocals"], sr, subtype="PCM_24")
        sf.write(out / "bass.flac", tr["bass"] + 0.15 * tr["rhythm"] + 0.12 * tr["drums"], sr, subtype="PCM_24")
        return out
    if sep == "oracle":
        out.mkdir(exist_ok=True)
        t = song_dir / "stems_true"
        rhythm, sr = sf.read(t / "rhythm.flac", always_2d=True)
        lead, _ = sf.read(t / "lead.flac", always_2d=True)
        bass, _ = sf.read(t / "bass.flac", always_2d=True)
        sf.write(out / "guitar.flac", rhythm, sr, subtype="PCM_24")
        sf.write(out / "lead.flac", lead, sr, subtype="PCM_24")
        sf.write(out / "guitar_full.flac", rhythm + lead, sr, subtype="PCM_24")
        sf.write(out / "bass.flac", bass, sr, subtype="PCM_24")
        return out
    out.mkdir(exist_ok=True)
    mix = pipeline.decode_to_stereo(song_dir / "mix.flac")
    opts = pipeline.ProcessOptions.from_dict({"quality": "balanced", "splitGuitars": True})
    prog = pipeline.Progress(lambda s, p: None, __import__("threading").Event())
    if sep == "htdemucs":
        stems, info = pipeline.separate(mix, opts, prog)
    else:
        stems, info = pipeline.separate_roformer(mix, opts, prog)  # added later
    # also keep the unsplit guitar (lead + rhythm) for comparison
    if "lead" in stems:
        stems["guitar_full"] = stems["guitar"] + stems["lead"]
    peak = max(float(np.max(np.abs(s))) for s in stems.values())
    scale = 0.99 / peak if peak > 0.99 else 1.0
    for name, a in stems.items():
        sf.write(out / f"{name}.flac", (a * scale).T, pipeline.MODEL_SR, subtype="PCM_24")
    print(f"  separated {song_dir.name} with {sep} -> {sorted(stems)}")
    return out


METHODS = {}


def method(name):
    def deco(fn):
        METHODS[name] = fn
        return fn

    return deco


def bp_opts():
    return pipeline.ProcessOptions.from_dict(
        {"minNoteMs": 45, "sensitivity": {"guitar": 0.45, "bass": 0.5}, "silenceGateDb": -45}
    )


@method("current")
def current(stems: Path, part: str):
    """Today's pipeline: Basic Pitch + gating, then client-side power-chord simplification."""
    opts = bp_opts()
    stem = {"rhythm": "guitar", "lead": "lead", "bass": "bass", "full": "guitar_full"}[part]
    notes = pipeline.transcribe_melodic(stems / f"{stem}.flac", "bass" if part == "bass" else ("lead" if part == "lead" else "guitar"), opts)
    audio, sr = pipeline.read_stem(stems / f"{stem}.flac")
    env = pipeline.envelope_db(audio.mean(0), sr)
    notes = pipeline.gate_notes(notes, env, 0.05, opts.silence_gate_db)
    if part != "bass":
        notes = simplify_power_chords(notes)
    return notes


def load_channels(path, sr=22050):
    import librosa
    y, file_sr = sf.read(path, always_2d=True, dtype="float32")
    return [librosa.resample(y[:, c], orig_sr=file_sr, target_sr=sr) for c in range(min(2, y.shape[1]))]


@method("riff")
def riff_method(stems: Path, part: str):
    """New periodicity-based transcriber."""
    from stemforge_server import riff
    stem = {"rhythm": "guitar", "lead": "lead", "bass": "bass", "full": "guitar_full"}[part]
    chans = load_channels(stems / f"{stem}.flac")
    others = {"bass": ["guitar"], "lead": ["guitar", "bass"]}.get(part, ["bass"])
    refs = [np.mean(load_channels(stems / f"{o}.flac"), axis=0) for o in others if (stems / f"{o}.flac").exists()]
    vox = stems.parent / "stems_true" / "vocals.flac"  # stand-in for the separated vocal stem
    if part in ("lead", "rhythm", "full") and vox.exists():
        refs.append(np.mean(load_channels(vox), axis=0))
    refs = refs or None
    kind = {"rhythm": "guitar", "full": "guitar", "lead": "lead", "bass": "bass"}[part]
    notes, st = riff.transcribe_stem(kind, chans, bleed_refs=refs)
    print("     stats", {k: int(v) for k, v in st.items()})
    return notes


DISTORTION_HARMONICS = {19, 24, 28, 31, 36}


def simplify_power_chords(notes, window=0.04):
    """Python port of the client's simplifyPowerChords (musicAnalysis.ts)."""
    s = sorted(notes, key=lambda n: (n[0], n[2]))
    out, i = [], 0
    while i < len(s):
        g = [s[i]]
        j = i + 1
        while j < len(s) and s[j][0] - s[i][0] <= window:
            g.append(s[j])
            j += 1
        if len(g) == 1:
            out.append(g[0])
        else:
            root = min(g, key=lambda n: n[2])
            for n in g:
                if n is not root and (n[2] - root[2]) in DISTORTION_HARMONICS and n[3] <= root[3] * 1.25:
                    continue
                out.append(n)
        i = j
    return out


def run(data_dir: Path, sep: str, methods: list, parts: list):
    rows = []
    for song in sorted(p for p in data_dir.iterdir() if (p / "truth.json").exists()):
        truth = json.loads((song / "truth.json").read_text())
        stems = separate_song(song, sep)
        refs = {
            "rhythm": [[n[0], n[1], n[2]] for n in truth["rhythm"]],
            "lead": truth["lead"],
            "bass": truth["bass"],
            "full": sorted([[n[0], n[1], n[2]] for n in truth["rhythm"]] + truth["lead"]),
        }
        for m in methods:
            for part in parts:
                t0 = time.perf_counter()
                est = METHODS[m](stems, part)
                s = score(refs[part], est)
                s.update({"song": song.name, "method": m, "part": part, "sep": sep, "sec": round(time.perf_counter() - t0, 1)})
                rows.append(s)
                print(f"  {song.name:14s} {m:14s} {part:6s} F={s['F']:.3f} P={s['P']:.3f} R={s['R']:.3f} "
                      f"octF={s.get('F_octave_agnostic', 0):.3f} bias={s.get('onset_bias_ms')}ms phantoms/min={s.get('phantoms_per_min')} "
                      f"n={s['n_est']}/{s['n_ref']} ({s['sec']}s)")
    return rows


if __name__ == "__main__":
    data = Path(sys.argv[1])
    sep = sys.argv[sys.argv.index("--sep") + 1] if "--sep" in sys.argv else "htdemucs"
    methods = sys.argv[sys.argv.index("--methods") + 1].split(",") if "--methods" in sys.argv else ["current"]
    parts = sys.argv[sys.argv.index("--parts") + 1].split(",") if "--parts" in sys.argv else ["rhythm", "full", "bass"]
    rows = run(data, sep, methods, parts)
    (data / f"results_{sep}_{'-'.join(methods)}.json").write_text(json.dumps(rows, indent=1))
