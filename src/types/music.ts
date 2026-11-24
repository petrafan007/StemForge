export type StemId = 'vocals' | 'guitar' | 'bass' | 'drums' | 'keyboards';

export type WorkspaceView = 'mixer' | 'midi' | 'notation' | 'library';

export type NotationMode = 'tabs' | 'chords' | 'sheet';

export type StringInstrument = 'guitar' | 'bass';

export type GuitarTuningId = 'standard' | 'dropD' | 'halfStepDown';

export type BassTuningId = 'standard4' | 'dropD4';

export type QuantizeGrid = '1/4' | '1/8' | '1/16';

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
    id: 'bass',
    label: 'Bass',
    color: '#38BDF8',
    dimColor: 'rgba(56, 189, 248, 0.25)',
    shortcut: '3',
    role: 'Low End',
  },
  {
    id: 'drums',
    label: 'Drums',
    color: '#A78BFA',
    dimColor: 'rgba(167, 139, 250, 0.25)',
    shortcut: '4',
    role: 'Percussion Kit',
  },
  {
    id: 'keyboards',
    label: 'Keyboards',
    color: '#34D399',
    dimColor: 'rgba(52, 211, 153, 0.25)',
    shortcut: '5',
    role: 'Piano & Synth',
  },
];

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
  symbol: string; // e.g., 'Am7', 'Fmaj7', 'C', 'G'
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

export interface SongProject {
  id: string;
  title: string;
  artist: string;
  sourceType: 'demo' | 'upload';
  fileFormat: string; // e.g. 'Studio Demo', 'MP3', 'WAV', 'FLAC'
  duration: number; // seconds
  bpm: number;
  timeSignature: [number, number]; // e.g. [4, 4]
  keyRootPc: number; // 0-11
  keyMode: 'major' | 'minor';
  stems: Record<StemId, StemTrackData>;
  keyboardMidi: MidiNoteEvent[];
  drumHits: DrumHitEvent[];
  guitarNotes: MidiNoteEvent[];
  bassNotes: MidiNoteEvent[];
  vocalNotes: MidiNoteEvent[];
  chords: ChordEvent[];
  /** Which transcriber produced the melodic notes: 'basic-pitch' = polyphonic neural (GPU server), 'yin' = browser monophonic. */
  transcriptionEngine?: 'basic-pitch' | 'yin' | 'demo';
}

export interface SeparationProgress {
  stage: string;
  percent: number;
}
