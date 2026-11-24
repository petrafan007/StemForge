"""
Processing pipeline for one project:

  decode original -> Demucs separation (quality modes) -> optional lead/rhythm guitar split
  -> 24-bit FLAC stems -> Basic Pitch polyphonic transcription (with silence gating)
  -> drum transcription (ADTOF if installed, else a band-onset detector) -> tempo & beat grid

Runs in a background thread; reports progress through a callback and can be cancelled.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf
import torch

log = logging.getLogger("stemforge")

MODEL_SR = 44100
GPU_LOCK = threading.Lock()  # one GPU-heavy job at a time keeps VRAM predictable

# --------------------------------------------------------------------------- options


@dataclass
class ProcessOptions:
    quality: str = "balanced"  # fast | balanced | high
    keyboards_mode: str = "merged"  # merged (piano + other) | piano
    split_guitars: bool = False  # lead (center) vs rhythm (sides)
    split_rhythm_guitars: bool = True  # the left and right rhythm guitar as two tracks (stemforge_server.sides)
    separate: bool = True  # False = keep existing stems, only re-transcribe
    transcribe: Dict[str, bool] = field(
        default_factory=lambda: {"guitar": True, "lead": True, "bass": True, "keyboards": True, "vocals": True, "drums": True}
    )
    sensitivity: Dict[str, float] = field(
        default_factory=lambda: {"guitar": 0.5, "bass": 0.5, "keyboards": 0.5, "vocals": 0.5, "drums": 0.5}
    )
    min_note_ms: float = 70.0
    tempo_min: float = 60.0
    tempo_max: float = 220.0
    tempo_prior: float = 120.0
    silence_gate_db: float = -45.0
    free_vram_after: bool = False

    @classmethod
    def from_dict(cls, d: Optional[Dict[str, Any]]) -> "ProcessOptions":
        o = cls()
        if not isinstance(d, dict):
            return o
        if d.get("quality") in ("fast", "balanced", "high"):
            o.quality = d["quality"]
        if d.get("keyboardsMode") in ("merged", "piano"):
            o.keyboards_mode = d["keyboardsMode"]
        o.split_guitars = bool(d.get("splitGuitars", o.split_guitars))
        o.split_rhythm_guitars = bool(d.get("splitRhythmGuitars", o.split_rhythm_guitars))
        o.separate = bool(d.get("separate", True))
        o.free_vram_after = bool(d.get("freeVramAfter", False))
        if isinstance(d.get("transcribe"), dict):
            for k, v in d["transcribe"].items():
                if k in o.transcribe:
                    o.transcribe[k] = bool(v)
        if isinstance(d.get("sensitivity"), dict):
            for k, v in d["sensitivity"].items():
                if k in o.sensitivity:
                    o.sensitivity[k] = float(np.clip(float(v), 0.0, 1.0))

        def num(key: str, lo: float, hi: float, default: float) -> float:
            try:
                return float(np.clip(float(d.get(key, default)), lo, hi))
            except (TypeError, ValueError):
                return default

        o.min_note_ms = num("minNoteMs", 20, 400, o.min_note_ms)
        o.tempo_min = num("tempoMin", 30, 300, o.tempo_min)
        o.tempo_max = num("tempoMax", 40, 400, o.tempo_max)
        if o.tempo_max <= o.tempo_min + 10:
            o.tempo_max = o.tempo_min + 10
        o.tempo_prior = num("tempoPrior", 40, 300, o.tempo_prior)
        o.silence_gate_db = num("silenceGateDb", -90, -10, o.silence_gate_db)
        return o

    def to_dict(self) -> Dict[str, Any]:
        return {
            "quality": self.quality,
            "keyboardsMode": self.keyboards_mode,
            "splitGuitars": self.split_guitars,
            "splitRhythmGuitars": self.split_rhythm_guitars,
            "transcribe": dict(self.transcribe),
            "sensitivity": dict(self.sensitivity),
            "minNoteMs": self.min_note_ms,
            "tempoMin": self.tempo_min,
            "tempoMax": self.tempo_max,
            "tempoPrior": self.tempo_prior,
            "silenceGateDb": self.silence_gate_db,
        }


class JobCancelled(Exception):
    pass


class Progress:
    def __init__(self, callback: Callable[[str, float], None], cancel: threading.Event):
        self._cb = callback
        self._cancel = cancel
        self.stage = ""
        self.percent = 0.0

    def set(self, stage: str, percent: float) -> None:
        self.check()
        self.stage = stage
        self.percent = float(np.clip(percent, 0, 100))
        self._cb(self.stage, self.percent)

    def set_percent(self, percent: float) -> None:
        self.check()
        self.percent = float(np.clip(percent, 0, 100))
        self._cb(self.stage, self.percent)

    def check(self) -> None:
        if self._cancel.is_set():
            raise JobCancelled()


# --------------------------------------------------------------------------- devices & models

_models: Dict[str, Any] = {}
_models_lock = threading.Lock()


def get_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def get_gpu_name() -> str:
    if torch.cuda.is_available():
        return torch.cuda.get_device_name(0)
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "Apple Silicon MPS"
    return "CPU (CUDA not detected)"


def vram_info() -> Dict[str, Optional[float]]:
    if not torch.cuda.is_available():
        return {"vram_gb": None, "vram_free_gb": None}
    free_b, total_b = torch.cuda.mem_get_info(0)
    return {"vram_gb": round(total_b / 1024**3, 1), "vram_free_gb": round(free_b / 1024**3, 1)}


def demucs_model(name: str):
    with _models_lock:
        if name in _models:
            return _models[name]
        from demucs.pretrained import get_model

        model = get_model(name)
        model.to(get_device())
        model.eval()
        _models[name] = model
        return model


def loaded_models() -> List[str]:
    from . import beats

    names = sorted(_models.keys())
    if _roformer is not None:
        names.append("bs_roformer_sw")
    if beats.loaded():
        names.append("beat_this")
    return names


def unload_models() -> bool:
    global _adtof_model, _roformer
    from . import beats

    with _models_lock:
        had = bool(_models) or _roformer is not None
        _models.clear()
        _roformer = None
    had = beats.unload() or had
    _adtof_model = None
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return had


# --------------------------------------------------------------------------- audio I/O


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def decode_to_stereo(path: Path, sr: int = MODEL_SR) -> np.ndarray:
    """Decodes audio (or a video's first audio stream) to float32 stereo [2, N] at `sr`."""
    if ffmpeg_available():
        cmd = [
            "ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-map", "0:a:0",
            "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(sr), "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode == 0 and proc.stdout:
            return np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
        msg = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(f"Could not decode the audio ({msg[-1] if msg else 'ffmpeg failed'}).")
    data, file_sr = sf.read(str(path), dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    data = data[:, :2].T.copy()
    if file_sr != sr:
        import librosa

        data = librosa.resample(data, orig_sr=file_sr, target_sr=sr)
    return data.astype(np.float32)


def probe(path: Path) -> Dict[str, Any]:
    info: Dict[str, Any] = {}
    if shutil.which("ffprobe"):
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=sample_rate,channels:format=duration:format_tags=title,artist,album",
             "-of", "json", str(path)],
            capture_output=True, check=False,
        )
        if proc.returncode == 0:
            import json

            j = json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
            st = (j.get("streams") or [{}])[0]
            fmt = j.get("format") or {}
            tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
            info = {
                "sampleRate": int(st.get("sample_rate") or 0) or None,
                "channels": int(st.get("channels") or 0) or None,
                "durationSec": float(fmt.get("duration") or 0) or None,
                "tags": {k: tags[k] for k in ("title", "artist", "album") if k in tags},
            }
    return info


def write_flac(path: Path, stereo: np.ndarray, sr: int = MODEL_SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.ascontiguousarray(stereo.T), sr, format="FLAC", subtype="PCM_24")


def read_stem(path: Path) -> Tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data.T.copy(), sr


def envelope_db(mono: np.ndarray, sr: int, hop_sec: float = 0.05) -> np.ndarray:
    hop = max(1, int(sr * hop_sec))
    n = len(mono) // hop
    if n == 0:
        return np.array([-120.0])
    frames = mono[: n * hop].reshape(n, hop)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-12)


def rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2) + 1e-12)))


# --------------------------------------------------------------------------- separation


class _DemucsProgress:
    """Replaces demucs.apply's tqdm so chunk-level progress reaches the UI."""

    def __init__(self, progress: Progress, lo: float, hi: float, passes: int):
        self.progress, self.lo, self.hi, self.passes = progress, lo, hi, max(1, passes)
        self.done_passes = 0

    def tqdm(self, iterable, **_kw):
        items = list(iterable)
        n = max(1, len(items))
        for i, item in enumerate(items):
            frac = (self.done_passes + i / n) / self.passes
            self.progress.set_percent(self.lo + (self.hi - self.lo) * min(1.0, frac))
            yield item
        self.done_passes += 1


def run_demucs(name: str, wav: torch.Tensor, shifts: int, progress: Progress, lo: float, hi: float) -> Dict[str, torch.Tensor]:
    import demucs.apply as dapply
    from demucs.apply import BagOfModels, apply_model

    model = demucs_model(name)
    n_models = len(model.models) if isinstance(model, BagOfModels) else 1
    tracker = _DemucsProgress(progress, lo, hi, n_models * max(1, shifts))

    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    original_tqdm = dapply.tqdm
    dapply.tqdm = types.SimpleNamespace(tqdm=tracker.tqdm)
    try:
        with torch.no_grad():
            out = apply_model(
                model, ((wav - mean) / std).unsqueeze(0).to(get_device()),
                shifts=shifts, split=True, overlap=0.25, progress=True,
            )[0]
    finally:
        dapply.tqdm = original_tqdm
    out = (out * std + mean).cpu()
    return {src: out[i] for i, src in enumerate(model.sources)}


ROFORMER_SLUG = "roformer-model-bs-roformer-sw-by-jarredou"
_roformer: Optional[Tuple[Any, Any]] = None


def roformer_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "models" / "roformer" / ROFORMER_SLUG


def roformer_available() -> bool:
    try:
        import bs_roformer  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    d = roformer_dir()
    return (d / "BS-Rofo-SW-Fixed.ckpt").is_file() and (d / "BS-Rofo-SW-Fixed.yaml").is_file()


