import type { DrumTuple, MelodicStemId, NoteTuple, StemId } from '../types/music';
import { DEFAULT_SERVER_URL } from '../settings/appSettings';

/**
 * Client for the local StemForge server (local-gpu-server/gpu_server.py).
 * Every function takes an optional fetch implementation so it can be unit-tested.
 */

export const DEFAULT_GPU_SERVER_URL = DEFAULT_SERVER_URL;

type FetchFn = typeof fetch;

export interface GpuHealthStatus {
  ok: boolean;
  version?: string;
  model: string;
  device: string;
  cuda: boolean;
  gpu: string;
  vramGb?: number;
  vramFreeGb?: number;
  modelLoaded?: boolean;
  modelsLoaded?: string[];
  ffmpeg?: boolean;
  transcriber?: string | null;
  drumTranscriber?: string | null;
  projectsDir?: string;
  supportsProjects: boolean;
}

export interface ProjectSummary {
  id: string;
  title: string;
  artist: string;
  album: string;
  status: 'processing' | 'ready' | 'error';
  error?: string | null;
  stage?: string;
  percent?: number;
  createdAt?: string;
  updatedAt?: string;
  durationSec?: number | null;
  bpm?: number | null;
  stems: StemId[];
  quality?: string | null;
  sizeMB?: number;
}

export interface JobStatus {
  status: 'processing' | 'ready' | 'error' | 'cancelled';
  stage: string | null;
  percent: number;
  error: string | null;
}

/** The saved, user-editable part of a project (autosaved). */
export interface ProjectState {
  bpm?: number;
  beatOffsetSec?: number;
  timeSignature?: [number, number];
  key?: { rootPc: number; mode: 'major' | 'minor' } | null;
  mixer?: Record<string, { volume: number; muted: boolean; solo: boolean; pan: number }>;
  transpose?: number;
  playbackRate?: number;
  loop?: boolean;
  metronome?: boolean;
  guitarTuning?: string;
  bassTuning?: string;
  quantize?: string;
  minVelocity?: number;
  simplifyPowerChords?: boolean;
  notationPart?: string;
}

