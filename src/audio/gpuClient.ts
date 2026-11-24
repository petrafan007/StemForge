import type { StemId } from '../types/music';

export type SeparationEngineMode = 'browser' | 'gpu';

export interface GpuServerConfig {
  mode: SeparationEngineMode;
  serverUrl: string;
  pianoOnly: boolean;
}

export interface GpuHealthStatus {
  ok: boolean;
  model: string;
  device: string;
  cuda: boolean;
  gpu: string;
  vramGb?: number;
  modelLoaded?: boolean;
}

export interface GpuSeparateResponse {
  job_id: string;
  model: string;
  device: string;
  gpu: string;
  sample_rate: number;
  elapsed_sec: number;
  stems: Record<StemId, string>;
}

export const DEFAULT_GPU_SERVER_URL = 'http://127.0.0.1:8000';

const STORAGE_KEY = 'stemforge_gpu_config_v1';

/**
 * Normalizes and validates a user-supplied local GPU server URL.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_GPU_SERVER_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function resolveStemUrl(baseUrl: string, stemPath: string): string {
  if (/^https?:\/\//i.test(stemPath)) return stemPath;
  const cleanBase = normalizeServerUrl(baseUrl);
  const cleanPath = stemPath.startsWith('/') ? stemPath : `/${stemPath}`;
  return `${cleanBase}${cleanPath}`;
}

export function loadSavedGpuConfig(): GpuServerConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { mode: 'browser', serverUrl: DEFAULT_GPU_SERVER_URL, pianoOnly: false };
    }
    const parsed = JSON.parse(raw) as Partial<GpuServerConfig>;
    return {
      mode: parsed.mode === 'gpu' ? 'gpu' : 'browser',
      serverUrl: normalizeServerUrl(parsed.serverUrl || DEFAULT_GPU_SERVER_URL),
      pianoOnly: Boolean(parsed.pianoOnly),
    };
  } catch {
    return { mode: 'browser', serverUrl: DEFAULT_GPU_SERVER_URL, pianoOnly: false };
  }
}

export function saveGpuConfig(config: GpuServerConfig): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode: config.mode,
        serverUrl: normalizeServerUrl(config.serverUrl),
        pianoOnly: config.pianoOnly,
      })
    );
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
}

export async function checkGpuServerHealth(
  serverUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<GpuHealthStatus> {
  const base = normalizeServerUrl(serverUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetchImpl(`${base}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GPU server returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      ok?: boolean;
      model?: string;
      device?: string;
      cuda?: boolean;
      gpu?: string;
      vram_gb?: number;
      model_loaded?: boolean;
    };
    if (!data.ok) {
      throw new Error('GPU server responded without ok=true');
    }
    return {
      ok: true,
      model: data.model || 'htdemucs_6s',
      device: data.device || (data.cuda ? 'cuda' : 'cpu'),
      cuda: Boolean(data.cuda),
      gpu: data.gpu || 'Local GPU',
      vramGb: typeof data.vram_gb === 'number' ? data.vram_gb : undefined,
      modelLoaded: Boolean(data.model_loaded),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(
        `Connection to ${base} timed out. Start gpu_server.py with uvicorn on port 8000 first.`
      );
    }
    throw new Error(
      `Could not reach local GPU server at ${base}. Make sure uvicorn gpu_server:app --host 127.0.0.1 --port 8000 is running on your PC.`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export interface GpuStemDownloadResult {
  meta: GpuSeparateResponse;
  wavBytes: Record<StemId, ArrayBuffer>;
}

/**
 * Uploads an audio file to the user's local Demucs RTX server and downloads all 5 separated WAV stems.
 */
