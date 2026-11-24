import type { BassTuningId, GuitarTuningId, QuantizeGrid } from '../types/music';

/**
 * App settings. Stored in the browser (instant) and on the local server in
 * %LOCALAPPDATA%\StemForge\settings.json (shared with the StemForge.exe launcher).
 */

export type EngineMode = 'gpu' | 'browser';
export type SeparationQuality = 'fast' | 'balanced' | 'high';
export type GenrePresetId = 'auto' | 'rock' | 'metal' | 'pop' | 'acoustic' | 'custom';
export type TranscribeTarget = 'guitar' | 'lead' | 'bass' | 'keyboards' | 'vocals' | 'drums';
export type SensitivityTarget = 'guitar' | 'bass' | 'keyboards' | 'vocals' | 'drums';

export interface TranscriptionSettings {
  sensitivity: Record<SensitivityTarget, number>; // 0 (fewer notes) .. 1 (more notes)
  minNoteMs: number;
  tempoMin: number;
  tempoMax: number;
  tempoPrior: number;
  silenceGateDb: number;
  simplifyPowerChords: boolean;
}

/** Separation models of the GPU engine (the engine reports which ones are installed). */
export type SeparatorId = 'auto' | 'roformer' | 'roformer_guitar' | 'roformer_guitar_avg' | 'demucs';

export const SEPARATOR_OPTIONS: Array<{ id: SeparatorId; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatic', hint: 'BS-RoFormer SW in Balanced / High quality, Demucs in Fast.' },
  { id: 'roformer', label: 'BS-RoFormer SW (6 stems)', hint: 'One model for every stem. Clean guitar and bass.' },
  { id: 'roformer_guitar', label: 'BS-RoFormer SW + guitar model', hint: "Guitar from becruily's dedicated guitar model, other stems from SW." },
  { id: 'roformer_guitar_avg', label: 'BS-RoFormer SW + guitar model, averaged', hint: 'Guitar averaged from both models (an ensemble). Often the cleanest.' },
  { id: 'demucs', label: 'Demucs (htdemucs)', hint: "Meta's older model. Fastest; more bleed." },
];

export type ChordTranscriberId = 'basic-pitch' | 'yourmt3';

export const CHORD_TRANSCRIBER_OPTIONS: Array<{ id: ChordTranscriberId; label: string; hint: string }> = [
  { id: 'basic-pitch', label: 'Basic Pitch', hint: 'Fast. Hears distortion overtones as extra notes more often.' },
  { id: 'yourmt3', label: 'YourMT3+', hint: 'Multi-instrument transformer (2024). About a minute more per song. Try both and keep what sounds right.' },
];

/** Friendly names of the models the engine records per song. */
export const MODEL_NAMES: Record<string, string> = {
  bs_roformer_sw: 'BS-RoFormer SW',
  mel_roformer_guitar_becruily: 'becruily guitar model',
  htdemucs_6s: 'Demucs htdemucs_6s',
  htdemucs_ft: 'Demucs htdemucs_ft',
};

