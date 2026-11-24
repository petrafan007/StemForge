"""
Splits a stereo rhythm-guitar stem into its two guitars (double-tracked rhythm guitars are panned to
opposite sides) so each one gets its own track, and its own tab transcribed from its own sound.

Model, per STFT bin (powers add because the two takes are independent recordings):

    |L|^2 = |A|^2 + c^2 |B|^2        A = the guitar on the left, B = the guitar on the right
    |R|^2 = |B|^2 + c^2 |A|^2        c = how much of each guitar leaks into the other side
                                         (panning short of hard L/R, room, reverb, separation)

Solving for |A|^2 and |B|^2 gives Wiener masks: the part of the left channel that is guitar A and the
part of the right channel that is guitar B; the remainders (the other guitar's leakage) go to the
other track. Where the guitars play different notes the other guitar's notes are removed (on the
Extol test song its notes drop from -15 dB to -23 / -33 dB under the guitar's own note); where both
play the same note in the same bin they cannot be told apart by position, and each track keeps its
own side. Guitar 1 + Guitar 2 = the original stem, exactly.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
import torch
import torch.nn.functional as F

N_FFT = 4096  # 93 ms at 44.1 kHz: resolves low riff notes a fifth apart (E2 / B2)
HOP = 1024
SMOOTH = 3  # time / frequency smoothing of the power estimates (bins), against "musical noise"
OVER = 3.0  # leakage over-subtraction: removes the other guitar firmly, keeps unison notes (~-0.2 dB)


def _bands(freqs: torch.Tensor) -> torch.Tensor:
    """Third-octave band index per frequency bin (leakage is estimated per band)."""
    f = torch.clamp(freqs, min=40.0)
    return torch.floor(3 * torch.log2(f / 40.0)).long()


def estimate_crosstalk(PL: torch.Tensor, PR: torch.Tensor, freqs: torch.Tensor, floor: float = 0.003, ceil: float = 0.35) -> torch.Tensor:
    """
    c^2 per frequency bin, [F, 1]: in loud bins where one side clearly dominates (> 9 dB), the other
    side's power relative to it over the whole song (lower quartile per third-octave band, because
    bins that also hold some of the other guitar's own notes read higher).
    """
    e = PL + PR
    sample = e[e > 0].flatten()
    loud = e > torch.quantile(sample[:: max(1, sample.numel() // 2_000_000)], 0.6)
    ratio_l = PR / (PL + 1e-12)  # left-dominant bins: leakage into the right channel
    ratio_r = PL / (PR + 1e-12)
    band = _bands(freqs)
    c2 = torch.full((PL.shape[0],), 0.06, dtype=PL.dtype)
    for b in torch.unique(band):
        rows = band == b
        vals = torch.cat([ratio_l[rows][loud[rows] & (ratio_l[rows] < 0.125)], ratio_r[rows][loud[rows] & (ratio_r[rows] < 0.125)]])
        if vals.numel() >= 200:
            c2[rows] = float(torch.quantile(vals[:: max(1, vals.numel() // 500_000)], 0.25))
    return torch.clamp(c2, floor, ceil)[:, None]


def _stft(x: torch.Tensor) -> torch.Tensor:
    return torch.stft(x, N_FFT, HOP, window=torch.hann_window(N_FFT), return_complex=True)


def compute_masks(stereo: np.ndarray, sr: int, over: float = OVER) -> Tuple[torch.Tensor, torch.Tensor, Dict[str, float]]:
    """(share of the left channel that is the left guitar, share of the right channel that is the
    right guitar, info) for every STFT bin."""
    S = _stft(torch.from_numpy(np.ascontiguousarray(stereo[:2], dtype=np.float32)))
    PL, PR = S[0].abs() ** 2, S[1].abs() ** 2
    k = torch.ones(1, 1, SMOOTH, SMOOTH) / (SMOOTH * SMOOTH)
    PLs = F.conv2d(PL[None, None], k, padding=SMOOTH // 2)[0, 0]
    PRs = F.conv2d(PR[None, None], k, padding=SMOOTH // 2)[0, 0]
    c2 = estimate_crosstalk(PLs, PRs, torch.fft.rfftfreq(N_FFT, 1.0 / sr))
    den = 1.0 - c2 * c2
    A = torch.clamp((PLs - over * c2 * PRs) / den, min=0.0)
    B = torch.clamp((PRs - over * c2 * PLs) / den, min=0.0)
    m_al = A / (A + c2 * B + 1e-12)
    m_br = B / (B + c2 * A + 1e-12)
    quiet = (PLs + PRs) < 1e-10  # empty bins stay where they are
    m_al = torch.where(quiet, torch.ones_like(m_al), m_al)
    m_br = torch.where(quiet, torch.ones_like(m_br), m_br)
    return m_al, m_br, {"crosstalkDb": round(float(10 * torch.log10(torch.median(c2))), 1)}


def apply_masks(stereo: np.ndarray, m_al: torch.Tensor, m_br: torch.Tensor) -> np.ndarray:
    """The left guitar's part of `stereo` (its share of the left channel + its leakage into the right)."""
    x = torch.from_numpy(np.ascontiguousarray(stereo[:2], dtype=np.float32))
    S = _stft(x)
    g1 = torch.istft(torch.stack([m_al * S[0], (1 - m_br) * S[1]]), N_FFT, HOP, window=torch.hann_window(N_FFT), length=x.shape[1])
    return g1.numpy().astype(np.float32)


