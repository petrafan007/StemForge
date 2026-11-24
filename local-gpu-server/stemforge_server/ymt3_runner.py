"""
YourMT3+ (Chang et al., 2024; Apache-2.0) multi-instrument transcription, run in its own process:

    python -m stemforge_server.ymt3_runner <audio> <notes.json> [<audio> <notes.json> ...] [--device cuda|cpu]

writes [[onset_s, offset_s, midi, velocity, program, is_drum], ...] per audio file (the model loads
once for all of them). A separate process keeps the
model's top-level packages ("model", "utils", "config") from clashing with StemForge's own modules
and frees its GPU memory when it exits.

The model code is the official YourMT3 Space (pinned revision, downloaded by setup_windows.ps1 into
models/yourmt3/space); the checkpoint is "YPTF.MoE+Multi (noPS)". The checkpoint is loaded
tensors-only (weights_only=True); the only non-tensor objects it holds are YourMT3's own tokenizer
/ task-manager data classes, which are explicitly allow-listed.
"""

from __future__ import annotations

import argparse
import json
import sys
import types
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "models" / "yourmt3"
SRC = ROOT / "space" / "amt" / "src"
CHECKPOINT = ROOT / "checkpoints" / "mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops" / "last.ckpt"

# "YPTF.MoE+Multi (noPS)" settings, as in the official Space's app.py
MODEL_ARGS = dict(
    task="mc13_full_plus_256",
    decoder_type="multi-t5",
    num_latents=26,
    encoder_type="perceiver-tf",
    sca_use_query_residual=True,
    ff_layer_type="moe",
    ff_widening_factor=4,
    moe_num_experts=8,
    moe_topk=2,
    hidden_act="silu",
    encoder_position_encoding_type="rope",
    rope_partial_pe=True,
    audio_codec="spec",
    hop_length=300,
    attention_to_channel=True,
)


class _NoOp:
    """Stands in for any object of a training-only library: accepts and ignores everything."""

    def __init__(self, *a, **k):
        pass

    def __call__(self, *a, **k):
        return _NoOp()

    def __getattr__(self, name):
        return _NoOp()


def _no_op_module(name: str) -> types.ModuleType:
    mod = types.ModuleType(name)

    def attr(a: str):
        if a.startswith("__"):
            raise AttributeError(a)
        return _NoOp

    mod.__getattr__ = attr  # type: ignore[attr-defined]
    return mod


def available() -> bool:
    return (SRC / "model" / "ymt3.py").is_file() and CHECKPOINT.is_file()


def _args() -> argparse.Namespace:
    """The argument namespace the Space builds with argparse (defaults + the model's settings)."""
    a = dict(
        exp_id="", project="ymt3", audio_codec=None, hop_length=None, n_mels=None, input_frames=None,
        sca_use_query_residual=None, encoder_type=None, decoder_type=None, pre_encoder_type="default",
        pre_decoder_type="default", conv_out_channels=None, task_cond_encoder=True, task_cond_decoder=True,
        d_feat=None, pretrained=False, base_name="google/t5-v1_1-small", encoder_position_encoding_type="default",
        decoder_position_encoding_type="default", tie_word_embedding=None, event_length=None, d_latent=None,
        num_latents=None, perceiver_tf_d_model=None, num_perceiver_tf_blocks=None,
        num_perceiver_tf_local_transformers_per_block=None, num_perceiver_tf_temporal_transformers_per_block=None,
        attention_to_channel=None, layer_norm_type=None, ff_layer_type=None, ff_widening_factor=None,
        moe_num_experts=None, moe_topk=None, hidden_act=None, rotary_type=None, rope_apply_to_keys=None,
        rope_partial_pe=None, decoder_ff_layer_type=None, decoder_ff_widening_factor=None, task="mt3_full_plus",
        eval_program_vocab=None, eval_drum_vocab=None, eval_subtask_key="default", onset_tolerance=0.05,
        test_octave_shift=False, write_model_output=False, precision="16", strategy="auto", num_nodes=1,
        num_gpus="auto", wandb_mode="disabled", debug_mode=False, test_pitch_shift=None, epochs=None,
        # training-only options the config code may look up
        pitch_shift_range=None, random_amp_range=None, stem_iaug_prob=None, uhat_intra_stem_augment=None,
        xaug_alpha=None, xaug_max_k=None, xaug_no_drum_overlap=None, xaug_no_instr_overlap=None, xaug_tau=None,
    )
    a.update(MODEL_ARGS)
    return argparse.Namespace(**a)