def roformer_model():
    """BS-RoFormer-SW (6 stems: bass, drums, other, vocals, guitar, piano). Weights load tensors-only."""
    global _roformer
    with _models_lock:
        if _roformer is not None:
            return _roformer
        import yaml
        from bs_roformer.inference import SafeLoaderWithTuple
        from bs_roformer.utils import get_model_from_config
        from ml_collections import ConfigDict

        d = roformer_dir()
        with open(d / "BS-Rofo-SW-Fixed.yaml", encoding="utf-8") as fh:
            config = ConfigDict(yaml.load(fh, Loader=SafeLoaderWithTuple))
        model = get_model_from_config("bs_roformer", config)
        state = torch.load(d / "BS-Rofo-SW-Fixed.ckpt", map_location="cpu", weights_only=True)
        model.load_state_dict(state)
        model.to(get_device()).eval()
        _roformer = (model, config)
        return _roformer


def run_roformer(mix: np.ndarray, progress: Progress, lo: float, hi: float, overlap: int = 0) -> Dict[str, np.ndarray]:
    """Chunked overlap-add inference (same scheme as bs_roformer.utils.demix_track) with progress + cancel.
    The output is accumulated in system RAM so long songs don't need extra VRAM."""
    model, config = roformer_model()
    dev = get_device()
    C = int(config.inference.chunk_size)
    step = C // max(1, int(overlap or config.inference.num_overlap))
    fade = C // 10
    border = C - step
    x = torch.from_numpy(mix.astype(np.float32))
    padded = x.shape[1] > 2 * border
    if padded:
        x = torch.nn.functional.pad(x, (border, border), mode="reflect")
    window = torch.ones(C)
    window[:fade] = torch.linspace(0, 1, fade)
    window[-fade:] = torch.linspace(1, 0, fade)
    names = list(config.training.instruments)
    total = x.shape[1]
    result = torch.zeros((len(names), 2, total), dtype=torch.float32)
    counter = torch.zeros(total, dtype=torch.float32)
    n_chunks = max(1, (total + step - 1) // step)
    i = k = 0
    with torch.no_grad(), torch.autocast("cuda", enabled=dev == "cuda"):
        while i < total:
            part = x[:, i : i + C]
            length = part.shape[-1]
            if length < C:
                mode_pad = "reflect" if length > C // 2 + 1 else "constant"
                part = torch.nn.functional.pad(part, (0, C - length), mode=mode_pad)
            out = model(part.unsqueeze(0).to(dev))[0].float().cpu()
            w = window.clone()
            if i == 0:
                w[:fade] = 1
            elif i + C >= total:
                w[-fade:] = 1
            result[..., i : i + length] += out[..., :length] * w[:length]
            counter[..., i : i + length] += w[:length]
            i += step
            k += 1
            progress.set_percent(lo + (hi - lo) * min(1.0, k / n_chunks))
    est = (result / counter.clamp_min(1e-8)).numpy()
    est = np.nan_to_num(est)
    if padded:
        est = est[..., border:-border]
    return {name: est[j].astype(np.float32) for j, name in enumerate(names)}


def split_center_sides(stereo: np.ndarray) -> Tuple[np.ndarray, np.ndarray, float]:
    """
    Splits a stereo guitar stem into a center part (usually the lead guitar / solos) and the
    hard-panned sides (usually double-tracked rhythm guitars). Returns (center, sides, side_ratio).
    """
    dev = get_device() if get_device() == "cuda" else "cpu"
    x = torch.from_numpy(stereo).to(dev)
    n_fft, hop = 4096, 1024
    win = torch.hann_window(n_fft, device=dev)
    spec = torch.stft(x, n_fft, hop, window=win, return_complex=True)  # [2, F, T]
    L, R = spec[0], spec[1]
    den = L.abs() ** 2 + R.abs() ** 2 + 1e-10
    coherence = torch.clamp(2 * (L * R.conj()).real / den, 0.0, 1.0)
    mask = coherence ** 4
    C = mask * (L + R) / 2
    center = torch.istft(C, n_fft, hop, window=win, length=x.shape[1])
    center2 = torch.stack([center, center])
    sides = x - center2
    total = float((x ** 2).sum()) + 1e-12
    ratio = float((sides ** 2).sum()) / total
    return center2.cpu().numpy().astype(np.float32), sides.cpu().numpy().astype(np.float32), ratio


def separate(mix: np.ndarray, opts: ProcessOptions, progress: Progress) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
    """balanced / high: BS-RoFormer-SW when installed (much cleaner guitar and bass stems, which the
    tab transcriber depends on); otherwise, and in fast mode, Demucs."""
    if opts.quality in ("balanced", "high") and roformer_available():
        try:
            return separate_roformer(mix, opts, progress)
        except torch.cuda.OutOfMemoryError:
            raise
        except JobCancelled:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("BS-RoFormer failed, falling back to Demucs: %s", exc)
    return separate_demucs(mix, opts, progress)


def separate_demucs(mix: np.ndarray, opts: ProcessOptions, progress: Progress) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
    wav = torch.from_numpy(mix)
    info: Dict[str, Any] = {"quality": opts.quality}
    if opts.quality == "fast":
        s6 = run_demucs("htdemucs_6s", wav, 1, progress, 8, 62)
        base = s6
        info["models"] = ["htdemucs_6s"]
        info["shifts"] = 1
    elif opts.quality == "high":
        ft = run_demucs("htdemucs_ft", wav, 2, progress, 8, 48)
        s6 = run_demucs("htdemucs_6s", wav, 2, progress, 48, 64)
        base = {"vocals": ft["vocals"], "bass": ft["bass"], "drums": ft["drums"]}
        info["models"] = ["htdemucs_ft", "htdemucs_6s"]
        info["shifts"] = 2
    else:
        s6 = run_demucs("htdemucs_6s", wav, 2, progress, 8, 62)
        base = s6
        info["models"] = ["htdemucs_6s"]
        info["shifts"] = 2

    stems: Dict[str, np.ndarray] = {
        "vocals": base["vocals"].numpy(),
        "bass": base["bass"].numpy(),
        "drums": base["drums"].numpy(),
        "guitar": s6["guitar"].numpy(),
        "keyboards": (s6["piano"] if opts.keyboards_mode == "piano" else s6["piano"] + s6["other"]).numpy(),
    }

    if opts.split_guitars:
        progress.set("Splitting lead and rhythm guitars", 65)
        center, sides, ratio = split_center_sides(stems["guitar"])
        info["guitarSideRatio"] = round(ratio, 3)
        if ratio >= 0.12:
            stems["lead"] = center
            stems["guitar"] = sides
            info["guitarSplit"] = True
        else:
            info["guitarSplit"] = False
            info["guitarSplitNote"] = "Guitars are not panned wide enough to split lead from rhythm."
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return {k: v.astype(np.float32) for k, v in stems.items()}, info


def separate_roformer(mix: np.ndarray, opts: ProcessOptions, progress: Progress) -> Tuple[Dict[str, np.ndarray], Dict[str, Any]]:
    """BS-RoFormer-SW separation (much cleaner guitar stem than htdemucs_6s)."""
    overlap = 4 if opts.quality == "high" else 2
    r = run_roformer(mix, progress, 8, 62, overlap)
    stems: Dict[str, np.ndarray] = {
        "vocals": r["vocals"],
        "bass": r["bass"],
        "drums": r["drums"],
        "guitar": r["guitar"],
        "keyboards": r["piano"] if opts.keyboards_mode == "piano" else r["piano"] + r["other"],
    }
    info: Dict[str, Any] = {"quality": opts.quality, "models": ["bs_roformer_sw"], "overlap": overlap}
    if opts.split_guitars:
        progress.set("Splitting lead and rhythm guitars", 65)
        center, sides, ratio = split_center_sides(stems["guitar"])
        info["guitarSideRatio"] = round(ratio, 3)
        if ratio >= 0.12:
            stems["lead"] = center
            stems["guitar"] = sides
            info["guitarSplit"] = True
        else:
            info["guitarSplit"] = False
            info["guitarSplitNote"] = "Guitars are not panned wide enough to split lead from rhythm."
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return {k: v.astype(np.float32) for k, v in stems.items()}, info


# --------------------------------------------------------------------------- melodic transcription

_bp_lock = threading.Lock()
_bp_model = None
_bp_error: Optional[str] = None

# Frequency ranges per stem (Hz). Guitar goes down to A1 for drop / 7-string tunings.
FREQ_RANGES = {
    "guitar": (52.0, 1600.0),
    "lead": (52.0, 2000.0),
    "bass": (27.5, 500.0),
    "keyboards": (27.5, 4200.0),
    "vocals": (70.0, 1100.0),
}


def basic_pitch_model():
    global _bp_model, _bp_error
    with _bp_lock:
        if _bp_model is not None or _bp_error is not None:
            return _bp_model
        root_logger = logging.getLogger()
        previous_level = root_logger.level
        root_logger.setLevel(logging.ERROR)  # basic_pitch warns about optional TF/CoreML backends on import
        try:
            from basic_pitch import FilenameSuffix, build_icassp_2022_model_path
            from basic_pitch.inference import Model

            _bp_model = Model(build_icassp_2022_model_path(FilenameSuffix.onnx))
        except Exception as exc:  # noqa: BLE001
            _bp_error = f"{type(exc).__name__}: {exc}"
        finally:
            root_logger.setLevel(previous_level)
        return _bp_model


def basic_pitch_error() -> Optional[str]:
    return _bp_error


def transcribe_melodic(path: Path, stem: str, opts: ProcessOptions) -> List[List[float]]:
    from basic_pitch.inference import predict

    model = basic_pitch_model()
    if model is None:
        return []
    inst = "guitar" if stem == "lead" else stem
    s = opts.sensitivity.get(inst, 0.5)
    lo, hi = FREQ_RANGES[stem]
    min_ms = opts.min_note_ms if stem != "vocals" else max(opts.min_note_ms, 100.0)
    _, _, events = predict(
        str(path),
        model,
        onset_threshold=float(np.clip(0.75 - 0.5 * s, 0.15, 0.9)),
        frame_threshold=float(np.clip(0.45 - 0.3 * s, 0.08, 0.6)),
        minimum_note_length=float(min_ms),
        minimum_frequency=lo,
        maximum_frequency=hi,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    notes = []
    for start, end, pitch, amplitude, _bends in events:
        vel = int(np.clip(round(float(amplitude) * 127), 1, 127))
        notes.append([round(float(start), 4), round(float(end), 4), int(pitch), vel])
    notes.sort(key=lambda n: (n[0], n[2]))
    return notes


def gate_notes(notes: List[List[float]], env: np.ndarray, hop_sec: float, gate_db: float) -> List[List[float]]:
    """Drops notes that fall where the stem is (near) silent: bleed / separation artifacts."""
    if not notes or env.size == 0:
        return notes
    loud = float(np.percentile(env, 95))
    floor = max(gate_db - 5.0, loud - 40.0)
    kept = []
    for n in notes:
        a = int(n[0] / hop_sec)
        b = max(a + 1, int(min(n[1], n[0] + 0.3) / hop_sec))
        seg = env[a:b]
        if seg.size and float(np.mean(seg)) >= floor:
            kept.append(n)
    return kept


# --------------------------------------------------------------------------- guitar / bass (tab) transcription

STRING_STEMS = ("guitar", "lead", "bass")
# other stems whose leakage must not turn into notes on each string stem
BLEED_SOURCES = {
    "guitar": ("bass", "vocals", "lead"),
    "lead": ("guitar", "bass", "vocals"),
    "bass": ("guitar", "lead", "drums"),
}


def load_stem_22k(path: Path) -> List[np.ndarray]:
    import librosa

    from . import riff

    audio, sr = read_stem(path)
    return [librosa.resample(np.ascontiguousarray(audio[c]), orig_sr=sr, target_sr=riff.SR) for c in range(audio.shape[0])]


SIDES = ("left", "right")
GUITAR_TRACKS = ("guitar1", "guitar2")  # the left / right rhythm guitar tracks split from the guitar stem


def side_basic_pitch(stem_path: Path, stem: str, opts: ProcessOptions) -> Optional[List[List[List[float]]]]:
    """Basic Pitch notes for the left and the right channel of a stereo stem separately, each gated by
    its own channel's level (so one guitar's notes never land in the other guitar's part)."""
    if basic_pitch_model() is None:
        return None
    import tempfile

    audio, sr = read_stem(stem_path)
    if audio.shape[0] < 2:
        return None
    out: List[List[List[float]]] = []
    with tempfile.TemporaryDirectory(prefix="stemforge-sides-") as tmp:
        for ch in range(2):
            path = Path(tmp) / f"{stem}-{SIDES[ch]}.wav"
            sf.write(str(path), audio[ch], sr, subtype="FLOAT")
            notes = transcribe_melodic(path, stem, opts)
            out.append(gate_notes(notes, envelope_db(audio[ch], sr), 0.05, opts.silence_gate_db))
    return out


def transcribe_strings(
    stems_dir: Path,
    stems: List[str],
    opts: ProcessOptions,
    fallback: Dict[str, List[List[float]]],
    progress: Optional[Progress] = None,
    lo: float = 0,
    hi: float = 0,
    always_parts: Tuple[str, ...] = (),
) -> Tuple[Dict[str, List[List[float]]], Dict[str, Dict[str, float]], Dict[str, Dict[str, List[List[float]]]]]:
    """
    Periodicity-based riff transcription (stemforge_server.riff) for the guitar, lead and bass stems:
    one note per pick attack, pitch from the waveform's periodicity (robust to distortion), pitch
    changes followed inside held notes, Basic Pitch notes only where the audio is not periodic,
    and notes that are really leakage from another stem dropped.

    Returns (notes per stem, stats per stem, side parts per stem). Side parts ({"left", "right"})
    exist for a stereo guitar stem whose left and right guitars play different parts, and for the
    stems in `always_parts` (a guitar stem that was split into two tracks).
    """
    from . import riff

    audio: Dict[str, List[np.ndarray]] = {}
    needed = set(stems)
    for s in stems:
        needed.update(BLEED_SOURCES.get(s, ()))
    for name in needed:
        f = stems_dir / f"{name}.flac"
        if f.exists():
            audio[name] = load_stem_22k(f)
    out: Dict[str, List[List[float]]] = {}
    stats: Dict[str, Dict[str, float]] = {}
    parts: Dict[str, Dict[str, List[List[float]]]] = {}
    for k, s in enumerate(stems):
        if s not in audio:
            continue
        refs = [np.mean(audio[r], axis=0) for r in BLEED_SOURCES.get(s, ()) if r in audio and r != s]
        sens = opts.sensitivity.get("bass" if s == "bass" else "guitar", 0.5)
        notes, st, sides = riff.transcribe_stem(
            s,
            audio[s],
            sensitivity=sens,
            fallback_notes=fallback.get(s),
            bleed_refs=refs,
            side_fallback=lambda s=s: side_basic_pitch(stems_dir / f"{s}.flac", s, opts),
            always_parts=s in always_parts,
        )
        out[s] = notes
        stats[s] = {key: round(v, 2) for key, v in st.items()}
        if sides:
            parts[s] = sides
        if progress is not None and hi > lo:
            progress.set_percent(lo + (hi - lo) * (k + 1) / len(stems))
    return out, stats, parts


# --------------------------------------------------------------------------- drum transcription

_adtof_lock = threading.Lock()
_adtof_model = None

# ADTOF classes -> General MIDI drum notes used by StemForge
_ADTOF_TO_GM = {35: 36, 38: 38, 47: 45, 42: 42, 49: 49}


def adtof_available() -> bool:
    try:
        import adtof_pytorch  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def transcribe_drums_adtof(path: Path, sensitivity: float) -> List[List[float]]:
    global _adtof_model
    from adtof_pytorch import (
        FRAME_RNN_THRESHOLDS,
        LABELS_5,
        PeakPicker,
        calculate_n_bins,
        create_frame_rnn_model,
        get_default_weights_path,
        load_audio_for_model,
        load_pytorch_weights,
    )

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    with _adtof_lock:
        if _adtof_model is None:
            m = create_frame_rnn_model(calculate_n_bins())
            m.eval()
            m = load_pytorch_weights(m, get_default_weights_path(), strict=False)
            _adtof_model = m.to(dev)
        model = _adtof_model
    x = load_audio_for_model(str(path)).to(dev)
    with torch.no_grad():
        act = model(x).cpu().numpy()  # [1, T, 5]
    scale = float(np.clip(1.6 - 1.2 * sensitivity, 0.3, 1.8))
    thresholds = [t * scale for t in FRAME_RNN_THRESHOLDS]
    peaks = PeakPicker(thresholds=thresholds, fps=100).pick(act, labels=LABELS_5)[0]
    hits = []
    for ci, label in enumerate(LABELS_5):
        for t in peaks.get(int(label), []):
            frame = min(act.shape[1] - 1, int(round(t * 100)))
            a = float(act[0, max(0, frame - 1): frame + 2, ci].max())
            vel = int(np.clip(round(45 + 82 * a), 1, 127))
            hits.append([round(float(t), 3), _ADTOF_TO_GM[int(label)], vel])
    hits.sort(key=lambda h: (h[0], h[1]))
    return hits


def transcribe_drums_onsets(drums: np.ndarray, sr: int, sensitivity: float) -> List[List[float]]:
    """Fallback drum transcription: band-limited spectral-flux onsets for kick, snare, hats, cymbals, toms."""
    import librosa

    y = drums.mean(0) if drums.ndim == 2 else drums
    hop = int(sr * 0.01)
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    logS = np.log1p(100.0 * S)

    def band(lo, hi):
        idx = (freqs >= lo) & (freqs < hi)
        b = logS[idx]
        flux = np.maximum(0.0, np.diff(b, axis=1, prepend=b[:, :1])).sum(0)
        energy = S[idx].sum(0)
        ref = np.percentile(flux, 99.5) + 1e-9
        return flux / ref, energy

    kick, kick_e = band(30, 120)
    tom, tom_e = band(80, 350)
    snare_lo, _ = band(150, 400)
    snare_hi, _ = band(1500, 5000)
    snare = 0.4 * snare_lo + 0.6 * snare_hi
    high, high_e = band(7000, 16000)
    delta = 0.10 * float(np.clip(1.6 - 1.2 * sensitivity, 0.3, 1.8))

    def peaks(x, wait):
        return librosa.util.peak_pick(x, pre_max=3, post_max=3, pre_avg=12, post_avg=12, delta=delta, wait=wait)

    hits: List[List[float]] = []
    for i in peaks(kick, 5):
        hits.append([i * 0.01, 36, int(np.clip(50 + 77 * min(1, kick[i]), 1, 127))])
    snare_frames = peaks(snare, 5)
    for i in snare_frames:
        # toms: strong low-mid body with weak noise band
        if tom[i] > 1.4 * snare_hi[i] and tom[i] > 0.5:
            hits.append([i * 0.01, 45, int(np.clip(50 + 77 * min(1, tom[i]), 1, 127))])
        else:
            hits.append([i * 0.01, 38, int(np.clip(50 + 77 * min(1, snare[i]), 1, 127))])
    for i in peaks(high, 3):
        after = high_e[min(len(high_e) - 1, i + 15)]
        sustained = after > 0.5 * (high_e[i] + 1e-9)
        hits.append([i * 0.01, 49 if sustained else 42, int(np.clip(45 + 70 * min(1, high[i]), 1, 127))])
    hits = [[round(t, 3), m, v] for t, m, v in hits]
    hits.sort(key=lambda h: (h[0], h[1]))
    return hits


# --------------------------------------------------------------------------- tempo


def analyze_tempo(mono: np.ndarray, sr: int, opts: ProcessOptions) -> Dict[str, Any]:
    import librosa

    y = librosa.resample(mono.astype(np.float32), orig_sr=sr, target_sr=22050) if sr != 22050 else mono
    hop = 256
    oenv = librosa.onset.onset_strength(y=y, sr=22050, hop_length=hop, aggregate=np.median)
    tg = librosa.feature.tempogram(onset_envelope=oenv, sr=22050, hop_length=hop)
    freqs = librosa.tempo_frequencies(tg.shape[0], sr=22050, hop_length=hop)
    strength = tg.mean(axis=1)

    cands: List[Tuple[float, float]] = []
    for i in range(1, len(strength) - 1):
        f = freqs[i]
        if not np.isfinite(f) or f < opts.tempo_min or f > opts.tempo_max:
            continue
        if strength[i] >= strength[i - 1] and strength[i] >= strength[i + 1]:
            prior = np.exp(-0.5 * (np.log2(f / opts.tempo_prior) / 1.5) ** 2)
            cands.append((float(f), float(strength[i] * prior)))
    cands.sort(key=lambda c: -c[1])
    best = cands[0][0] if cands else opts.tempo_prior

    _, beats = librosa.beat.beat_track(onset_envelope=oenv, sr=22050, hop_length=hop, start_bpm=best, tightness=120)
    bpm = best
    offset = 0.0
    if len(beats) >= 8:
        times = librosa.frames_to_time(beats, sr=22050, hop_length=hop)
        slope, intercept = np.polyfit(np.arange(len(times)), times, 1)
        if slope > 0 and abs(60.0 / slope - best) / best < 0.08:
            bpm = 60.0 / slope
        period = 60.0 / bpm
        offset = float(intercept % period)

    distinct: List[float] = []
    for f, _s in cands:
        if all(abs(f - d) / d > 0.04 for d in distinct):
            distinct.append(f)
        if len(distinct) >= 4:
            break
    for extra in (bpm / 2, bpm * 2):
        if 40 <= extra <= 300 and all(abs(extra - d) / d > 0.04 for d in distinct):
            distinct.append(extra)
    return {
        "bpm": round(float(bpm), 2),
        "beatOffsetSec": round(offset, 4),
        "bpmCandidates": [round(float(x), 1) for x in distinct[:6]],
    }


# --------------------------------------------------------------------------- full job


def run_job(
    project_dir: Path,
    original: Path,
    opts: ProcessOptions,
    progress: Progress,
    existing_stems: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Runs the pipeline; writes stems into project_dir/stems and returns analysis results."""
    t0 = time.perf_counter()
    result: Dict[str, Any] = {}
    stems_dir = project_dir / "stems"
    stem_sr = MODEL_SR

    progress.set("Decoding audio", 2)
    mix = decode_to_stereo(original, MODEL_SR)
    duration = mix.shape[1] / MODEL_SR

    with GPU_LOCK:
        if opts.separate or not existing_stems:
            progress.set("Separating instruments on the GPU", 6)
            try:
                stems, sep_info = separate(mix, opts, progress)
            except torch.cuda.OutOfMemoryError as exc:
                unload_models()
                info = vram_info()
                raise RuntimeError(
                    "The GPU ran out of memory"
                    + (f" (only {info['vram_free_gb']} GB free)" if info["vram_free_gb"] is not None else "")
                    + ". Another program such as ComfyUI is probably holding VRAM. Free its models "
                    "(ComfyUI: Manager > Unload Models) or close it, then try again."
                ) from exc
            progress.set("Saving 24-bit FLAC stems", 70)
            peak = max(float(np.max(np.abs(s))) for s in stems.values())
            scale = 0.99 / peak if peak > 0.99 else 1.0  # one gain for all stems keeps the mix balance
            if stems_dir.exists():
                for old in stems_dir.glob("*.flac"):
                    old.unlink()
            shutil.rmtree(project_dir / "cache", ignore_errors=True)  # pitch-shifted copies of the old stems
            for name, audio in stems.items():
                write_flac(stems_dir / f"{name}.flac", audio * scale)
            stem_names = list(stems.keys())
            result["separation"] = {**sep_info, "seconds": round(time.perf_counter() - t0, 2), "gain": round(scale, 4)}
            del stems
        else:
            stem_names = list(existing_stems)
            if any(s in stem_names for s in GUITAR_TRACKS) and (stems_dir / "guitar.flac").exists():
                stem_names.append("guitar")  # the stem the two guitar tracks are split from
            result["separation"] = None

        order = ["vocals", "guitar", "lead", "bass", "drums", "keyboards"]
        stem_names = [s for s in order if s in stem_names]

        # ---- the left and right rhythm guitars as two tracks of their own
        result["guitarSides"] = None
        for name in GUITAR_TRACKS:
            (stems_dir / f"{name}.flac").unlink(missing_ok=True)
            for cached in (project_dir / "cache").glob(f"*/{name}.flac"):
                cached.unlink(missing_ok=True)
        if "guitar" in stem_names and opts.split_rhythm_guitars:
            from . import sides

            g_audio, g_sr = read_stem(stems_dir / "guitar.flac")
            if sides.should_split(g_audio):
                progress.set("Splitting the two rhythm guitars", 72)
                g1, g2, side_info = sides.split_left_right(g_audio, g_sr)
                write_flac(stems_dir / "guitar1.flac", g1, g_sr)
                write_flac(stems_dir / "guitar2.flac", g2, g_sr)
                result["guitarSides"] = side_info
            del g_audio
        # mixer tracks: the two guitar tracks replace the guitar stem they were split from
        result["stems"] = [t for s in stem_names for t in (GUITAR_TRACKS if s == "guitar" and result["guitarSides"] else (s,))]

        # ---- melodic transcription (Basic Pitch, CPU/ONNX) with silence gating
        t1 = time.perf_counter()
        progress.set("Transcribing notes (Basic Pitch)", 74)
        melodic = [s for s in ("guitar", "lead", "bass", "keyboards", "vocals") if s in stem_names and opts.transcribe.get(s, True)]
        notes: Dict[str, List[List[float]]] = {}
        stem_levels: Dict[str, float] = {}
        silent: List[str] = []
        envs: Dict[str, np.ndarray] = {}
        for s in stem_names:
            audio, stem_sr = read_stem(stems_dir / f"{s}.flac")
            mono = audio.mean(0)
            stem_levels[s] = round(rms_db(mono), 1)
            envs[s] = envelope_db(mono, stem_sr)
        to_run = []
        for s in melodic:
            if stem_levels[s] < opts.silence_gate_db:
                silent.append(s)
                notes[s] = []
            else:
                to_run.append(s)
        if to_run and basic_pitch_model() is not None:
            done = 0
            with ThreadPoolExecutor(max_workers=min(4, len(to_run))) as pool:
                futs = {s: pool.submit(transcribe_melodic, stems_dir / f"{s}.flac", s, opts) for s in to_run}
                for s, fut in futs.items():
                    raw = fut.result()
                    notes[s] = gate_notes(raw, envs[s], 0.05, opts.silence_gate_db)
                    done += 1
                    progress.set_percent(74 + 8 * done / len(to_run))

        # ---- guitar / lead / bass: riff transcriber (Basic Pitch only as the fallback for chords)
        string_stats: Dict[str, Dict[str, float]] = {}
        guitar_parts: Optional[Dict[str, List[List[float]]]] = None
        strings = [s for s in to_run if s in STRING_STEMS]
        if strings:
            progress.set("Transcribing guitar and bass riffs", 82)
            try:
                riffs, string_stats, string_parts = transcribe_strings(
                    stems_dir, strings, opts, notes, progress, 82, 88, always_parts=("guitar",) if result["guitarSides"] else ()
                )
                for s, ns in riffs.items():
                    notes[s] = gate_notes(ns, envs[s], 0.05, opts.silence_gate_db)
                if "guitar" in string_parts:
                    # left / right guitars as their own parts: notes the split gives to the other
                    # guitar (its leakage into this side) are dropped, then each is gated by its side
                    from . import sides

                    g_audio, g_sr = read_stem(stems_dir / "guitar.flac")
                    owner = sides.Ownership(g_audio, g_sr) if g_audio.shape[0] >= 2 else None
                    guitar_parts = {}
                    for ch, side in enumerate(SIDES):
                        part = string_parts["guitar"][side]
                        if owner is not None:
                            part, dropped = owner.filter(part, ch)
                            string_stats.setdefault("guitar", {})["otherGuitarDropped"] = string_stats.get("guitar", {}).get("otherGuitarDropped", 0) + dropped
                        guitar_parts[side] = gate_notes(part, envelope_db(g_audio[min(ch, g_audio.shape[0] - 1)], g_sr), 0.05, opts.silence_gate_db)
                    del owner, g_audio
            except JobCancelled:
                raise
            except Exception as exc:  # noqa: BLE001
                log.exception("Riff transcription failed, keeping Basic Pitch notes: %s", exc)

        # ---- drums
        drums: List[List[float]] = []
        drum_engine = None
        if "drums" in stem_names and opts.transcribe.get("drums", True):
            if stem_levels.get("drums", -120) < opts.silence_gate_db:
                silent.append("drums")
            else:
                progress.set("Transcribing drums", 89)
                if adtof_available():
                    try:
                        drums = transcribe_drums_adtof(stems_dir / "drums.flac", opts.sensitivity.get("drums", 0.5))
                        drum_engine = "adtof"
                    except Exception as exc:  # noqa: BLE001
                        log.warning("ADTOF failed, using onset detector: %s", exc)
                if drum_engine is None:
                    audio, dsr = read_stem(stems_dir / "drums.flac")
                    drums = transcribe_drums_onsets(audio, dsr, opts.sensitivity.get("drums", 0.5))
                    drum_engine = "onsets"
                drums = [h for h in drums if envs["drums"][min(len(envs["drums"]) - 1, int(h[0] / 0.05))] >= opts.silence_gate_db - 10]

        # ---- tempo & beat grid (from the full mix): Beat This! tempo map, librosa as the fallback
        progress.set("Detecting beats, bars and tempo", 95)
        tempo = analyze_tempo(mix.mean(0), MODEL_SR, opts)
        tempo["tempoEngine"] = "librosa"
        from . import beats as beat_tracker

        if beat_tracker.available():
            try:
                bt, db = beat_tracker.track(mix.mean(0), MODEL_SR)
                tm = beat_tracker.tempo_map(bt, db, duration, opts.tempo_min, opts.tempo_max)
                if tm:
                    tempo = {**tempo, **tm, "tempoEngine": "beat_this"}
            except Exception as exc:  # noqa: BLE001
                log.warning("Beat tracking failed, using the fixed tempo grid: %s", exc)

    result["transcription"] = {
        "engine": "basic-pitch" if basic_pitch_model() is not None else None,
        "stringEngine": "riff" if string_stats else ("basic-pitch" if basic_pitch_model() is not None else None),
        "stringStats": string_stats,
        "drumEngine": drum_engine,
        "notes": notes,
        **({"guitarParts": guitar_parts} if guitar_parts else {}),
        "drums": drums,
        "silentStems": silent,
        "stemLevelsDb": stem_levels,
        "seconds": round(time.perf_counter() - t1, 2),
        "options": opts.to_dict(),
    }
    result["analysis"] = {"timeSignature": [4, 4], **tempo}
    result["durationSec"] = round(duration, 3)
    result["sampleRate"] = stem_sr
    if opts.free_vram_after:
        unload_models()
    elif torch.cuda.is_available():
        torch.cuda.empty_cache()
    return result
