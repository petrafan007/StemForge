"""
Mel-Band RoFormer, inference only: the architecture of the becruily guitar separation model.

Adapted from Music-Source-Separation-Training by Roman Solovyev (ZFTurbo),
models/bs_roformer/mel_band_roformer.py, itself based on Phil Wang (lucidrains)'s BS-RoFormer:

    MIT License - Copyright (c) 2024 Roman Solovyev (ZFTurbo); Copyright (c) 2023 Phil Wang
    Permission is hereby granted, free of charge, to any person obtaining a copy of this software
    and associated documentation files (the "Software"), to deal in the Software without
    restriction, including without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
    Software is furnished to do so, subject to the following conditions: The above copyright
    notice and this permission notice shall be included in all copies or substantial portions of
    the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

Kept: the modules and parameter names the checkpoints were saved with. Removed: training losses,
gradient checkpointing, linear attention and PoPE (unused by the models StemForge loads).
"""

from __future__ import annotations

from functools import partial
from typing import Callable, Optional, Tuple

import torch
import torch.nn.functional as F
from bs_roformer.attend import Attend  # from the bs-roformer-infer package
from einops import pack, rearrange, reduce, repeat, unpack
from rotary_embedding_torch import RotaryEmbedding
from torch import nn
from torch.nn import Module, ModuleList


def _pack_one(t, pattern):
    return pack([t], pattern)


def _unpack_one(t, ps, pattern):
    return unpack(t, ps, pattern)[0]


class RMSNorm(Module):
    def __init__(self, dim):
        super().__init__()
        self.scale = dim**0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return F.normalize(x, dim=-1) * self.scale * self.gamma


class FeedForward(Module):
    def __init__(self, dim, mult=4, dropout=0.0):
        super().__init__()
        dim_inner = int(dim * mult)
        self.net = nn.Sequential(RMSNorm(dim), nn.Linear(dim, dim_inner), nn.GELU(), nn.Dropout(dropout), nn.Linear(dim_inner, dim), nn.Dropout(dropout))

    def forward(self, x):
        return self.net(x)


class Attention(Module):
    def __init__(self, dim, heads=8, dim_head=64, dropout=0.0, rotary_embed=None, flash=True):
        super().__init__()
        self.heads = heads
        self.scale = dim_head**-0.5
        dim_inner = heads * dim_head
        self.rotary_embed = rotary_embed
        self.attend = Attend(flash=flash, dropout=dropout)
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, dim_inner * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads)
        self.to_out = nn.Sequential(nn.Linear(dim_inner, dim, bias=False), nn.Dropout(dropout))

    def forward(self, x):
        x = self.norm(x)
        q, k, v = rearrange(self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads)
        if self.rotary_embed is not None:
            q = self.rotary_embed.rotate_queries_or_keys(q)
            k = self.rotary_embed.rotate_queries_or_keys(k)
        out = self.attend(q, k, v)
        gates = self.to_gates(x)
        out = out * rearrange(gates, "b n h -> b h n 1").sigmoid()
        out = rearrange(out, "b h n d -> b n (h d)")
        return self.to_out(out)


class Transformer(Module):
    def __init__(self, *, dim, depth, dim_head=64, heads=8, attn_dropout=0.0, ff_dropout=0.0, ff_mult=4, norm_output=True, rotary_embed=None, flash_attn=True):
        super().__init__()
        self.layers = ModuleList([])
        for _ in range(depth):
            attn = Attention(dim=dim, dim_head=dim_head, heads=heads, dropout=attn_dropout, rotary_embed=rotary_embed, flash=flash_attn)
            self.layers.append(ModuleList([attn, FeedForward(dim=dim, mult=ff_mult, dropout=ff_dropout)]))
        self.norm = RMSNorm(dim) if norm_output else nn.Identity()

    def forward(self, x):
        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x
        return self.norm(x)


class BandSplit(Module):
    def __init__(self, dim, dim_inputs: Tuple[int, ...]):
        super().__init__()
        self.dim_inputs = dim_inputs
        self.to_features = ModuleList([nn.Sequential(RMSNorm(dim_in), nn.Linear(dim_in, dim)) for dim_in in dim_inputs])

    def forward(self, x):
        x = x.split(self.dim_inputs, dim=-1)
        return torch.stack([to_feature(part) for part, to_feature in zip(x, self.to_features)], dim=-2)