export async function separateViaGpuServer(
  file: File,
  serverUrl: string,
  pianoOnly: boolean,
  onStage?: (stage: string, percent: number) => void,
  fetchImpl: typeof fetch = fetch
): Promise<GpuStemDownloadResult> {
  const base = normalizeServerUrl(serverUrl);
  const form = new FormData();
  form.append('file', file, file.name);

  onStage?.('Uploading audio & running htdemucs_6s neural model on your GPU', 20);

  let res: Response;
  try {
    const query = pianoOnly ? '?piano_only=true' : '?piano_only=false';
    res = await fetchImpl(`${base}/separate${query}`, {
      method: 'POST',
      body: form,
    });
  } catch {
    throw new Error(
      `Could not connect to your local GPU server at ${base}. Start it with "uvicorn gpu_server:app --host 127.0.0.1 --port 8000" or switch to Browser STFT.`
    );
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      // ignore non-json error body
    }
    throw new Error(`Local GPU server error: ${detail}`);
  }

  const meta = (await res.json()) as GpuSeparateResponse;
  if (!meta.stems || !meta.stems.vocals || !meta.stems.guitar || !meta.stems.bass || !meta.stems.drums || !meta.stems.keyboards) {
    throw new Error('Local GPU server returned an incomplete stem manifest.');
  }

  onStage?.(`Downloading 5 neural WAV stems from ${meta.gpu} (${meta.elapsed_sec}s)`, 68);

  const stemIds: StemId[] = ['vocals', 'guitar', 'bass', 'drums', 'keyboards'];
  const entries = await Promise.all(
    stemIds.map(async (id) => {
      const url = resolveStemUrl(base, meta.stems[id]);
      const stemRes = await fetchImpl(url);
      if (!stemRes.ok) {
        throw new Error(`Failed to download ${id} stem (${stemRes.status})`);
      }
      const buf = await stemRes.arrayBuffer();
      return [id, buf] as const;
    })
  );

  // Best-effort cleanup of temp WAVs on the local Python server
  if (meta.job_id) {
    void fetchImpl(`${base}/stems/${meta.job_id}`, { method: 'DELETE' }).catch(() => {});
  }

  const wavBytes = Object.fromEntries(entries) as Record<StemId, ArrayBuffer>;
  return { meta, wavBytes };
}

export const GPU_REQUIREMENTS_CONTENT = `# 1. Install PyTorch with CUDA 12.4 for NVIDIA RTX 4070:
#    pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
#
# 2. Then install these server & Demucs packages:
demucs>=4.0.1
fastapi>=0.115.0
uvicorn[standard]>=0.32.0
python-multipart>=0.0.12
soundfile>=0.12.1
numpy>=1.26.0
`;

