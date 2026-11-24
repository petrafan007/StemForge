"""
Periodicity-based transcription for distorted guitar and bass ("riff transcriber").

Why: a picked string is periodic no matter how much distortion, amp EQ or cabinet colouring is
applied, while spectral models (e.g. Basic Pitch) get fooled by distortion overtones and
intermodulation. So every pick attack is segmented, and each segment's waveform periodicity
(YIN cumulative-mean-normalised difference, d') decides what was played:

  * single note at f      : d'(f) is tiny, d'(2f) and d'(3f) are high
  * power chord, root R   : the common period is R/2 -> d'(R/2) low, d'(R) and d'(1.5R) moderate
  * + octave on top       : d'(2R) moderate instead of high
  * nothing periodic      : drum bleed / noise / reverb wash -> no note (phantom filter), or a
                            genuinely complex chord -> Basic Pitch's notes for that segment are used

Hard-panned double-tracked guitars are analysed per channel (each channel is one clean guitar).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

SR = 22050
HOP = 128  # 5.8 ms analysis hop
FPS = SR / HOP


def hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def midi_of(f: float) -> float:
    return 69 + 12 * np.log2(max(f, 1e-6) / 440.0)


# ----------------------------------------------------------------------------- YIN core


def cmndf(x: np.ndarray, tau_max: int) -> np.ndarray:
    """YIN cumulative mean normalised difference d'(tau) for tau = 0..tau_max (FFT based)."""
    W = len(x) - tau_max
    if W < 16:
        return np.ones(tau_max + 1)
    x2 = np.concatenate([[0.0], np.cumsum(x * x)])
    taus = np.arange(tau_max + 1)
    e0 = x2[W]
    eT = x2[taus + W] - x2[taus]
    n = 1 << int(np.ceil(np.log2(len(x) + W)))
    corr = np.fft.irfft(np.fft.rfft(x, n) * np.conj(np.fft.rfft(x[:W], n)), n)[: tau_max + 1]
    d = np.maximum(e0 + eT - 2 * corr, 0.0)
    d[0] = 0.0
    cs = np.cumsum(d)
    cm = np.ones_like(d)
    cm[1:] = d[1:] * taus[1:] / np.maximum(cs[1:], 1e-12)
    return cm


def dmin_near(cm: np.ndarray, f: float, cents: float = 45.0) -> Tuple[float, float]:
    """Minimum d' within +/- cents of the period of f; returns (value, refined frequency)."""
    tau = SR / f
    lo = max(2, int(np.floor(tau * 2 ** (-cents / 1200))))
    hi = int(np.ceil(tau * 2 ** (cents / 1200)))
    if hi >= len(cm) - 1 or lo >= hi:
        return 1.0, f
    k = lo + int(np.argmin(cm[lo : hi + 1]))
    # parabolic refinement of the period
    a, b, c = cm[k - 1], cm[k], cm[k + 1]
    den = a - 2 * b + c
    off = 0.5 * (a - c) / den if den > 1e-9 else 0.0
    return float(b), SR / (k + float(np.clip(off, -0.5, 0.5)))


@dataclass
class SegmentPitch:
    kind: str  # single | power | power8 | aperiodic
    root: int = 0
    pitches: Tuple[int, ...] = ()
    clarity: float = 0.0  # 1 - d' at the chosen period
    f0: float = 0.0
    d_octave: float = 1.0  # d' at twice the root frequency (octave-on-top evidence)