def MLP(dim_in, dim_out, dim_hidden=None, depth=1, activation=nn.Tanh):
    dim_hidden = dim_in if dim_hidden is None else dim_hidden
    net = []
    dims = (dim_in, *((dim_hidden,) * depth), dim_out)
    for ind, (layer_dim_in, layer_dim_out) in enumerate(zip(dims[:-1], dims[1:])):
        net.append(nn.Linear(layer_dim_in, layer_dim_out))
        if ind != len(dims) - 2:
            net.append(activation())
    return nn.Sequential(*net)


class MaskEstimator(Module):
    def __init__(self, dim, dim_inputs: Tuple[int, ...], depth, mlp_expansion_factor=4):
        super().__init__()
        self.dim_inputs = dim_inputs
        dim_hidden = dim * mlp_expansion_factor
        self.to_freqs = ModuleList([nn.Sequential(MLP(dim, dim_in * 2, dim_hidden=dim_hidden, depth=depth), nn.GLU(dim=-1)) for dim_in in dim_inputs])

    def forward(self, x):
        return torch.cat([mlp(band) for band, mlp in zip(x.unbind(dim=-2), self.to_freqs)], dim=-1)


class MelBandRoformer(Module):
    def __init__(
        self,
        dim,
        *,
        depth,
        stereo=False,
        num_stems=1,
        time_transformer_depth=2,
        freq_transformer_depth=2,
        linear_transformer_depth=0,
        num_bands=60,
        dim_head=64,
        heads=8,
        attn_dropout=0.1,
        ff_dropout=0.1,
        flash_attn=True,
        dim_freqs_in=1025,
        sample_rate=44100,
        stft_n_fft=2048,
        stft_hop_length=512,
        stft_win_length=2048,
        stft_normalized=False,
        stft_window_fn: Optional[Callable] = None,
        zero_dc=True,
        mask_estimator_depth=1,
        mlp_expansion_factor=4,
        skip_connection=False,
        **_training_only,
    ):
        super().__init__()
        from librosa import filters

        if linear_transformer_depth:
            raise NotImplementedError("linear attention layers are not supported")
        self.stereo = stereo
        self.audio_channels = 2 if stereo else 1
        self.num_stems = num_stems
        self.skip_connection = skip_connection
        self.layers = ModuleList([])
        transformer_kwargs = dict(dim=dim, heads=heads, dim_head=dim_head, attn_dropout=attn_dropout, ff_dropout=ff_dropout, flash_attn=flash_attn)
        time_rotary_embed = RotaryEmbedding(dim=dim_head)
        freq_rotary_embed = RotaryEmbedding(dim=dim_head)
        for _ in range(depth):
            self.layers.append(
                nn.ModuleList(
                    [
                        Transformer(depth=time_transformer_depth, rotary_embed=time_rotary_embed, **transformer_kwargs),
                        Transformer(depth=freq_transformer_depth, rotary_embed=freq_rotary_embed, **transformer_kwargs),
                    ]
                )
            )
        self.stft_window_fn = partial(stft_window_fn or torch.hann_window, stft_win_length)
        self.stft_kwargs = dict(n_fft=stft_n_fft, hop_length=stft_hop_length, win_length=stft_win_length, normalized=stft_normalized)
        freqs = torch.stft(torch.randn(1, 4096), **self.stft_kwargs, window=torch.ones(stft_n_fft), return_complex=True).shape[1]

        # mel filter bank (librosa), binary per band; masks are averaged where bands overlap
        mel_filter_bank = torch.from_numpy(filters.mel(sr=sample_rate, n_fft=stft_n_fft, n_mels=num_bands))
        mel_filter_bank[0][0] = 1.0
        mel_filter_bank[-1, -1] = 1.0
        freqs_per_band = mel_filter_bank > 0
        assert freqs_per_band.any(dim=0).all(), "all frequencies need to be covered by the bands"
        freq_indices = repeat(torch.arange(freqs), "f -> b f", b=num_bands)[freqs_per_band]
        if stereo:
            freq_indices = repeat(freq_indices, "f -> f s", s=2)
            freq_indices = freq_indices * 2 + torch.arange(2)
            freq_indices = rearrange(freq_indices, "f s -> (f s)")
        self.register_buffer("freq_indices", freq_indices, persistent=False)
        self.register_buffer("freqs_per_band", freqs_per_band, persistent=False)
        num_freqs_per_band = reduce(freqs_per_band, "b f -> b", "sum")
        num_bands_per_freq = reduce(freqs_per_band, "b f -> f", "sum")
        self.register_buffer("num_freqs_per_band", num_freqs_per_band, persistent=False)
        self.register_buffer("num_bands_per_freq", num_bands_per_freq, persistent=False)

        freqs_per_bands_with_complex = tuple(2 * f * self.audio_channels for f in num_freqs_per_band.tolist())
        self.band_split = BandSplit(dim=dim, dim_inputs=freqs_per_bands_with_complex)
        self.mask_estimators = nn.ModuleList(
            [MaskEstimator(dim=dim, dim_inputs=freqs_per_bands_with_complex, depth=mask_estimator_depth, mlp_expansion_factor=mlp_expansion_factor) for _ in range(num_stems)]
        )
        self.zero_dc = zero_dc

    def forward(self, raw_audio):
        """raw_audio [b, channels, t] -> [b, stems, channels, t] (stems dimension dropped for one stem)."""
        device = raw_audio.device
        if raw_audio.ndim == 2:
            raw_audio = rearrange(raw_audio, "b t -> b 1 t")
        batch, channels, _ = raw_audio.shape
        raw_audio, packed_shape = _pack_one(raw_audio, "* t")
        stft_window = self.stft_window_fn(device=device)
        stft_repr = torch.view_as_real(torch.stft(raw_audio, **self.stft_kwargs, window=stft_window, return_complex=True))
        stft_repr = _unpack_one(stft_repr, packed_shape, "* f t c")
        stft_repr = rearrange(stft_repr, "b s f t c -> b (f s) t c")
        batch_arange = torch.arange(batch, device=device)[..., None]
        x = stft_repr[batch_arange, self.freq_indices]
        x = rearrange(x, "b f t c -> b t (f c)")
        x = self.band_split(x)

        store = [None] * len(self.layers)
        for i, (time_transformer, freq_transformer) in enumerate(self.layers):
            if self.skip_connection:
                for j in range(i):
                    x = x + store[j]
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = time_transformer(x)
            (x,) = unpack(x, ps, "* t d")
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = freq_transformer(x)
            (x,) = unpack(x, ps, "* f d")
            if self.skip_connection:
                store[i] = x

        num_stems = len(self.mask_estimators)
        masks = torch.stack([fn(x) for fn in self.mask_estimators], dim=1)
        masks = rearrange(masks, "b n t (f c) -> b n f t c", c=2)
        stft_repr = torch.view_as_complex(rearrange(stft_repr, "b f t c -> b 1 f t c"))
        masks = torch.view_as_complex(masks).type(stft_repr.dtype)
        scatter_indices = repeat(self.freq_indices, "f -> b n f t", b=batch, n=num_stems, t=stft_repr.shape[-1])
        stft_repr_expanded = repeat(stft_repr, "b 1 ... -> b n ...", n=num_stems)
        masks_summed = torch.zeros_like(stft_repr_expanded).scatter_add_(2, scatter_indices, masks)
        denom = repeat(self.num_bands_per_freq, "f -> (f r) 1", r=channels)
        stft_repr = stft_repr * (masks_summed / denom.clamp(min=1e-8))
        stft_repr = rearrange(stft_repr, "b n (f s) t -> (b n s) f t", s=self.audio_channels)
        if self.zero_dc:
            stft_repr[:, 0] = 0.0
        recon = torch.istft(stft_repr, **self.stft_kwargs, window=stft_window, return_complex=False)
        recon = rearrange(recon, "(b n s) t -> b n s t", b=batch, s=self.audio_channels, n=num_stems)
        if num_stems == 1:
            recon = rearrange(recon, "b 1 s t -> b s t")
        return recon