def load_model(device: str):
    import numpy as np
    import torch

    sys.path.insert(0, str(SRC))
    sys.modules.setdefault("wandb", _no_op_module("wandb"))  # training logger, never used here
    from config.config import shared_cfg as default_shared_cfg
    from model.init_train import update_config
    from model.ymt3 import YourMT3
    from utils.event_codec import FastCodec
    from utils.note_event_dataclasses import Event, EventRange
    from utils.task_manager import TaskManager
    from utils.tokenizer import NoteEventTokenizer

    args = _args()
    shared_cfg, audio_cfg, model_cfg = update_config(args, deepcopy(default_shared_cfg), stage="test")
    tm = TaskManager(task_name=args.task, max_shift_steps=int(shared_cfg["TOKENIZER"]["max_shift_steps"]), debug_mode=False)
    model = YourMT3(audio_cfg=audio_cfg, model_cfg=model_cfg, shared_cfg=shared_cfg, optimizer=None, task_manager=tm, eval_subtask_key="default", write_output_dir=None)
    import _codecs

    allowed = [
        TaskManager, NoteEventTokenizer, FastCodec, Event, EventRange,
        (np.core.multiarray._reconstruct, "numpy.core.multiarray._reconstruct"),
        (np.core.multiarray.scalar, "numpy.core.multiarray.scalar"),
        np.ndarray, np.dtype, _codecs.encode,
    ] + [type(np.dtype(t)) for t in ("float32", "float64", "int64", "int32", "bool")]
    with torch.serialization.safe_globals(allowed):
        ck = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
    state = {k: v for k, v in ck["state_dict"].items() if "pitchshift" not in k}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if unexpected or [k for k in missing if "pitchshift" not in k]:
        print(f"warning: {len(missing)} missing / {len(unexpected)} unexpected weights", file=sys.stderr)
    return model.to(device).eval()


def transcribe(model, path: str, device: str, bsz: int = 32):
    import torch
    import torchaudio

    from utils.audio import slice_padded_array
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    from utils.note2event import mix_notes

    audio, sr = torchaudio.load(path)
    audio = torch.mean(audio, dim=0).unsqueeze(0)
    audio = torchaudio.functional.resample(audio, sr, model.audio_cfg["sample_rate"])
    frames = model.audio_cfg["input_frames"]
    segs = slice_padded_array(audio, frames, frames)
    segs = torch.from_numpy(segs.astype("float32")).to(device).unsqueeze(1)
    with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16, enabled=device == "cuda"):
        pred, _ = model.inference_file(bsz=bsz, audio_segments=segs)
    starts = [frames * i / model.audio_cfg["sample_rate"] for i in range(segs.shape[0])]
    per_channel = []
    for ch in range(model.task_manager.num_decoding_channels):
        zipped, _, _ = model.task_manager.detokenize_list_batches([arr[:, ch, :] for arr in pred], starts, return_events=True)
        notes, _ = merge_zipped_note_events_and_ties_to_notes(zipped)
        per_channel.append(notes)
    return mix_notes(per_channel)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="audio file, output JSON, [audio file, output JSON, ...]")
    ap.add_argument("--device", default=None)
    ap.add_argument("--bsz", type=int, default=32)
    a = ap.parse_args()
    if len(a.files) % 2:
        ap.error("give pairs of <audio> <notes.json>")
    import time

    import torch

    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.perf_counter()
    model = load_model(device)
    print(f"model loaded in {time.perf_counter() - t0:.1f}s", flush=True)
    for audio, out in zip(a.files[0::2], a.files[1::2]):
        t1 = time.perf_counter()
        notes = transcribe(model, audio, device, a.bsz)
        rows = [[round(float(n.onset), 4), round(float(n.offset), 4), int(n.pitch), int(n.velocity), int(n.program), bool(n.is_drum)] for n in notes]
        Path(out).write_text(json.dumps(rows), encoding="utf-8")
        print(f"{Path(audio).name}: {len(rows)} notes in {time.perf_counter() - t1:.1f}s", flush=True)


if __name__ == "__main__":
    main()