def split_left_right(stereo: np.ndarray, sr: int, over: float = OVER) -> Tuple[np.ndarray, np.ndarray, Dict[str, float]]:
    """stereo [2, n] -> (guitar 1 = the left guitar [2, n], guitar 2 = the right guitar [2, n], info).
    Each keeps its place in the stereo image, and guitar 1 + guitar 2 == stereo."""
    m_al, m_br, info = compute_masks(stereo, sr, over)
    g1 = apply_masks(stereo, m_al, m_br)
    g2 = (stereo[:2].astype(np.float32) - g1).astype(np.float32)
    e1, e2 = float(np.sum(g1.astype(np.float64) ** 2)), float(np.sum(g2.astype(np.float64) ** 2))
    info["guitar1Share"] = round(e1 / max(1e-12, e1 + e2), 3)
    return g1, g2, info


class Ownership:
    """
    Which guitar a transcribed note belongs to, from the split masks: the share of the note's energy
    (its harmonics, over its first ~150 ms, in the side's own channel) that the split gives to that
    side's guitar. A note detected in the left channel that is really the right guitar leaking in
    (a different note than the left guitar plays) has a low share and is dropped from the left part.
    """

    HARMONICS = 8
    F_MAX = 5000.0

    def __init__(self, stereo: np.ndarray, sr: int, over: float = OVER):
        m_al, m_br, self.info = compute_masks(stereo, sr, over)
        S = _stft(torch.from_numpy(np.ascontiguousarray(stereo[:2], dtype=np.float32)))
        top = int(self.F_MAX * N_FFT / sr) + 2  # only the bins notes are checked in (saves memory)
        self.power = ((S[0, :top].abs() ** 2).numpy(), (S[1, :top].abs() ** 2).numpy())
        self.mask = (m_al[:top].numpy(), m_br[:top].numpy())
        self.sr = sr
        self.frames = S.shape[2]

    def share(self, side: int, start: float, end: float, midi: float) -> float:
        a = max(0, int(round((start + 0.01) * self.sr / HOP)))
        b = min(self.frames, max(a + 1, int(round(min(end, start + 0.15) * self.sr / HOP)) + 1))
        f0 = 440.0 * 2 ** ((midi - 69) / 12)
        bins = [int(round(h * f0 * N_FFT / self.sr)) for h in range(1, self.HARMONICS + 1) if h * f0 < self.F_MAX]
        rows = sorted({k for c in bins for k in (c - 1, c, c + 1) if 0 <= k < self.power[side].shape[0]})
        if not rows or a >= b:
            return 1.0
        P = self.power[side][rows, a:b]
        tot = float(P.sum())
        return float((self.mask[side][rows, a:b] * P).sum() / tot) if tot > 1e-12 else 1.0

    def filter(self, notes: List[List[float]], side: int, min_share: float = 0.5) -> Tuple[List[List[float]], int]:
        """Notes of one side's part that belong to that side's guitar; returns (kept, dropped count)."""
        kept = [n for n in notes if self.share(side, n[0], n[1], n[2]) >= min_share]
        return kept, len(notes) - len(kept)


def channel_correlation(stereo: np.ndarray, step: int = 32) -> float:
    a, b = stereo[0, ::step].astype(np.float64), stereo[1, ::step].astype(np.float64)
    den = float(np.sqrt(np.dot(a, a) * np.dot(b, b)))
    return float(np.dot(a, b) / den) if den > 0 else 1.0


def channel_balance_db(stereo: np.ndarray) -> float:
    el = float(np.mean(stereo[0].astype(np.float64) ** 2)) + 1e-20
    er = float(np.mean(stereo[1].astype(np.float64) ** 2)) + 1e-20
    return 10 * float(np.log10(el / er))


def should_split(stereo: np.ndarray) -> bool:
    """Two guitars on opposite sides: a stereo stem whose sides both carry a guitar (within 9 dB of
    each other) and are clearly different recordings (not one centred guitar)."""
    return stereo.ndim == 2 and stereo.shape[0] >= 2 and abs(channel_balance_db(stereo)) < 9.0 and channel_correlation(stereo) < 0.9