export interface AppSettings {
  version: 1;
  engine: { mode: EngineMode; serverUrl: string };
  processing: {
    quality: SeparationQuality;
    keyboardsMode: 'merged' | 'piano';
    splitGuitars: boolean;
    /** The left and right rhythm guitars as two tracks (and two tabs). */
    splitRhythmGuitars: boolean;
    /** Separation model for new songs (each song can be re-separated with another one). */
    separator: SeparatorId;
    /** What transcribes full chords on the guitar (where the riff transcriber can't read a pitch). */
    chordTranscriber: ChordTranscriberId;
    freeVramAfter: boolean;
    transcribe: Record<TranscribeTarget, boolean>;
  };
  genre: GenrePresetId;
  transcription: TranscriptionSettings;
  notation: {
    guitarTuning: GuitarTuningId | 'auto';
    bassTuning: BassTuningId | 'auto';
    allowExtendedRangeGuitar: boolean; // 7 / 8-string candidates for auto-detect
    allowFiveStringBass: boolean;
    maxFret: number;
    accidentals: 'auto' | 'sharps' | 'flats';
  };
  midi: { quantize: QuantizeGrid; minVelocity: number; ppq: 480 | 960 };
  projects: { folder: string; autosave: boolean; includeOriginalInSfg: boolean; reopenLastProject: boolean };
  desktop: { keepEngineRunning: boolean };
  /** Playhead / tab-highlight delay in ms on top of the measured audio output latency (+ = later). */
  playback: { avSyncMs: number };
  exportDefaults: { audio: Record<string, unknown>; midi: Record<string, unknown> };
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';

export interface GenrePreset {
  id: Exclude<GenrePresetId, 'custom'>;
  label: string;
  description: string;
  transcription: TranscriptionSettings;
  allowExtendedRangeGuitar?: boolean;
}

export const GENRE_PRESETS: GenrePreset[] = [
  {
    id: 'auto',
    label: 'Auto / General',
    description: 'Balanced settings for most music.',
    transcription: {
      sensitivity: { guitar: 0.5, bass: 0.5, keyboards: 0.5, vocals: 0.5, drums: 0.5 },
      minNoteMs: 70,
      tempoMin: 60,
      tempoMax: 210,
      tempoPrior: 120,
      silenceGateDb: -45,
      simplifyPowerChords: true,
    },
  },
  {
    id: 'rock',
    label: 'Rock',
    description: 'Driven guitars and live drums; cleans up power chords.',
    transcription: {
      sensitivity: { guitar: 0.48, bass: 0.5, keyboards: 0.5, vocals: 0.5, drums: 0.55 },
      minNoteMs: 60,
      tempoMin: 70,
      tempoMax: 220,
      tempoPrior: 130,
      silenceGateDb: -45,
      simplifyPowerChords: true,
    },
  },
  {
    id: 'metal',
    label: 'Metal',
    description: 'Fast tempos, tremolo picking, blast beats, drop and 7-string tunings, heavy distortion.',
    transcription: {
      sensitivity: { guitar: 0.45, bass: 0.5, keyboards: 0.45, vocals: 0.4, drums: 0.6 },
      minNoteMs: 45,
      tempoMin: 70,
      tempoMax: 260,
      tempoPrior: 150,
      silenceGateDb: -45,
      simplifyPowerChords: true,
    },
    allowExtendedRangeGuitar: true,
  },
  {
    id: 'pop',
    label: 'Pop / Electronic',
    description: 'Steady tempos, synths and clean vocals.',
    transcription: {
      sensitivity: { guitar: 0.5, bass: 0.5, keyboards: 0.55, vocals: 0.55, drums: 0.5 },
      minNoteMs: 80,
      tempoMin: 60,
      tempoMax: 190,
      tempoPrior: 115,
      silenceGateDb: -45,
      simplifyPowerChords: false,
    },
  },
  {
    id: 'acoustic',
    label: 'Acoustic / Folk',
    description: 'Clean guitars and piano with full chords; slower tempos.',
    transcription: {
      sensitivity: { guitar: 0.55, bass: 0.5, keyboards: 0.55, vocals: 0.5, drums: 0.45 },
      minNoteMs: 80,
      tempoMin: 50,
      tempoMax: 180,
      tempoPrior: 100,
      silenceGateDb: -48,
      simplifyPowerChords: false,
    },
  },
];

export function presetById(id: GenrePresetId): GenrePreset | undefined {
  return GENRE_PRESETS.find((p) => p.id === id);
}

export function defaultSettings(): AppSettings {
  const auto = GENRE_PRESETS[0];
  return {
    version: 1,
    engine: { mode: 'gpu', serverUrl: DEFAULT_SERVER_URL },
    processing: {
      quality: 'balanced',
      keyboardsMode: 'merged',
      splitGuitars: false,
      splitRhythmGuitars: true,
      separator: 'auto',
      chordTranscriber: 'basic-pitch',
      freeVramAfter: false,
      transcribe: { guitar: true, lead: true, bass: true, keyboards: true, vocals: true, drums: true },
    },
    genre: 'auto',
    transcription: structuredClone(auto.transcription),
    notation: {
      guitarTuning: 'auto',
      bassTuning: 'auto',
      allowExtendedRangeGuitar: false,
      allowFiveStringBass: true,
      maxFret: 22,
      accidentals: 'auto',
    },
    midi: { quantize: '1/16', minVelocity: 30, ppq: 480 },
    projects: { folder: '', autosave: true, includeOriginalInSfg: true, reopenLastProject: true },
    desktop: { keepEngineRunning: false },
    playback: { avSyncMs: 0 },
    exportDefaults: { audio: {}, midi: {} },
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merges saved settings over the defaults (unknown keys ignored, types checked). */
export function mergeSettings(base: AppSettings, saved: unknown): AppSettings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObj(a)) return b !== undefined && typeof b === typeof a ? b : a;
    if (!isObj(b)) return a;
    const out: Record<string, unknown> = { ...a };
    for (const key of Object.keys(a)) {
      if (key in b) out[key] = merge(a[key], b[key]);
    }
    // exportDefaults keeps free-form remembered values
    return out;
  };
  const merged = merge(base, saved) as AppSettings;
  if (isObj(saved) && isObj(saved.exportDefaults)) {
    const ed = saved.exportDefaults as Record<string, unknown>;
    merged.exportDefaults = {
      audio: isObj(ed.audio) ? ed.audio : {},
      midi: isObj(ed.midi) ? ed.midi : {},
    };
  }
  return merged;
}

