export type StemId = 'vocals' | 'guitar' | 'lead' | 'bass' | 'drums' | 'keyboards';

/** Stems that get melodic (pitched) transcription. */
export type MelodicStemId = 'keyboards' | 'guitar' | 'lead' | 'bass' | 'vocals';

export type WorkspaceView = 'mixer' | 'midi' | 'notation' | 'library' | 'settings';

export type NotationMode = 'tabs' | 'chords' | 'sheet';

export type StringInstrument = 'guitar' | 'bass';

/** Which transcribed part the notation view shows. */
export type NotationPart = 'guitar' | 'lead' | 'bass';

export type GuitarTuningId =
  | 'standard'
  | 'dropD'
  | 'halfStepDown'
  | 'dStandard'
  | 'dropCSharp'
  | 'dropC'
  | 'cSharpStandard'
  | 'cStandard'
  | 'dropB'
  | 'bStandard'
  | 'dropA'
  | 'seven'
  | 'sevenDropA'
  | 'eight';

export type BassTuningId =
  | 'standard4'
  | 'dropD4'
  | 'halfStepDown4'
  | 'dStandard4'
  | 'dropC4'
  | 'cStandard4'
  | 'bStandard4'
  | 'five'
  | 'fiveDropA';

export type QuantizeGrid = 'off' | '1/4' | '1/8' | '1/16' | '1/32' | '1/8T' | '1/16T';

export interface StemMeta {
  id: StemId;
  label: string;
  color: string;
  dimColor: string;
  shortcut: string;
  role: string;
}

export const STEM_LIST: StemMeta[] = [
  {
    id: 'vocals',
    label: 'Vocals',
    color: '#F43F5E',
    dimColor: 'rgba(244, 63, 94, 0.25)',
    shortcut: '1',
    role: 'Lead & Harmony',
  },
  {
    id: 'guitar',
    label: 'Guitar',
    color: '#F59E0B',
    dimColor: 'rgba(245, 158, 11, 0.25)',
    shortcut: '2',
    role: 'Rhythm & Lead',
  },
  {
    id: 'lead',
    label: 'Lead Guitar',
    color: '#FB923C',
    dimColor: 'rgba(251, 146, 60, 0.25)',
    shortcut: '3',
    role: 'Center / Solos',
  },
  {
    id: 'bass',
    label: 'Bass',
    color: '#38BDF8',
    dimColor: 'rgba(56, 189, 248, 0.25)',
    shortcut: '4',
    role: 'Low End',
  },
  {
    id: 'drums',
    label: 'Drums',
    color: '#A78BFA',
    dimColor: 'rgba(167, 139, 250, 0.25)',
    shortcut: '5',
    role: 'Percussion Kit',
  },
  {
    id: 'keyboards',
    label: 'Keyboards',
    color: '#34D399',
    dimColor: 'rgba(52, 211, 153, 0.25)',
    shortcut: '6',
    role: 'Piano & Synth',
  },
];

export const ALL_STEM_IDS: StemId[] = STEM_LIST.map((s) => s.id);

export interface StemMixerState {
  volume: number; // 0 to 1.25
  muted: boolean;
  solo: boolean;
  pan: number; // -1 to 1
}

export interface MidiNoteEvent {
  id: string;
  midi: number; // 0-127
  startBeat: number;
  durationBeats: number;
  velocity: number; // 1-127
  channel: number; // 0 for keys, 9 for GM drums
  label?: string; // e.g. 'Kick', 'Snare', 'C4'
}

export type DrumVoice = 'kick' | 'snare' | 'hihat' | 'openhat' | 'tom' | 'crash';

export interface DrumHitEvent {
  id: string;
  voice: DrumVoice;
  midi: number; // GM percussion MIDI note (36, 38, 42, 46, 45, 49)
  startBeat: number;
  velocity: number; // 1-127
}

export interface TabNoteEvent {
  id: string;
  midi: number;
  startBeat: number;
  durationBeats: number;
  stringIndex: number; // 0 = highest string (e on guitar, G on bass)
  fret: number;
  velocity: number;
}

export interface ChordEvent {
  id: string;
  symbol: string; // e.g., 'Am7', 'Fmaj7', 'C', 'G', 'E5'
  rootPc: number; // 0-11 (C=0)
  quality: 'maj' | 'min' | '7' | 'maj7' | 'm7' | '5';
  startBeat: number;
  durationBeats: number;
  bassPc?: number;
}

export interface StemTrackData {
  id: StemId;
  buffer: AudioBuffer;
  peaks: number[]; // Normalized 0-1 waveform peaks for fast canvas rendering
  rmsLevel: number;
}

/** One transcribed note from the server: [startSec, endSec, midiPitch, velocity]. */
export type NoteTuple = [number, number, number, number];

/** One transcribed drum hit from the server: [timeSec, gmMidiNote, velocity]. */
export type DrumTuple = [number, number, number];

export interface RawTranscription {
  notes: Partial<Record<MelodicStemId, NoteTuple[]>>;
  drums: DrumTuple[];
}

export interface SongProject {
  id: string;
  title: string;
  artist: string;
  sourceType: 'demo' | 'upload' | 'project';
  fileFormat: string; // e.g. 'Studio Demo', 'MP3', 'WAV', 'FLAC'
  duration: number; // seconds
  bpm: number;
  /** Time (seconds) of the first beat of the grid; beat = (time - beatOffsetSec) * bpm / 60. */
  beatOffsetSec: number;
  timeSignature: [number, number]; // e.g. [4, 4]
  keyRootPc: number; // 0-11
  keyMode: 'major' | 'minor';
  stems: Partial<Record<StemId, StemTrackData>>;
  keyboardMidi: MidiNoteEvent[];
  drumHits: DrumHitEvent[];
  guitarNotes: MidiNoteEvent[];
  leadNotes: MidiNoteEvent[];
  bassNotes: MidiNoteEvent[];
  vocalNotes: MidiNoteEvent[];
  chords: ChordEvent[];
  /** Which transcriber produced the melodic notes: 'basic-pitch' = polyphonic neural (GPU server), 'yin' = browser monophonic. */
  transcriptionEngine?: 'basic-pitch' | 'yin' | 'demo';
  drumEngine?: 'adtof' | 'onsets' | 'browser' | 'demo';
  /** Server project id when the song lives in the project library (autosaved, exportable). */
  serverProjectId?: string;
  /** Playback/export gain that restores the original song level (stems are saved with headroom). */
  levelCompensation?: number;
  /** Seconds-based transcription kept so notes can be re-derived when tempo / options change. */
  raw?: RawTranscription;
}

export interface SeparationProgress {
  stage: string;
  percent: number;
}

/** Stems present in a project, in mixer order. */
export function projectStemIds(project: SongProject): StemId[] {
  return ALL_STEM_IDS.filter((id) => Boolean(project.stems[id]));
}

/** Display label (when the guitar is split, the 'guitar' stem holds the rhythm guitars). */
export function stemLabel(id: StemId, project?: SongProject | null): string {
  if (id === 'guitar' && project?.stems.lead) return 'Rhythm Guitar';
  return STEM_LIST.find((s) => s.id === id)?.label ?? id;
}