export interface ProjectDocument {
  format: 'stemforge-project';
  version: number;
  id: string;
  title: string;
  artist: string;
  album?: string;
  createdAt: string;
  updatedAt: string;
  status: 'processing' | 'ready' | 'error';
  error?: string | null;
  source: { fileName: string; format: string; durationSec?: number; sampleRate?: number; channels?: number; sizeBytes?: number };
  processing?: {
    quality?: string;
    options?: Record<string, unknown>;
    device?: string;
    gpu?: string;
    separation?: {
      models?: string[];
      shifts?: number;
      seconds?: number;
      gain?: number;
      guitarSplit?: boolean;
      guitarSplitNote?: string;
      guitarSideRatio?: number;
    } | null;
  };
  stems: StemId[];
  analysis?: {
    bpm: number;
    beatOffsetSec: number;
    bpmCandidates?: number[];
    timeSignature?: [number, number];
    /** Tempo map: time (s) of every beat, first beat on a bar line (Beat This! tracker). */
    beats?: number[];
    tempoEngine?: 'beat_this' | 'librosa';
  };
  transcription?: {
    engine: 'basic-pitch' | null;
    stringEngine?: 'riff' | 'basic-pitch' | null;
    stringStats?: Record<string, Record<string, number>>;
    drumEngine: 'adtof' | 'onsets' | null;
    notes: Partial<Record<MelodicStemId, NoteTuple[]>>;
    drums: DrumTuple[];
    silentStems?: string[];
    stemLevelsDb?: Record<string, number>;
    seconds?: number;
  };
  state?: ProjectState;
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return DEFAULT_GPU_SERVER_URL;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

export function resolveServerUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${normalizeServerUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

async function request<T>(base: string, path: string, init: RequestInit = {}, fetchImpl: FetchFn = fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(resolveServerUrl(base, path), init);
  } catch {
    throw new Error(
      `Could not reach the StemForge GPU engine at ${normalizeServerUrl(base)}. Start StemForge from the desktop shortcut (or run start-stemforge.ps1).`
    );
  }
  if (!res.ok) throw new Error(await errorDetail(res));
  return (await res.json()) as T;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function checkGpuServerHealth(serverUrl: string, fetchImpl: FetchFn = fetch): Promise<GpuHealthStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const data = await request<Record<string, unknown>>(serverUrl, '/health', { signal: controller.signal }, fetchImpl);
    if (!data.ok) throw new Error('GPU server responded without ok=true');
    const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
    return {
      ok: true,
      version: typeof data.version === 'string' ? data.version : undefined,
      model: (data.model as string) || 'htdemucs_6s',
      device: (data.device as string) || (data.cuda ? 'cuda' : 'cpu'),
      cuda: Boolean(data.cuda),
      gpu: (data.gpu as string) || 'Local GPU',
      vramGb: num(data.vram_gb),
      vramFreeGb: num(data.vram_free_gb),
      modelLoaded: Boolean(data.model_loaded),
      modelsLoaded: Array.isArray(data.models_loaded) ? (data.models_loaded as string[]) : [],
      ffmpeg: typeof data.ffmpeg === 'boolean' ? data.ffmpeg : undefined,
      transcriber: (data.transcriber as string | null) ?? null,
      drumTranscriber: (data.drum_transcriber as string | null) ?? null,
      projectsDir: typeof data.projects_dir === 'string' ? data.projects_dir : undefined,
      supportsProjects: Boolean(data.projects),
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Connection to ${normalizeServerUrl(serverUrl)} timed out. Is the StemForge GPU engine running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export const unloadGpuModel = (base: string, f: FetchFn = fetch) =>
  request<{ unloaded: boolean }>(base, '/unload', { method: 'POST' }, f).then((r) => r.unloaded);

export const getServerSettings = (base: string, f: FetchFn = fetch) =>
  request<{ settings: Record<string, unknown>; defaultProjectsDir: string; projectsDir: string }>(base, '/settings', {}, f);

export const putServerSettings = (base: string, settings: unknown, f: FetchFn = fetch) =>
  request<{ settings: unknown; projectsDir: string }>(base, '/settings', json({ settings }, 'PUT'), f);

export const pickFolder = (base: string, initial?: string, f: FetchFn = fetch) =>
  request<{ path: string | null }>(base, '/dialog/folder', json({ initial }), f).then((r) => r.path);

export const revealFolder = (base: string, projectId?: string, f: FetchFn = fetch) =>
  request<{ path: string }>(base, '/reveal', json(projectId ? { projectId } : {}), f);

export const listProjects = (base: string, f: FetchFn = fetch) =>
  request<{ projects: ProjectSummary[]; projectsDir: string }>(base, '/projects', {}, f);

export async function createProject(
  base: string,
  file: File,
  options: Record<string, unknown>,
  f: FetchFn = fetch
): Promise<{ id: string; title: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('options', JSON.stringify(options));
  return request(base, '/projects', { method: 'POST', body: form }, f);
}

export const getProject = (base: string, id: string, f: FetchFn = fetch) =>
  request<ProjectDocument>(base, `/projects/${encodeURIComponent(id)}`, {}, f);

export const getProjectStatus = (base: string, id: string, f: FetchFn = fetch) =>
  request<JobStatus>(base, `/projects/${encodeURIComponent(id)}/status`, {}, f);

export const saveProjectState = (base: string, id: string, state: ProjectState, meta: Record<string, string> = {}, f: FetchFn = fetch) =>
  request<{ ok: boolean; updatedAt: string }>(base, `/projects/${encodeURIComponent(id)}/state`, json({ state, ...meta }, 'PUT'), f);

/** Best-effort save while the window is closing (keepalive survives page unload). */
export function saveProjectStateOnUnload(base: string, id: string, state: ProjectState, meta: Record<string, string> = {}): void {
  try {
    void fetch(resolveServerUrl(base, `/projects/${encodeURIComponent(id)}/state`), {
      ...json({ state, ...meta }, 'PUT'),
      keepalive: true,
    });
  } catch {
    // ignore
  }
}

export const reprocessProject = (base: string, id: string, options: Record<string, unknown>, f: FetchFn = fetch) =>
  request<{ ok: boolean }>(base, `/projects/${encodeURIComponent(id)}/reprocess`, json(options), f);

export const cancelProject = (base: string, id: string, f: FetchFn = fetch) =>
  request<{ cancelled: boolean }>(base, `/projects/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, f);

export const deleteProject = (base: string, id: string, f: FetchFn = fetch) =>
  request<{ deleted: boolean; trashPath: string }>(base, `/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }, f);

export function stemUrl(base: string, id: string, stem: StemId, transpose = 0): string {
  const q = transpose ? `?transpose=${Math.round(transpose)}` : '';
  return resolveServerUrl(base, `/projects/${encodeURIComponent(id)}/stems/${stem}.flac${q}`);
}

/** Downloads a stem; with `transpose` the server returns a pitch-shifted copy (same tempo). */
export async function fetchStem(base: string, id: string, stem: StemId, f: FetchFn = fetch, transpose = 0): Promise<ArrayBuffer> {
  const res = await f(stemUrl(base, id, stem, transpose));
  if (!res.ok) throw new Error(`Could not load the ${stem} stem (${await errorDetail(res)}).`);
  return res.arrayBuffer();
}

function filenameFromDisposition(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}

export async function downloadSfg(base: string, id: string, includeOriginal: boolean, f: FetchFn = fetch): Promise<{ blob: Blob; fileName: string }> {
  let res: Response;
  try {
    res = await f(resolveServerUrl(base, `/projects/${encodeURIComponent(id)}/sfg?original=${includeOriginal ? 'true' : 'false'}`));
  } catch {
    throw new Error('Could not reach the StemForge GPU engine to save the project.');
  }
  if (!res.ok) throw new Error(await errorDetail(res));
  return { blob: await res.blob(), fileName: filenameFromDisposition(res, `${id}.sfg`) };
}

export async function importSfg(base: string, file: File | Blob, name = 'project.sfg', f: FetchFn = fetch): Promise<string> {
  const form = new FormData();
  form.append('file', file, name);
  const r = await request<{ id: string }>(base, '/projects/import', { method: 'POST', body: form }, f);
  return r.id;
}

export async function exportAudioOnServer(
  base: string,
  id: string,
  spec: Record<string, unknown>,
  f: FetchFn = fetch
): Promise<{ blob: Blob; fileName: string }> {
  let res: Response;
  try {
    res = await f(resolveServerUrl(base, `/projects/${encodeURIComponent(id)}/export/audio`), json(spec));
  } catch {
    throw new Error('Could not reach the StemForge GPU engine to export audio.');
  }
  if (!res.ok) throw new Error(await errorDetail(res));
  return { blob: await res.blob(), fileName: filenameFromDisposition(res, 'export') };
}

/** Polls a processing job until it finishes; reports progress along the way. */
export async function waitForProject(
  base: string,
  id: string,
  onProgress: (status: JobStatus) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
  f: FetchFn = fetch
): Promise<JobStatus> {
  const interval = opts.intervalMs ?? 600;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const status = await getProjectStatus(base, id, f);
    onProgress(status);
    if (status.status !== 'processing') return status;
    await new Promise((r) => setTimeout(r, interval));
  }
}