def classify_segment(seg: np.ndarray, lo_midi: float, hi_midi: float, allow_chords: bool = True) -> SegmentPitch:
    """Decides single note / power chord / aperiodic for one analysis window (mono, SR)."""
    if len(seg) < 64 or float(np.sqrt(np.mean(seg * seg))) < 1e-5:
        return SegmentPitch("aperiodic")
    f_lowest = hz(lo_midi - (12 if allow_chords else 0) - 0.5)
    tau_max = min(int(SR / f_lowest) + 2, len(seg) // 2)
    cm = cmndf(seg.astype(np.float64), tau_max)
    lowest_ok = SR / max(tau_max - 2, 3)
    # scan semitone candidates from high to low; the first clearly periodic one is the fundamental
    top = int(np.ceil(hi_midi))
    bottom = int(np.floor(lo_midi - (12 if allow_chords else 0)))
    best: Optional[Tuple[int, float, float]] = None
    for m in range(top, bottom - 1, -1):
        f = hz(m)
        if f < lowest_ok:
            break
        v, fr = dmin_near(cm, f)
        if v < 0.45:
            # take the deepest dip within a semitone neighbourhood (protects against +/-1 errors)
            cand = [(v, m, fr)]
            for mm in (m - 1,):
                if hz(mm) >= lowest_ok:
                    vv, ff = dmin_near(cm, hz(mm))
                    cand.append((vv, mm, ff))
            v, m, fr = min(cand)
            best = (m, v, fr)
            break
    if best is None:
        return SegmentPitch("aperiodic")
    m, v, fr = best
    mf = midi_of(fr)
    g = int(round(mf))
    if allow_chords:
        d2, f2 = dmin_near(cm, fr * 2)
        d3, _ = dmin_near(cm, fr * 3)
        # A single note is extremely periodic at its own pitch (d' ~0.06); the common period of a
        # power chord is clearly less so (~0.2-0.3). Strong even harmonics from distortion can make
        # a single note look partly periodic at its octave, so that alone is not enough.
        need = 1.55 if g < lo_midi + 12 else 1.4  # high-register "power chords" need stronger evidence
        # A chord's root (2g) is clearly LESS periodic than the common period g (~0.55 vs ~0.25),
        # while a noisy single note at 2g is about equally periodic at 2g and at its subharmonic g.
        sep = d2 - v
        power = (d2 + d3) < need and d2 < 0.8 and v > 0.1 and (sep > 0.12 or d3 < 0.8)
        if not power and g < lo_midi - 0.5:
            if sep <= 0.12 and d2 < 0.6:
                # periodic at g and 2g alike: the scan landed an octave low on a single note
                g2 = int(round(midi_of(f2)))
                if lo_midi - 0.5 <= g2 <= hi_midi + 0.5:
                    return SegmentPitch("single", g2, (g2,), 1 - d2, f2)
                return SegmentPitch("aperiodic")
            power = True  # below the instrument's range: must be the common period of a chord
        if power:
            root = g + 12
            if root > hi_midi + 0.5:
                return SegmentPitch("aperiodic")
            d4, _ = dmin_near(cm, fr * 4)
            pitches = (root, root + 7, root + 12) if d4 < 0.84 else (root, root + 7)
            return SegmentPitch("power8" if len(pitches) == 3 else "power", root, pitches, 1 - v, fr * 2, d4)
    if g < lo_midi - 0.5 or g > hi_midi + 0.5:
        return SegmentPitch("aperiodic")
    return SegmentPitch("single", g, (g,), 1 - v, fr)


# ----------------------------------------------------------------------------- onsets


def onset_envelope(x: np.ndarray) -> np.ndarray:
    """SuperFlux-style onset strength with emphasis on the high-frequency pick noise (re-picked
    distorted notes barely change in level, but every pick adds a short broadband click)."""
    import librosa

    S = librosa.feature.melspectrogram(y=x, sr=SR, n_fft=512, hop_length=HOP, n_mels=128, fmin=150, fmax=10500, power=1.0)
    logS = np.log1p(100.0 * S) * np.linspace(1.0, 3.5, 128)[:, None]
    return librosa.onset.onset_strength(S=logS, sr=SR, hop_length=HOP, lag=2, max_size=3, center=False)


def pick_onsets(env: np.ndarray, sensitivity: float = 0.6, min_ioi: float = 0.045) -> np.ndarray:
    import librosa

    if env.size == 0 or not np.any(env > 0):
        return np.array([])
    norm = env / (np.percentile(env[env > 0], 98) + 1e-9)
    delta = float(np.clip(0.16 - 0.14 * sensitivity, 0.02, 0.2))
    wait = max(1, int(min_ioi * FPS))
    peaks = librosa.util.peak_pick(norm, pre_max=3, post_max=3, pre_avg=14, post_avg=4, delta=delta, wait=wait)
    return peaks / FPS


def merge_onsets(lists: Sequence[np.ndarray], window: float = 0.03) -> np.ndarray:
    allt = np.sort(np.concatenate([np.asarray(t) for t in lists if len(t)])) if any(len(t) for t in lists) else np.array([])
    out: List[float] = []
    for t in allt:
        if out and t - out[-1] < window:
            continue
        out.append(float(t))
    return np.array(out)


# ----------------------------------------------------------------------------- transcription


def _rms_env(x: np.ndarray) -> np.ndarray:
    n = len(x) // HOP
    fr = x[: n * HOP].reshape(n, HOP)
    return np.sqrt(np.mean(fr * fr, axis=1) + 1e-12)


ONSET_LAG = 0.006  # flux peak vs. physical attack (calibrated on the benchmark)


def analysis_window(lo_midi: float, allow_chords: bool) -> float:
    """Window holding ~2 periods of the lowest frequency that can occur (seconds)."""
    f_low = hz(lo_midi - (12 if allow_chords else 0) - 0.5)
    return float(np.clip(2.2 / f_low + 0.004, 0.03, 0.1))


def _classify_all(chans: Sequence[np.ndarray], a: int, b: int, lo: float, hi: float, chords: bool) -> List[SegmentPitch]:
    out = []
    for c in chans:
        r = classify_segment(c[a:b], lo, hi, chords)
        if r.kind != "aperiodic":
            out.append(r)
    return out


def _frame_pitch(results: List[SegmentPitch]) -> Optional[float]:
    """Fractional MIDI pitch of the lowest root among the channel results."""
    if not results:
        return None
    low = min(r.root for r in results)
    return float(np.median([midi_of(r.f0) for r in results if r.root == low]))


def _combine(results: List[SegmentPitch], kinds: Dict[str, int]) -> Tuple[int, ...]:
    """Channel results -> pitch set. Same root: one decision (octave on top only if the averaged
    evidence says so). Different roots (harmonised guitars): keep both."""
    pitches = set()
    by_root: Dict[int, List[SegmentPitch]] = {}
    for r in results:
        by_root.setdefault(r.root, []).append(r)
    for root, rs in by_root.items():
        chord = [r for r in rs if r.kind in ("power", "power8")]
        if chord and len(chord) * 2 >= len(rs):
            d4 = float(np.mean([r.d_octave for r in chord]))
            kind = "power8" if d4 < 0.84 else "power"
            pitches.update((root, root + 7, root + 12) if kind == "power8" else (root, root + 7))
        else:
            kind = "single"
            pitches.add(root)
        kinds[kind] = kinds.get(kind, 0) + 1
    return tuple(sorted(pitches))


def _same_note(fp: float, cur: float) -> bool:
    """Within vibrato range of the current note, or exactly an octave away (tracking octave slip)."""
    d = abs(fp - cur)
    return d < 0.6 or abs(d - 12) < 0.6


def _correlation(x: np.ndarray, y: np.ndarray) -> float:
    den = float(np.sqrt(np.dot(x, x) * np.dot(y, y)))
    return float(np.dot(x, y) / den) if den > 1e-12 else 0.0


@dataclass
class NoteEvent:
    start: float
    end: float
    pitches: Tuple[int, ...]
    vel: int
    clarity: float  # periodicity confidence 0..1; 0 = spectral (Basic Pitch) fallback
    rise: float = 99.0  # level rise at the attack (dB)


def transcribe_events(
    channels: Sequence[np.ndarray],
    lo_midi: float,
    hi_midi: float,
    *,
    allow_chords: bool = True,
    sensitivity: float = 0.5,
    min_ioi: float = 0.045,
    fallback_notes: Optional[List[List[float]]] = None,
    bleed_refs: Optional[Sequence[np.ndarray]] = None,
    track: bool = True,
    gate: float = 0.06,
    retrigger_db: Optional[float] = None,
    onsets: Optional[np.ndarray] = None,
) -> Tuple[List[NoteEvent], Dict[str, float]]:
    """
    onsets: pick-attack times (raw onset-detector times) to use instead of detecting them here.
    channels: mono signals at 22.05 kHz analysed together as ONE performance (normally one channel).
    gate: segments quieter than this fraction of the stem's loud level are skipped (bleed / noise).
    retrigger_db: if set, a new attack on the SAME pitch while the note still sounds needs at least
        this level rise; smaller "attacks" are transients leaking in from other instruments.
    fallback_notes: notes from a spectral transcriber (Basic Pitch) used where the audio is not
        periodic (complex chords) - [[start, end, midi, velocity]].
    bleed_refs: other stems (mono, 22.05 kHz) whose leakage must not become notes here, e.g. the
        bass stem for the guitar: a "note" whose waveform matches a louder other stem is bleed.
    track: follow pitch changes inside a picked note (hammer-ons, pull-offs, slides, legato).
    """
    chans = [np.asarray(c, dtype=np.float64) for c in channels if len(c)]
    mid = np.mean(chans, axis=0)
    total = len(mid) / SR
    win = analysis_window(lo_midi, allow_chords)
    init_win = float(np.clip(win * 1.1, 0.04, 0.095))
    lead_in = 0.012 if win > 0.05 else 0.008  # skip the pick transient itself
    hop = 0.02 if win > 0.05 else 0.01
    refs = [np.asarray(r, dtype=np.float64) for r in (bleed_refs or []) if r is not None and len(r)]
    if len(refs) > 1:  # leakage from several stems at once looks like their sum
        m = min(len(r) for r in refs)
        refs.append(np.sum([r[:m] for r in refs], axis=0))
    if onsets is None:
        onsets = merge_onsets([pick_onsets(onset_envelope(c.astype(np.float32)), sensitivity, min_ioi) for c in chans])
    onsets = np.maximum(0.0, np.asarray(onsets, dtype=np.float64) - ONSET_LAG)
    env = _rms_env(mid)
    loud = float(np.percentile(env, 95)) + 1e-9
    # A pick attack keeps or raises the level; a flux peak where the level falls is a note
    # release / string noise, not a new note (its segment stays part of the previous note).
    keep = []
    for t in onsets:
        f = int(t * FPS)
        before = env[max(0, f - 5) : max(0, f - 1)]
        after = env[f + 1 : f + 8]
        if before.size and after.size and float(after.max()) < 0.7 * float(before.mean()):
            continue
        keep.append(t)
    released = len(onsets) - len(keep)
    onsets = np.array(keep)
    events: List[NoteEvent] = []
    kinds: Dict[str, int] = {}
    n = len(onsets)
    for i, t in enumerate(onsets):
        nxt = float(onsets[i + 1]) if i + 1 < n else min(total, float(t) + 2.0)
        t = float(t)
        fa, fb = int(t * FPS), max(int(t * FPS) + 1, int(nxt * FPS))
        seg_env = env[fa:fb] if fb <= len(env) else env[fa:]
        if seg_env.size == 0:
            continue
        peak = float(seg_env.max())
        if peak < loud * gate:  # far below the stem's loud parts: silence / bleed
            continue
        # note end: next onset or decay below -14 dB of the segment peak
        below = np.where(seg_env < peak * 0.2)[0]
        end_f = fa + (int(below[below > 1][0]) if np.any(below > 1) else len(seg_env))
        end = min(nxt, max(t + 0.04, end_f / FPS))
        vel = int(np.clip(round(127 * (0.35 + 0.65 * min(1.0, peak / loud))), 1, 127))
        before = env[max(0, fa - 5) : max(0, fa - 1)]
        rise = 20 * np.log10(peak / (float(before.mean()) + 1e-12)) if before.size else 99.0

        a = int((t + lead_in) * SR)
        b = int(min(t + lead_in + init_win, nxt - 0.004) * SR)
        if b - a < int(0.018 * SR):
            b = int(min(t + 0.03, total) * SR)
        results = _classify_all(chans, a, b, lo_midi, hi_midi, allow_chords)

        # a "single" that is only weakly periodic while the spectral model hears a full chord
        if results and fallback_notes and all(r.kind == "single" for r in results) and max(r.clarity for r in results) < 0.8:
            bp = {int(fn[2]) for fn in fallback_notes if t - 0.03 <= fn[0] < min(nxt, t + 0.12)}
            if len(bp) >= 3:
                results = []

        cur: Optional[Tuple[int, ...]] = _combine(results, kinds) if results else None
        clar = float(np.mean([r.clarity for r in results])) if results else 0.0
        cur_fp = _frame_pitch(results)
        start = t
        if track:
            prev: Optional[Tuple[float, float, List[SegmentPitch]]] = None
            ts = t + lead_in + hop
            wn = int(win * SR)
            limit = end - 0.002
            while ts + win <= limit:
                if cur is None and ts > t + 0.15:
                    break  # the attack never settled into a pitch
                res = _classify_all(chans, int(ts * SR), int(ts * SR) + wn, lo_midi, hi_midi, allow_chords)
                fp = _frame_pitch(res)
                if fp is None or (cur_fp is not None and _same_note(fp, cur_fp)):
                    prev = None
                elif prev is not None and abs(fp - prev[0]) < 0.35:
                    # two consecutive frames agree on a new pitch
                    both = prev[2] + res
                    if cur is None:
                        cur = _combine(both, kinds)  # noisy attack: the note still starts at the pick
                    else:
                        change = prev[1] + win / 2 - hop / 2
                        if change - start >= 0.03:
                            events.append(NoteEvent(start, change, cur, vel, clar, rise))
                            rise = 99.0  # a legato change is a new note by definition
                            start = change
                            kinds["legato"] = kinds.get("legato", 0) + 1
                        cur = _combine(both, kinds)
                    clar = float(np.mean([r.clarity for r in both]))
                    cur_fp = 0.5 * (fp + prev[0])
                    prev = None
                else:
                    prev = (fp, ts, res)
                ts += hop
        if cur is None:
            kinds["aperiodic"] = kinds.get("aperiodic", 0) + 1
            if fallback_notes:
                fb_notes = [fn for fn in fallback_notes if t - 0.03 <= fn[0] < nxt - 0.01]
                if fb_notes:
                    e = max(end, max(fn[1] if fn[1] < nxt else end for fn in fb_notes))
                    pitches = tuple(sorted({int(fn[2]) for fn in fb_notes}))
                    events.append(NoteEvent(t, e, pitches, int(max(fn[3] for fn in fb_notes)), 0.0, rise))
            continue
        events.append(NoteEvent(start, end, cur, vel, clar, rise))

    if retrigger_db is not None and events:
        merged = [events[0]]
        for ev in events[1:]:
            p = merged[-1]
            if ev.pitches == p.pitches and ev.start - p.end < 0.006 and ev.rise < retrigger_db:
                p.end = ev.end
                p.vel = max(p.vel, ev.vel)
                kinds["retriggerMerged"] = kinds.get("retriggerMerged", 0) + 1
            else:
                merged.append(ev)
        events = merged

    # bleed check: a note whose waveform matches a LOUDER other stem is that stem leaking in
    # (stems share one gain, so their levels are comparable)
    kept: List[NoteEvent] = []
    dropped = 0
    for ev in events:
        if refs:
            a, b = int(ev.start * SR), int(min(ev.end, ev.start + 0.12) * SR)
            x = mid[a:b]
            if len(x) > 64 and any(
                _correlation(x, r[a:b]) > 0.55 and float(np.dot(x, x)) < float(np.dot(r[a:b], r[a:b])) for r in refs if len(r) >= b
            ):
                dropped += 1
                continue
        kept.append(ev)
    stats = {k: float(v) for k, v in kinds.items()}
    stats["onsets"] = float(n)
    stats["bleedDropped"] = float(dropped)
    stats["releases"] = float(released)
    return kept, stats


def events_to_notes(events: Sequence[NoteEvent]) -> List[List[float]]:
    notes = [[round(ev.start, 4), round(ev.end, 4), int(p), int(ev.vel)] for ev in events for p in ev.pitches]
    notes.sort(key=lambda q: (q[0], q[2]))
    return notes


def transcribe_riff(channels: Sequence[np.ndarray], lo_midi: float, hi_midi: float, **kw) -> Tuple[List[List[float]], Dict[str, float]]:
    """transcribe_events -> notes [[start, end, midi, velocity]] and stats."""
    events, stats = transcribe_events(channels, lo_midi, hi_midi, **kw)
    return events_to_notes(events), stats


def _merge_pair(e: NoteEvent, f: NoteEvent, stats: Dict[str, float]) -> NoteEvent:
    pe, pf = set(e.pitches), set(f.pitches)
    if e.clarity == 0.0 and f.clarity > 0.5:
        pe = set()  # the other guitar is clearly periodic here: don't let spectral guesses add notes
    elif f.clarity == 0.0 and e.clarity > 0.5:
        pf = set()
    elif len(pe) == 1 and len(pf) == 1:
        x, y = next(iter(pe)), next(iter(pf))
        # one side an octave off while the other is cleaner: an octave error, not an octave part
        if abs(x - y) == 12 and min(e.clarity, f.clarity) < 0.85:
            if e.clarity >= f.clarity:
                pf = set()
            else:
                pe = set()
            stats["octaveFixed"] = stats.get("octaveFixed", 0.0) + 1
    pitches = tuple(sorted(pe | pf)) or e.pitches
    return NoteEvent(min(e.start, f.start), max(e.end, f.end), pitches, max(e.vel, f.vel), max(e.clarity, f.clarity), min(e.rise, f.rise))


def merge_performances(a: Sequence[NoteEvent], b: Sequence[NoteEvent], window: float = 0.05, stats: Optional[Dict[str, float]] = None) -> List[NoteEvent]:
    """
    Joins two separately transcribed performances (e.g. hard-panned double-tracked guitars, which
    never hit at exactly the same time - 30+ ms apart is normal) into one part: attacks within
    `window` of each other are one event (earliest attack, union of the notes both guitars play).
    """
    st = stats if stats is not None else {}
    ev = sorted([(e, 0) for e in a] + [(e, 1) for e in b], key=lambda x: x[0].start)
    used = [False] * len(ev)
    out: List[NoteEvent] = []
    for i, (e, ch) in enumerate(ev):
        if used[i]:
            continue
        used[i] = True
        partner = None
        for k in range(i + 1, len(ev)):
            if ev[k][0].start - e.start > window:
                break
            if not used[k] and ev[k][1] != ch:
                partner = k
                break
        if partner is None:
            out.append(e)
            continue
        used[partner] = True
        out.append(_merge_pair(e, ev[partner][0], st))
        st["paired"] = st.get("paired", 0.0) + 1
    # a held note of one guitar must not overlap the next attack of the merged part
    out.sort(key=lambda x: x.start)
    for i in range(len(out) - 1):
        if out[i].end > out[i + 1].start:
            out[i].end = max(out[i].start + 0.03, out[i + 1].start)
    return out


# Pitch ranges (MIDI) and analysis settings per stem. Guitar reaches down to A1 for drop-A /
# 7-string riffs; the bass to B0 (5-string) with a margin; leads up to the 24th fret plus bends.
STEM_SETTINGS: Dict[str, Dict[str, float]] = {
    "guitar": {"lo": 33, "hi": 88, "chords": 1, "mono": 0, "min_ioi": 0.045, "gate": 0.06},
    "lead": {"lo": 38, "hi": 93, "chords": 0, "mono": 1, "min_ioi": 0.04, "gate": 0.2, "retrigger_db": 3.0},
    "bass": {"lo": 22, "hi": 67, "chords": 0, "mono": 1, "min_ioi": 0.05, "gate": 0.08},
}


def transcribe_stem(
    stem: str,
    channels: Sequence[np.ndarray],
    *,
    sensitivity: float = 0.5,
    fallback_notes: Optional[List[List[float]]] = None,
    bleed_refs: Optional[Sequence[np.ndarray]] = None,
) -> Tuple[List[List[float]], Dict[str, float]]:
    """Guitar / lead / bass stem (channels at 22.05 kHz) -> notes [[start, end, midi, velocity]].
    A stereo guitar stem with different left / right content (double-tracked or harmony guitars) is
    transcribed per side and the two performances are merged."""
    cfg = STEM_SETTINGS[stem]
    chans = [np.asarray(c, dtype=np.float64) for c in channels if len(c)]
    if not chans:
        return [], {}
    kw = dict(
        allow_chords=bool(cfg["chords"]),
        sensitivity=sensitivity,
        min_ioi=cfg["min_ioi"],
        fallback_notes=fallback_notes,
        bleed_refs=bleed_refs,
        gate=cfg["gate"],
        retrigger_db=cfg.get("retrigger_db"),
    )
    lo = float(cfg["lo"])
    if cfg["mono"] or len(chans) == 1 or float(np.corrcoef(chans[0][::64], chans[1][::64])[0, 1]) > 0.97:
        sides = [np.mean(chans, axis=0)]
        ons = [pick_onsets(onset_envelope(sides[0].astype(np.float32)), sensitivity, cfg["min_ioi"])]
    else:
        sides = chans[:2]
        envs = [onset_envelope(c.astype(np.float32)) for c in sides]
        raw = [pick_onsets(e, sensitivity, cfg["min_ioi"]) for e in envs]
        # an attack heard on one guitar is looked for (with a lower threshold) on the other one too
        ons = [rescue_onsets(raw[0], raw[1], envs[0]), rescue_onsets(raw[1], raw[0], envs[1])]

    def run(lo_midi: float) -> Tuple[List[NoteEvent], Dict[str, float]]:
        per = [transcribe_events([c], lo_midi, cfg["hi"], onsets=o, **kw) for c, o in zip(sides, ons)]
        st: Dict[str, float] = {}
        for _, s_ in per:
            for k, v in s_.items():
                st[k] = st.get(k, 0.0) + v
        evs = per[0][0] if len(per) == 1 else merge_performances(per[0][0], per[1][0], stats=st)
        return evs, st

    events, stats = run(lo)
    if cfg["chords"]:
        # The lowest string decides what a very low period means: below the tuning's lowest note it
        # can only be the common period of a power chord, never a single note. Re-run with the
        # tuning floor found in the first pass.
        floor = tuning_floor(events, lo)
        if floor > lo + 0.5:
            events, stats = run(floor)
        stats["floor"] = floor
    return events_to_notes(events), stats


# lowest open string of common guitar tunings (MIDI): E, Eb, D, C#, C, B, A, F# (8-string)
GUITAR_FLOORS = (40, 39, 38, 37, 36, 35, 33, 30)


def tuning_floor(events: Sequence[NoteEvent], default: float) -> float:
    """Highest common-tuning floor that (almost) every confidently detected root sits on or above."""
    roots = [min(ev.pitches) for ev in events if ev.clarity > 0.5 and ev.pitches]
    if len(roots) < 30:
        return default
    r = np.array(roots)
    for f in GUITAR_FLOORS:
        if f < default:
            break
        if np.mean(r < f) <= 0.03:
            return float(f)
    return default


def rescue_onsets(own: np.ndarray, other: np.ndarray, env: np.ndarray, window: float = 0.045, min_strength: float = 0.12) -> np.ndarray:
    """Adds this side's (weaker) attack peaks next to the other side's attacks that this side missed."""
    own = np.asarray(own, dtype=np.float64)
    if env.size == 0 or not len(other):
        return own
    norm = env / (np.percentile(env[env > 0], 98) + 1e-9) if np.any(env > 0) else env
    add = []
    w = int(window * FPS)
    for t in other:
        if own.size and float(np.min(np.abs(own - t))) < window:
            continue
        f = int(t * FPS)
        a, b = max(1, f - w), min(len(norm) - 1, f + w + 1)
        if b <= a:
            continue
        k = a + int(np.argmax(norm[a:b]))
        if norm[k] >= min_strength and norm[k] >= norm[k - 1] and norm[k] >= norm[k + 1]:
            add.append(k / FPS)
    if not add:
        return own
    return merge_onsets([own, np.array(add)], window=0.03)


def estimate_floor(notes: List[List[float]], default: float) -> float:
    """Lowest regularly played pitch (duration-weighted 2nd percentile) -> instrument range floor."""
    if len(notes) < 12:
        return default
    roots: Dict[float, List[int]] = {}
    for n in notes:
        roots.setdefault(n[0], []).append(n[2])
    lows = np.array(sorted(min(v) for v in roots.values()))
    return float(lows[int(0.02 * (len(lows) - 1))])