const STORAGE_KEY = 'stemforge_settings_v1';
const LEGACY_GPU_KEY = 'stemforge_gpu_config_v1';

export function loadLocalSettings(): AppSettings {
  const base = defaultSettings();
  try {
    if (typeof window !== 'undefined' && window.location.origin !== DEFAULT_SERVER_URL) {
      // In plain dev mode (served by Vite) start in browser mode unless the user chose otherwise.
      base.engine.mode = 'browser';
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return mergeSettings(base, JSON.parse(raw));
    const legacy = window.localStorage.getItem(LEGACY_GPU_KEY);
    if (legacy) {
      const l = JSON.parse(legacy) as { mode?: string; serverUrl?: string; pianoOnly?: boolean };
      base.engine.mode = l.mode === 'gpu' ? 'gpu' : 'browser';
      if (l.serverUrl) base.engine.serverUrl = l.serverUrl;
      base.processing.keyboardsMode = l.pianoOnly ? 'piano' : 'merged';
    }
  } catch {
    // storage unavailable
  }
  return base;
}

export function saveLocalSettings(settings: AppSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

/** Options sent to the server when importing / re-analyzing a song. */
export function processingPayload(settings: AppSettings, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const t = settings.transcription;
  return {
    quality: settings.processing.quality,
    keyboardsMode: settings.processing.keyboardsMode,
    splitGuitars: settings.processing.splitGuitars,
    splitRhythmGuitars: settings.processing.splitRhythmGuitars,
    separator: settings.processing.separator,
    chordTranscriber: settings.processing.chordTranscriber,
    freeVramAfter: settings.processing.freeVramAfter,
    transcribe: settings.processing.transcribe,
    sensitivity: t.sensitivity,
    minNoteMs: t.minNoteMs,
    tempoMin: t.tempoMin,
    tempoMax: t.tempoMax,
    tempoPrior: t.tempoPrior,
    silenceGateDb: t.silenceGateDb,
    ...extra,
  };
}

export function applyGenrePreset(settings: AppSettings, id: GenrePresetId): AppSettings {
  const preset = presetById(id);
  if (!preset) return { ...settings, genre: 'custom' };
  return {
    ...settings,
    genre: id,
    transcription: structuredClone(preset.transcription),
    notation: {
      ...settings.notation,
      allowExtendedRangeGuitar: preset.allowExtendedRangeGuitar ?? settings.notation.allowExtendedRangeGuitar,
    },
  };
}
