import type { MidiNoteEvent, StemId } from '../types/music';

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
  vramFreeGb?: number;
  modelLoaded?: boolean;
  ffmpeg?: boolean;
  transcriber?: string | null;
}

/** One transcribed note from the GPU server: [startSec, endSec, midiPitch, velocity]. */
export type GpuNoteTuple = [number, number, number, number];

export type TranscribedStemId = 'guitar' | 'bass' | 'keyboards' | 'vocals';

export interface GpuTranscription {
  engine: 'basic-pitch' | null;
  bpm?: number | null;
  notes?: Partial<Record<TranscribedStemId, GpuNoteTuple[]>>;
  elapsed_sec?: number;
  error?: string;
  errors?: Record<string, string>;
}

export interface GpuSeparateResponse {
  job_id: string;
  model: string;
  device: string;
  gpu: string;
  sample_rate: number;
  elapsed_sec: number;
  stems: Record<StemId, string>;
  transcription?: GpuTranscription | null;
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
      vram_free_gb?: number;
      model_loaded?: boolean;
      ffmpeg?: boolean;
      transcriber?: string | null;
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
      vramFreeGb: typeof data.vram_free_gb === 'number' ? data.vram_free_gb : undefined,
      modelLoaded: Boolean(data.model_loaded),
      ffmpeg: typeof data.ffmpeg === 'boolean' ? data.ffmpeg : undefined,
      transcriber: data.transcriber ?? null,
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

  onStage?.('Uploading & separating on your GPU (htdemucs_6s), then transcribing notes (Basic Pitch)', 20);

  let res: Response;
  try {
    const query = `?piano_only=${pianoOnly ? 'true' : 'false'}&transcribe=true`;
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


/**
 * Converts GPU-server note tuples ([startSec, endSec, midi, velocity]) into beat-based
 * MIDI note events for the studio (start/duration measured in quarter-note beats).
 */
export function gpuNotesToMidiEvents(
  tuples: GpuNoteTuple[] | undefined,
  bpm: number,
  prefix: string,
  channel = 0
): MidiNoteEvent[] {
  if (!tuples || tuples.length === 0) return [];
  const beatsPerSec = bpm / 60;
  const events: MidiNoteEvent[] = [];
  tuples.forEach(([start, end, midi, velocity], idx) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    events.push({
      id: `${prefix}-${idx + 1}`,
      midi: Math.max(0, Math.min(127, Math.round(midi))),
      startBeat: Math.max(0, start * beatsPerSec),
      durationBeats: Math.max(0.0625, (end - start) * beatsPerSec),
      velocity: Math.max(1, Math.min(127, Math.round(velocity))),
      channel,
    });
  });
  return events.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

/** Asks the local GPU server to release the Demucs model from VRAM (e.g. before a ComfyUI job). */
export async function unloadGpuModel(serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const base = normalizeServerUrl(serverUrl);
  const res = await fetchImpl(`${base}/unload`, { method: 'POST' });
  if (!res.ok) throw new Error(`GPU server returned HTTP ${res.status}`);
  const data = (await res.json()) as { unloaded?: boolean };
  return Boolean(data.unloaded);
}
