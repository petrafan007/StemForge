"""
Synthetic metal benchmark: renders full-band metal songs with an exact answer key.

Each song has double-tracked high-gain rhythm guitars (hard left / right), a bass that doubles the
riff roots, drums, a centered lead guitar with stereo delay, and a reverb-heavy synthetic vocal
(to test bleed). Riffs cover palm-muted chugs with power-chord accents, gallops, sustained power
chords, single-note 16th runs, tremolo picking and a drop-C section.

Usage:  python synth_metal.py <out_dir> [--songs 2]
Writes <out_dir>/<song>/mix.flac and truth.json (notes per part: [start, end, midi, string, fret]).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, lfilter, sosfilt

SR = 44100
OS = 2  # string synthesis oversampling (better tuning accuracy)

STANDARD = [64, 59, 55, 50, 45, 40]  # high e .. low E (string index 0 = high e)
DROP_C = [62, 57, 53, 48, 43, 36]


# ----------------------------------------------------------------------------- string synthesis


def pluck(midi: float, dur: float, rng: np.random.Generator, palm: bool = False, bright: float = 0.6) -> np.ndarray:
    """Karplus-Strong plucked string (rendered at 2x rate, exact-ish tuning)."""
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    sr = SR * OS
    n_total = int((dur + (0.05 if palm else 0.35)) * sr)
    period = sr / f0 - 0.5  # the averaging filter adds half a sample of delay
    N = max(2, int(round(period)))
    frac = period - N  # first-order allpass for the fractional part
    c = (1 - frac) / (1 + frac) if 0 <= frac < 1 else 0.0
    burst = rng.uniform(-1, 1, N)
    # pick brightness: one-pole lowpass on the excitation
    a = 1 - (0.15 + 0.8 * bright)
    burst = lfilter([1 - a], [1, -a], burst)
    x = np.zeros(n_total)
    x[:N] = burst
    g = 0.975 if palm else 0.9985 - 0.0006 * max(0.0, (midi - 40) / 24)
    # y[n] = x[n] + g * (y[n-N] + y[n-N-1]) / 2   (fractional delay approximated by the allpass below)
    den = np.zeros(N + 2)
    den[0] = 1.0
    den[N] -= g / 2
    den[N + 1] -= g / 2
    y = lfilter([1.0], den, x)
    if c:
        y = lfilter([c, 1.0], [1.0, c], y)
    y = y[::OS]
    n = len(y)
    env = np.ones(n)
    end = int(dur * SR)
    rel = int((0.012 if palm else 0.04) * SR)
    if end < n:
        env[end:] = 0.0
        r0 = max(0, end - rel)
        env[r0:end] = np.linspace(1, 0, end - r0)
    if palm:
        env *= np.exp(-np.arange(n) / (0.09 * SR))
    return (y * env).astype(np.float64)


def biquad_peak(f0: float, gain_db: float, q: float):
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / SR
    alpha = np.sin(w) / (2 * q)
    b = [1 + alpha * A, -2 * np.cos(w), 1 - alpha * A]
    a = [1 + alpha / A, -2 * np.cos(w), 1 - alpha / A]
    return np.array(b) / a[0], np.array(a) / a[0]


def amp_chain(x: np.ndarray, gain: float = 60.0, tone: float = 0.5) -> np.ndarray:
    """High-gain amp + 4x12 cab approximation."""
    sos_hp = butter(2, 110, "highpass", fs=SR, output="sos")
    x = sosfilt(sos_hp, x)
    b, a = biquad_peak(750, 6, 0.8)
    x = lfilter(b, a, x)
    x = np.tanh(gain * x + 0.12)  # asymmetric first stage
    x = x - np.mean(x)
    x = sosfilt(butter(1, 6000, "lowpass", fs=SR, output="sos"), x)
    x = np.tanh(2.5 * x)  # second stage
    # cabinet: HP 80 Hz, resonant low-mid, presence, steep LP ~5 kHz
    x = sosfilt(butter(2, 80, "highpass", fs=SR, output="sos"), x)
    for f, gdb, q in ((120, 3, 1.0), (400, -4, 1.2), (2500, 4 * tone, 1.5)):
        b, a = biquad_peak(f, gdb, q)
        x = lfilter(b, a, x)
    x = sosfilt(butter(4, 5200, "lowpass", fs=SR, output="sos"), x)
    return x / (np.max(np.abs(x)) + 1e-9)


# ----------------------------------------------------------------------------- drums / vocals / fx


def kick(rng):
    t = np.arange(int(0.25 * SR)) / SR
    f = 55 + 90 * np.exp(-t * 35)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14)
    click = rng.normal(0, 1, len(t)) * np.exp(-t * 400) * 0.3
    return s + click


def snare(rng):
    t = np.arange(int(0.22 * SR)) / SR
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
    noise = sosfilt(butter(2, [1500, 9000], "bandpass", fs=SR, output="sos"), rng.normal(0, 1, len(t))) * np.exp(-t * 18)
    return 0.6 * body + 0.9 * noise


def hat(rng, open_=False):
    t = np.arange(int((0.25 if open_ else 0.06) * SR)) / SR
    n = sosfilt(butter(4, 7000, "highpass", fs=SR, output="sos"), rng.normal(0, 1, len(t)))
    return n * np.exp(-t * (8 if open_ else 70)) * 0.35


def vocal_note(midi: float, dur: float, rng) -> np.ndarray:
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 440 * 2 ** ((midi - 69) / 12) * (1 + 0.012 * np.sin(2 * np.pi * 5.5 * t) * np.minimum(1, t * 3))
    ph = 2 * np.pi * np.cumsum(f) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 30))
    out = np.zeros(n)
    for fc, bw, g in ((700, 120, 1.0), (1150, 150, 0.6), (2600, 300, 0.35)):
        out += g * sosfilt(butter(2, [fc - bw, fc + bw], "bandpass", fs=SR, output="sos"), saw)
    env = np.minimum(1, t / 0.05) * np.minimum(1, (dur - t) / 0.08).clip(0, 1)
    return out * env


def stereo_reverb(x: np.ndarray, rng, decay: float = 1.8, mix: float = 0.35) -> np.ndarray:
    n = int(decay * SR)
    t = np.arange(n) / SR
    irs = [rng.normal(0, 1, n) * np.exp(-t * 6.9 / decay) for _ in range(2)]
    from scipy.signal import fftconvolve

    wet = np.stack([fftconvolve(x, ir)[: len(x)] for ir in irs])
    wet /= np.max(np.abs(wet)) + 1e-9
    return wet * mix


def place(buf: np.ndarray, sig: np.ndarray, t: float, gain: float = 1.0):
    i = int(t * SR)
    if i >= buf.shape[-1]:
        return
    n = min(len(sig), buf.shape[-1] - i)
    buf[..., i : i + n] += gain * sig[:n]


# ----------------------------------------------------------------------------- riffs


def fret_of(midi: int, tuning, prefer_low: bool = True):
    best = None
    for s in range(len(tuning) - 1, -1, -1) if prefer_low else range(len(tuning)):
        f = midi - tuning[s]
        if 0 <= f <= 15:
            if best is None or (f < best[1] and not prefer_low):
                best = (s, f)
            if prefer_low:
                return s, f
    return best or (len(tuning) - 1, max(0, midi - tuning[-1]))


def power(root_string: int, fret: int, tuning, octave: bool = True):
    """Power chord shape (root, fifth, optional octave) on adjacent strings."""
    notes = [(root_string, fret, tuning[root_string] + fret)]
    s5 = root_string - 1
    f5 = tuning[root_string] + fret + 7 - tuning[s5]
    notes.append((s5, f5, tuning[s5] + f5))
    if octave:
        s8 = root_string - 2
        f8 = tuning[root_string] + fret + 12 - tuning[s8]
        notes.append((s8, f8, tuning[s8] + f8))
    return notes


def make_song(seed: int, bpm: float, sections: list, rng) -> dict:
    beat = 60.0 / bpm
    s16 = beat / 4
    events = []  # (time, dur, [(string, fret, midi)], palm, part)
    bass_events = []
    lead_events = []
    vocal_events = []
    drums = []  # (time, kind)
    t0 = 0.5
    for sec in sections:
        kind, bars, tuning = sec["kind"], sec["bars"], sec["tuning"]
        low = tuning[-1]
        for bar in range(bars):
            bt = t0 + bar * 4 * beat
            if kind == "chug":
                accents = {0: 1, 6: 3, 10: 1, 14: 3}  # 16th index -> fret of power chord on low string
                for i in range(16):
                    t = bt + i * s16
                    if i in accents:
                        chord = power(5, accents[i] + (bar % 2) * 2, tuning)
                        events.append((t, s16 * 1.9, chord, False))
                        bass_events.append((t, s16 * 1.9, chord[0][2] - 12))
                    elif i not in (1, 7, 11, 15):
                        events.append((t, s16 * 0.9, [(5, 0, low)], True))
                        bass_events.append((t, s16 * 0.9, low - 12))
                    if i % 2 == 0:
                        drums.append((t, "kick"))
                drums += [(bt + beat, "snare"), (bt + 3 * beat, "snare")] + [(bt + k * beat / 2, "hat") for k in range(8)]
            elif kind == "gallop":
                roots = [0, 0, 3, 5][bar % 4]
                for b in range(4):
                    t = bt + b * beat
                    for off, d in ((0, s16 * 1.8), (2 * s16, s16 * 0.9), (3 * s16, s16 * 0.9)):
                        chord = power(5, roots + (2 if b == 3 else 0), tuning, octave=False)
                        events.append((t + off, d, chord, off > 0))
                        bass_events.append((t + off, d, chord[0][2] - 12))
                    drums += [(t, "kick"), (t + 2 * s16, "kick"), (t + 3 * s16, "kick")]
                drums += [(bt + beat, "snare"), (bt + 3 * beat, "snare")]
            elif kind == "power":
                prog = [(5, 0), (5, 3), (4, 0), (5, 5)][bar % 4]
                chord = power(prog[0], prog[1], tuning)
                for b in (0, 2):
                    events.append((bt + b * beat, 2 * beat * 0.95, chord, False))
                    bass_events.append((bt + b * beat, 2 * beat * 0.95, chord[0][2] - 12))
                drums += [(bt + b * beat, "kick") for b in range(4)] + [(bt + beat, "snare"), (bt + 3 * beat, "snare"), (bt, "crash")]
                mel = [72, 71, 69, 67, 69, 71, 72, 74][bar % 8]
                lead_events.append((bt, 1.5 * beat, mel))
                lead_events.append((bt + 2 * beat, 1.5 * beat, mel - 2))
                vocal_events.append((bt + 0.02, 3.6 * beat, [57, 59, 60, 62][bar % 4]))
            elif kind == "run":
                line = [0, 1, 3, 0, 5, 3, 1, 0, 0, 6, 5, 3, 1, 3, 1, 0]
                for i, f in enumerate(line):
                    s, ff = (5, f + (bar % 2) * 2) if f <= 5 else (4, f - 5)
                    midi = tuning[s] + ff
                    events.append((bt + i * s16, s16 * 0.92, [(s, ff, midi)], i % 4 != 0))
                    bass_events.append((bt + i * s16, s16 * 0.92, midi - 12))
                    if i % 2 == 0:
                        drums.append((bt + i * s16, "kick"))
                drums += [(bt + beat, "snare"), (bt + 3 * beat, "snare")]
            elif kind == "tremolo":
                mel = [(2, 2), (2, 3), (2, 5), (1, 3)][bar % 4]  # G/B string melody
                for i in range(16):
                    s, f = mel if i < 8 else (mel[0], mel[1] + 2)
                    events.append((bt + i * s16, s16 * 0.95, [(s, f, tuning[s] + f)], False))
                for b in range(4):
                    bass_events.append((bt + b * beat, beat * 0.95, tuning[5] + [0, 0, 3, 5][bar % 4] - 12 + 12))
                drums += [(bt + i * s16, "kick") for i in range(16)] + [(bt + b * beat, "snare") for b in range(4)]
        t0 += bars * 4 * beat
    duration = t0 + 1.5

    n = int(duration * SR)
    gtr = np.zeros((2, n))
    truth_rhythm = []
    for take in (0, 1):
        trk = np.zeros(n)
        r = np.random.default_rng(seed * 10 + take)
        for t, d, notes, palm in events:
            jitter = r.normal(0, 0.006)
            for k, (s, f, midi) in enumerate(sorted(notes, key=lambda x: x[2])):
                sig = pluck(midi + r.normal(0, 0.03), d, r, palm=palm, bright=0.45 if palm else 0.7)
                place(trk, sig, t + jitter + k * 0.004, 0.55 if palm else 0.5)
        gtr[take] = amp_chain(trk, gain=70 if take == 0 else 55)
    for t, d, notes, palm in events:
        for s, f, midi in notes:
            truth_rhythm.append([round(t, 4), round(t + d, 4), int(midi), int(s), int(f)])

    bass = np.zeros(n)
    for t, d, midi in bass_events:
        sig = pluck(midi, d, rng, palm=False, bright=0.3)
        place(bass, np.tanh(2.0 * sig), t, 0.7)
    bass = sosfilt(butter(2, 3500, "lowpass", fs=SR, output="sos"), bass)

    lead = np.zeros(n)
    for t, d, midi in lead_events:
        place(lead, pluck(midi, d, rng, palm=False, bright=0.8), t)
    lead = amp_chain(lead, gain=25, tone=0.8) * 0.6 if lead_events else lead
    lead_st = np.stack([lead, lead]) + stereo_reverb(lead, rng, 1.2, 0.25)

    vox = np.zeros(n)
    for t, d, midi in vocal_events:
        place(vox, vocal_note(midi, d, rng), t)
    vox = vox / (np.max(np.abs(vox)) + 1e-9) if vocal_events else vox
    vox_st = np.stack([vox, vox]) * 0.5 + stereo_reverb(vox, rng, 2.2, 0.4)

    dr = np.zeros(n)
    for t, k in drums:
        sig = {"kick": kick, "snare": snare, "hat": hat, "crash": lambda g: hat(g, True) * 2}[k](rng)
        place(dr, sig, t, {"kick": 0.9, "snare": 0.7, "hat": 0.5, "crash": 0.6}[k])

    mix = np.zeros((2, n))
    mix[0] += 0.42 * gtr[0]
    mix[1] += 0.42 * gtr[1]
    mix += 0.38 * bass
    mix += 0.30 * dr / (np.max(np.abs(dr)) + 1e-9)
    mix += 0.28 * lead_st
    mix += 0.25 * vox_st
    stems_true = {
        "rhythm": np.stack([0.42 * gtr[0], 0.42 * gtr[1]]),
        "bass": np.stack([0.38 * bass, 0.38 * bass]),
        "drums": np.stack([0.30 * dr / (np.max(np.abs(dr)) + 1e-9)] * 2),
        "lead": 0.28 * lead_st,
        "vocals": 0.25 * vox_st,
    }
    mix = np.tanh(1.6 * mix) / np.tanh(1.6)  # "mastering" saturation
    norm = 0.95 / (np.max(np.abs(mix)) + 1e-9)
    mix *= norm

    truth = {
        "bpm": bpm,
        "duration": duration,
        "rhythm": sorted(truth_rhythm),
        "bass": sorted([[round(t, 4), round(t + d, 4), int(m)] for t, d, m in bass_events]),
        "lead": sorted([[round(t, 4), round(t + d, 4), int(m)] for t, d, m in lead_events]),
        "vocals": sorted([[round(t, 4), round(t + d, 4), int(m)] for t, d, m in vocal_events]),
        "sections": [s["kind"] + ("-dropC" if s["tuning"] == DROP_C else "") for s in sections],
    }
    return {"mix": mix.astype(np.float32), "truth": truth, "stems": {k: (v * norm).astype(np.float32) for k, v in stems_true.items()}}


SONGS = [
    {"bpm": 180, "sections": [("chug", 8, STANDARD), ("gallop", 8, STANDARD), ("power", 8, STANDARD), ("run", 8, STANDARD), ("tremolo", 4, STANDARD), ("chug", 8, DROP_C)]},
    {"bpm": 132, "sections": [("power", 8, DROP_C), ("chug", 8, DROP_C), ("run", 8, STANDARD), ("gallop", 8, STANDARD), ("tremolo", 4, STANDARD)]},
]


def main():
    out = Path(sys.argv[1])
    count = int(sys.argv[sys.argv.index("--songs") + 1]) if "--songs" in sys.argv else len(SONGS)
    for i, spec in enumerate(SONGS[:count]):
        rng = np.random.default_rng(100 + i)
        sections = [{"kind": k, "bars": b, "tuning": tn} for k, b, tn in spec["sections"]]
        song = make_song(i, spec["bpm"], sections, rng)
        d = out / f"song{i + 1}_{spec['bpm']}bpm"
        d.mkdir(parents=True, exist_ok=True)
        sf.write(d / "mix.flac", song["mix"].T, SR, subtype="PCM_24")
        (d / "truth.json").write_text(json.dumps(song["truth"]), encoding="utf-8")
        td = d / "stems_true"
        td.mkdir(exist_ok=True)
        for name, a in song["stems"].items():
            sf.write(td / f"{name}.flac", a.T, SR, subtype="PCM_24")
        print(f"{d.name}: {song['truth']['duration']:.1f}s, rhythm notes {len(song['truth']['rhythm'])}, bass {len(song['truth']['bass'])}")


if __name__ == "__main__":
    main()