export const GPU_SERVER_PY_CONTENT = `"""
StemForge Local GPU Stem Separation Server (NVIDIA CUDA + Meta htdemucs_6s)
Run: uvicorn gpu_server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

MODEL_NAME = "htdemucs_6s"
JOB_ROOT = Path(tempfile.gettempdir()) / "stemforge_gpu_jobs"
JOB_ROOT.mkdir(parents=True, exist_ok=True)
JOB_TTL_SECONDS = 60 * 30

app = FastAPI(title="StemForge Local GPU Server", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_private_network_header(request: Request, call_next):
    if request.method == "OPTIONS":
        resp = Response(status_code=204)
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


_model_lock = threading.Lock()
_cached_model = None
_cached_device: Optional[str] = None
_jobs: Dict[str, float] = {}


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


def cleanup_expired_jobs() -> None:
    now = time.time()
    expired = [jid for jid, ts in list(_jobs.items()) if now - ts > JOB_TTL_SECONDS]
    for jid in expired:
        _jobs.pop(jid, None)
        shutil.rmtree(JOB_ROOT / jid, ignore_errors=True)


def load_demucs_model():
    global _cached_model, _cached_device
    with _model_lock:
        if _cached_model is not None:
            return _cached_model, _cached_device
        from demucs.pretrained import get_model

        device = get_device()
        model = get_model(MODEL_NAME)
        model.to(device)
        model.eval()
        _cached_model = model
        _cached_device = device
        return _cached_model, _cached_device


def decode_audio_to_stereo_tensor(input_path: Path, target_sr: int) -> torch.Tensor:
    if shutil.which("ffmpeg"):
        cmd = [
            "ffmpeg", "-v", "error", "-i", str(input_path),
            "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "2", "-ar", str(target_sr), "pipe:1",
        ]
        proc = subprocess.run(cmd, capture_output=True, check=False)
        if proc.returncode == 0 and len(proc.stdout) > 0:
            audio = np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
            return torch.from_numpy(audio)

    data, sr = sf.read(str(input_path), dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    tensor = torch.from_numpy(data.T.copy())
    if sr != target_sr:
        import torchaudio
        tensor = torchaudio.functional.resample(tensor, sr, target_sr)
    return tensor


def save_wav_16bit(path: Path, tensor_2xN: torch.Tensor, sample_rate: int) -> None:
    arr = tensor_2xN.detach().cpu().numpy().T
    peak = float(np.max(np.abs(arr))) if arr.size > 0 else 0.0
    if peak > 0.98:
        arr = arr * (0.96 / peak)
    sf.write(str(path), arr, sample_rate, subtype="PCM_16")


@app.get("/health")
def health():
    cleanup_expired_jobs()
    vram_gb = None
    if torch.cuda.is_available():
        props = torch.cuda.get_device_properties(0)
        vram_gb = round(props.total_memory / (1024**3), 1)
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": get_device(),
        "cuda": torch.cuda.is_available(),
        "gpu": get_gpu_name(),
        "vram_gb": vram_gb,
        "model_loaded": _cached_model is not None,
    }


@app.post("/separate")
async def separate(file: UploadFile = File(...), piano_only: bool = Query(default=False)):
    cleanup_expired_jobs()
    t0 = time.perf_counter()
    job_id = uuid.uuid4().hex[:12]
    job_dir = JOB_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    _jobs[job_id] = time.time()

    suffix = Path(file.filename or "track.wav").suffix or ".wav"
    in_path = job_dir / f"input{suffix}"

    try:
        raw_bytes = await file.read()
        if not raw_bytes:
            raise HTTPException(status_code=400, detail="Empty audio file received.")
        in_path.write_bytes(raw_bytes)

        model, device = load_demucs_model()
        target_sr = int(model.samplerate)
        wav = decode_audio_to_stereo_tensor(in_path, target_sr)

        ref = wav.mean(0)
        wav_mean = ref.mean()
        wav_std = ref.std() + 1e-8
        wav_norm = (wav - wav_mean) / wav_std

        from demucs.apply import apply_model

        with torch.no_grad():
            sources = apply_model(
                model, wav_norm.unsqueeze(0).to(device),
                shifts=1, split=True, overlap=0.25, progress=False,
            )[0]

        sources = sources * wav_std + wav_mean
        source_map = {name: sources[idx] for idx, name in enumerate(model.sources)}

        keyboards = source_map["piano"] if piano_only else (source_map["piano"] + source_map["other"])

        save_wav_16bit(job_dir / "vocals.wav", source_map["vocals"], target_sr)
        save_wav_16bit(job_dir / "guitar.wav", source_map["guitar"], target_sr)
        save_wav_16bit(job_dir / "bass.wav", source_map["bass"], target_sr)
        save_wav_16bit(job_dir / "drums.wav", source_map["drums"], target_sr)
        save_wav_16bit(job_dir / "keyboards.wav", keyboards, target_sr)

        in_path.unlink(missing_ok=True)
        elapsed = round(time.perf_counter() - t0, 2)

        return {
            "job_id": job_id,
            "model": MODEL_NAME,
            "device": device,
            "gpu": get_gpu_name(),
            "sample_rate": target_sr,
            "elapsed_sec": elapsed,
            "stems": {
                "vocals": f"/stems/{job_id}/vocals.wav",
                "guitar": f"/stems/{job_id}/guitar.wav",
                "bass": f"/stems/{job_id}/bass.wav",
                "drums": f"/stems/{job_id}/drums.wav",
                "keyboards": f"/stems/{job_id}/keyboards.wav",
            },
        }
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        _jobs.pop(job_id, None)
        raise
    except Exception as exc:
        shutil.rmtree(job_dir, ignore_errors=True)
        _jobs.pop(job_id, None)
        raise HTTPException(status_code=500, detail=f"GPU separation failed: {exc}") from exc


@app.get("/stems/{job_id}/{stem_file}")
def get_stem(job_id: str, stem_file: str):
    if stem_file not in {"vocals.wav", "guitar.wav", "bass.wav", "drums.wav", "keyboards.wav"}:
        raise HTTPException(status_code=404, detail="Invalid stem name")
    if not job_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid job ID")
    target = JOB_ROOT / job_id / stem_file
    if not target.exists():
        raise HTTPException(status_code=404, detail="Stem file expired or not found")
    return FileResponse(str(target), media_type="audio/wav", filename=stem_file)


@app.delete("/stems/{job_id}")
def delete_job(job_id: str):
    if not job_id.isalnum():
        raise HTTPException(status_code=400, detail="Invalid job ID")
    _jobs.pop(job_id, None)
    shutil.rmtree(JOB_ROOT / job_id, ignore_errors=True)
    return {"deleted": True}
`;
