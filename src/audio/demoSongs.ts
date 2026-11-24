import type {
  ChordEvent,
  DrumHitEvent,
  MidiNoteEvent,
  SongProject,
  StemId,
  StemTrackData,
} from '../types/music';
import { computeRms, computeWaveformPeaks } from './stemDsp';
import { formatChordSymbol, midiToFrequency, midiToNoteName } from './notationEngine';

export interface DemoSongBlueprint {
  id: string;
  title: string;
  artist: string;
  genre: string;
  bpm: number;
  bars: number;
  keyRootPc: number;
  keyMode: 'major' | 'minor';
  chords: Array<{ rootPc: number; quality: ChordEvent['quality']; startBeat: number; durationBeats: number }>;
  vocals: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  guitar: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  bass: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  keyboards: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>;
  drums: Array<{ voice: DrumHitEvent['voice']; midi: number; startBeat: number; velocity: number }>;
}

function repeatPattern<T extends { startBeat: number }>(
  pattern: T[],
  patternBeats: number,
  totalBeats: number
): T[] {
  const out: T[] = [];
  for (let offset = 0; offset < totalBeats; offset += patternBeats) {
    for (const item of pattern) {
      if (item.startBeat + offset < totalBeats) {
        out.push({ ...item, startBeat: item.startBeat + offset });
      }
    }
  }
  return out;
}

export const DEMO_SONG_LIST: DemoSongBlueprint[] = [
  {
    id: 'demo-midnight-groove',
    title: 'Midnight Groove',
    artist: 'Studio Session I',
    genre: 'Neo-Soul / Funk',
    bpm: 112,
    bars: 8,
    keyRootPc: 9, // A Minor
    keyMode: 'minor',
    chords: [
      { rootPc: 9, quality: 'm7', startBeat: 0, durationBeats: 4 },
      { rootPc: 5, quality: 'maj7', startBeat: 4, durationBeats: 4 },
      { rootPc: 0, quality: 'maj', startBeat: 8, durationBeats: 4 },
      { rootPc: 7, quality: '7', startBeat: 12, durationBeats: 4 },
      { rootPc: 9, quality: 'm7', startBeat: 16, durationBeats: 4 },
      { rootPc: 2, quality: 'm7', startBeat: 20, durationBeats: 4 },
      { rootPc: 5, quality: 'maj7', startBeat: 24, durationBeats: 4 },
      { rootPc: 4, quality: '7', startBeat: 28, durationBeats: 4 },
    ],
    vocals: repeatPattern(
      [
        { midi: 69, startBeat: 0.5, durationBeats: 1, velocity: 98 },
        { midi: 72, startBeat: 1.5, durationBeats: 1, velocity: 105 },
        { midi: 71, startBeat: 2.5, durationBeats: 1.25, velocity: 96 },
        { midi: 69, startBeat: 4.5, durationBeats: 1, velocity: 100 },
        { midi: 67, startBeat: 5.5, durationBeats: 1.5, velocity: 95 },
        { midi: 64, startBeat: 7, durationBeats: 1, velocity: 90 },
        { midi: 67, startBeat: 8.5, durationBeats: 1, velocity: 104 },
        { midi: 72, startBeat: 9.5, durationBeats: 1.5, velocity: 110 },
        { midi: 71, startBeat: 11, durationBeats: 0.75, velocity: 98 },
        { midi: 69, startBeat: 12, durationBeats: 1.5, velocity: 102 },
        { midi: 67, startBeat: 13.5, durationBeats: 1.5, velocity: 96 },
      ],
      16,
      32
    ),
    guitar: repeatPattern(
      [
        { midi: 57, startBeat: 0, durationBeats: 0.5, velocity: 96 },
        { midi: 60, startBeat: 0.5, durationBeats: 0.5, velocity: 92 },
        { midi: 64, startBeat: 1, durationBeats: 0.75, velocity: 102 },
        { midi: 62, startBeat: 2, durationBeats: 0.5, velocity: 90 },
        { midi: 60, startBeat: 2.5, durationBeats: 0.75, velocity: 94 },
        { midi: 57, startBeat: 3.5, durationBeats: 0.5, velocity: 88 },
        { midi: 53, startBeat: 4, durationBeats: 0.5, velocity: 98 },
        { midi: 57, startBeat: 4.5, durationBeats: 0.5, velocity: 94 },
        { midi: 60, startBeat: 5, durationBeats: 1, velocity: 100 },
        { midi: 64, startBeat: 6, durationBeats: 0.75, velocity: 96 },
        { midi: 60, startBeat: 7, durationBeats: 0.75, velocity: 90 },
        { midi: 48, startBeat: 8, durationBeats: 0.5, velocity: 95 },
        { midi: 52, startBeat: 8.5, durationBeats: 0.5, velocity: 94 },
        { midi: 55, startBeat: 9, durationBeats: 1, velocity: 100 },
        { midi: 60, startBeat: 10.5, durationBeats: 1, velocity: 102 },
        { midi: 55, startBeat: 12, durationBeats: 0.75, velocity: 98 },
        { midi: 59, startBeat: 13, durationBeats: 0.75, velocity: 96 },
        { midi: 62, startBeat: 14, durationBeats: 1.25, velocity: 104 },
      ],
      16,
      32
    ),
    bass: repeatPattern(
      [
        { midi: 33, startBeat: 0, durationBeats: 1, velocity: 110 },
        { midi: 33, startBeat: 1.5, durationBeats: 0.5, velocity: 96 },
        { midi: 40, startBeat: 2, durationBeats: 0.75, velocity: 102 },
        { midi: 36, startBeat: 3, durationBeats: 0.75, velocity: 98 },
        { midi: 29, startBeat: 4, durationBeats: 1, velocity: 110 },
        { midi: 33, startBeat: 5.5, durationBeats: 0.5, velocity: 95 },
        { midi: 36, startBeat: 6, durationBeats: 1, velocity: 104 },
        { midi: 33, startBeat: 7, durationBeats: 0.75, velocity: 92 },
        { midi: 36, startBeat: 8, durationBeats: 1, velocity: 108 },
        { midi: 36, startBeat: 9.5, durationBeats: 0.5, velocity: 95 },
        { midi: 43, startBeat: 10, durationBeats: 1, velocity: 102 },
        { midi: 40, startBeat: 11, durationBeats: 0.75, velocity: 96 },
        { midi: 31, startBeat: 12, durationBeats: 1, velocity: 112 },
        { midi: 35, startBeat: 13, durationBeats: 0.75, velocity: 100 },
        { midi: 38, startBeat: 14, durationBeats: 1, velocity: 106 },
        { midi: 35, startBeat: 15, durationBeats: 0.75, velocity: 96 },
      ],
      16,
      32
    ),
    keyboards: repeatPattern(
      [
        // Am7
        { midi: 57, startBeat: 0, durationBeats: 2, velocity: 88 },
        { midi: 60, startBeat: 0, durationBeats: 2, velocity: 85 },
        { midi: 64, startBeat: 0, durationBeats: 2, velocity: 86 },
        { midi: 67, startBeat: 0, durationBeats: 2, velocity: 84 },
        { midi: 64, startBeat: 2.5, durationBeats: 1, velocity: 80 },
        { midi: 67, startBeat: 2.5, durationBeats: 1, velocity: 82 },
        // Fmaj7
        { midi: 53, startBeat: 4, durationBeats: 2.5, velocity: 88 },
        { midi: 57, startBeat: 4, durationBeats: 2.5, velocity: 84 },
        { midi: 60, startBeat: 4, durationBeats: 2.5, velocity: 86 },
        { midi: 64, startBeat: 4, durationBeats: 2.5, velocity: 84 },
        // C
        { midi: 60, startBeat: 8, durationBeats: 2, velocity: 88 },
        { midi: 64, startBeat: 8, durationBeats: 2, velocity: 86 },
        { midi: 67, startBeat: 8, durationBeats: 2, velocity: 86 },
        { midi: 64, startBeat: 10.5, durationBeats: 1, velocity: 82 },
        // G7
        { midi: 55, startBeat: 12, durationBeats: 2.5, velocity: 90 },
        { midi: 59, startBeat: 12, durationBeats: 2.5, velocity: 86 },
        { midi: 62, startBeat: 12, durationBeats: 2.5, velocity: 86 },
        { midi: 65, startBeat: 12, durationBeats: 2.5, velocity: 82 },
      ],
      16,
      32
    ),
    drums: repeatPattern(
      [
        { voice: 'crash', midi: 49, startBeat: 0, velocity: 95 },
        { voice: 'kick', midi: 36, startBeat: 0, velocity: 118 },
        { voice: 'hihat', midi: 42, startBeat: 0, velocity: 88 },
        { voice: 'hihat', midi: 42, startBeat: 0.5, velocity: 72 },
        { voice: 'snare', midi: 38, startBeat: 1, velocity: 112 },
        { voice: 'hihat', midi: 42, startBeat: 1, velocity: 86 },
        { voice: 'hihat', midi: 42, startBeat: 1.5, velocity: 74 },
        { voice: 'kick', midi: 36, startBeat: 1.75, velocity: 94 },
        { voice: 'kick', midi: 36, startBeat: 2, velocity: 114 },
        { voice: 'hihat', midi: 42, startBeat: 2, velocity: 88 },
        { voice: 'hihat', midi: 42, startBeat: 2.5, velocity: 76 },
        { voice: 'snare', midi: 38, startBeat: 3, velocity: 114 },
        { voice: 'hihat', midi: 42, startBeat: 3, velocity: 88 },
        { voice: 'openhat', midi: 46, startBeat: 3.5, velocity: 84 },
        { voice: 'tom', midi: 45, startBeat: 3.75, velocity: 90 },
      ],
      4,
      32
    ),
  },
  {
    id: 'demo-neon-highway',
    title: 'Electric Horizon',
    artist: 'Studio Session II',
    genre: 'Alt / Indie Rock',
    bpm: 124,
    bars: 8,
    keyRootPc: 4, // E Minor
    keyMode: 'minor',
    chords: [
      { rootPc: 4, quality: 'min', startBeat: 0, durationBeats: 4 },
      { rootPc: 0, quality: 'maj', startBeat: 4, durationBeats: 4 },
      { rootPc: 7, quality: 'maj', startBeat: 8, durationBeats: 4 },
      { rootPc: 2, quality: 'maj', startBeat: 12, durationBeats: 4 },
      { rootPc: 4, quality: 'min', startBeat: 16, durationBeats: 4 },
      { rootPc: 0, quality: 'maj', startBeat: 20, durationBeats: 4 },
      { rootPc: 7, quality: 'maj', startBeat: 24, durationBeats: 4 },
      { rootPc: 11, quality: '7', startBeat: 28, durationBeats: 4 },
    ],
    vocals: repeatPattern(
      [
        { midi: 64, startBeat: 0, durationBeats: 1, velocity: 102 },
        { midi: 67, startBeat: 1, durationBeats: 1, velocity: 106 },
        { midi: 71, startBeat: 2, durationBeats: 1.5, velocity: 112 },
        { midi: 67, startBeat: 4, durationBeats: 1, velocity: 100 },
        { midi: 64, startBeat: 5, durationBeats: 2, velocity: 98 },
        { midi: 62, startBeat: 8, durationBeats: 1, velocity: 104 },
        { midi: 67, startBeat: 9, durationBeats: 1, velocity: 108 },
        { midi: 66, startBeat: 10.5, durationBeats: 1.5, velocity: 102 },
        { midi: 64, startBeat: 12.5, durationBeats: 2, velocity: 100 },
      ],
      16,
      32
    ),
    guitar: repeatPattern(
      [
        { midi: 40, startBeat: 0, durationBeats: 0.5, velocity: 108 },
        { midi: 47, startBeat: 0.5, durationBeats: 0.5, velocity: 104 },
        { midi: 52, startBeat: 1, durationBeats: 0.5, velocity: 106 },
        { midi: 55, startBeat: 1.5, durationBeats: 0.5, velocity: 100 },
        { midi: 52, startBeat: 2, durationBeats: 1, velocity: 104 },
        { midi: 47, startBeat: 3, durationBeats: 0.75, velocity: 98 },
        { midi: 48, startBeat: 4, durationBeats: 0.5, velocity: 108 },
        { midi: 55, startBeat: 4.5, durationBeats: 0.5, velocity: 102 },
        { midi: 60, startBeat: 5, durationBeats: 1, velocity: 106 },
        { midi: 55, startBeat: 6, durationBeats: 1, velocity: 98 },
        { midi: 43, startBeat: 8, durationBeats: 0.5, velocity: 106 },
        { midi: 50, startBeat: 8.5, durationBeats: 0.5, velocity: 102 },
        { midi: 55, startBeat: 9, durationBeats: 1, velocity: 106 },
        { midi: 59, startBeat: 10, durationBeats: 1, velocity: 100 },
        { midi: 50, startBeat: 12, durationBeats: 0.75, velocity: 108 },
        { midi: 57, startBeat: 13, durationBeats: 0.75, velocity: 102 },
        { midi: 62, startBeat: 14, durationBeats: 1.5, velocity: 106 },
      ],
      16,
      32
    ),
    bass: repeatPattern(
      [
        { midi: 28, startBeat: 0, durationBeats: 0.5, velocity: 114 },
        { midi: 28, startBeat: 0.5, durationBeats: 0.5, velocity: 104 },
        { midi: 28, startBeat: 1, durationBeats: 0.5, velocity: 110 },
        { midi: 31, startBeat: 1.5, durationBeats: 0.5, velocity: 102 },
        { midi: 35, startBeat: 2, durationBeats: 1, velocity: 108 },
        { midi: 33, startBeat: 3, durationBeats: 0.75, velocity: 102 },
        { midi: 36, startBeat: 4, durationBeats: 1, velocity: 112 },
        { midi: 36, startBeat: 5.5, durationBeats: 0.5, velocity: 100 },
        { midi: 38, startBeat: 6, durationBeats: 1, velocity: 106 },
        { midi: 36, startBeat: 7, durationBeats: 0.75, velocity: 98 },
        { midi: 31, startBeat: 8, durationBeats: 1, velocity: 112 },
        { midi: 31, startBeat: 9.5, durationBeats: 0.5, velocity: 102 },
        { midi: 35, startBeat: 10, durationBeats: 1.5, velocity: 108 },
        { midi: 38, startBeat: 12, durationBeats: 1, velocity: 112 },
        { midi: 38, startBeat: 13.5, durationBeats: 0.5, velocity: 104 },
        { midi: 36, startBeat: 14, durationBeats: 1, velocity: 106 },
        { midi: 35, startBeat: 15, durationBeats: 0.75, velocity: 100 },
      ],
      16,
      32
    ),
    keyboards: repeatPattern(
      [
        { midi: 52, startBeat: 0, durationBeats: 3.5, velocity: 82 },
        { midi: 59, startBeat: 0, durationBeats: 3.5, velocity: 80 },
        { midi: 64, startBeat: 0, durationBeats: 3.5, velocity: 84 },
        { midi: 48, startBeat: 4, durationBeats: 3.5, velocity: 82 },
        { midi: 55, startBeat: 4, durationBeats: 3.5, velocity: 80 },
        { midi: 60, startBeat: 4, durationBeats: 3.5, velocity: 84 },
        { midi: 55, startBeat: 8, durationBeats: 3.5, velocity: 82 },
        { midi: 59, startBeat: 8, durationBeats: 3.5, velocity: 80 },
        { midi: 62, startBeat: 8, durationBeats: 3.5, velocity: 84 },
        { midi: 50, startBeat: 12, durationBeats: 3.5, velocity: 84 },
        { midi: 57, startBeat: 12, durationBeats: 3.5, velocity: 82 },
        { midi: 62, startBeat: 12, durationBeats: 3.5, velocity: 86 },
      ],
      16,
      32
    ),
    drums: repeatPattern(
      [
        { voice: 'crash', midi: 49, startBeat: 0, velocity: 104 },
        { voice: 'kick', midi: 36, startBeat: 0, velocity: 120 },
        { voice: 'hihat', midi: 42, startBeat: 0.5, velocity: 82 },
        { voice: 'snare', midi: 38, startBeat: 1, velocity: 118 },
        { voice: 'hihat', midi: 42, startBeat: 1, velocity: 90 },
        { voice: 'hihat', midi: 42, startBeat: 1.5, velocity: 82 },
        { voice: 'kick', midi: 36, startBeat: 2, velocity: 116 },
        { voice: 'kick', midi: 36, startBeat: 2.5, velocity: 104 },
        { voice: 'hihat', midi: 42, startBeat: 2.5, velocity: 84 },
        { voice: 'snare', midi: 38, startBeat: 3, velocity: 120 },
        { voice: 'openhat', midi: 46, startBeat: 3.5, velocity: 88 },
      ],
      4,
      32
    ),
  },
  {
    id: 'demo-velvet-cafe',
    title: 'Velvet Morning',
    artist: 'Studio Session III',
    genre: 'Lo-Fi Jazz',
    bpm: 96,
    bars: 8,
    keyRootPc: 0, // C Major
    keyMode: 'major',
    chords: [
      { rootPc: 2, quality: 'm7', startBeat: 0, durationBeats: 4 },
      { rootPc: 7, quality: '7', startBeat: 4, durationBeats: 4 },
      { rootPc: 0, quality: 'maj7', startBeat: 8, durationBeats: 4 },
      { rootPc: 9, quality: 'm7', startBeat: 12, durationBeats: 4 },
      { rootPc: 2, quality: 'm7', startBeat: 16, durationBeats: 4 },
      { rootPc: 7, quality: '7', startBeat: 20, durationBeats: 4 },
      { rootPc: 0, quality: 'maj7', startBeat: 24, durationBeats: 8 },
    ],
    vocals: repeatPattern(
      [
        { midi: 65, startBeat: 0.5, durationBeats: 1.5, velocity: 90 },
        { midi: 69, startBeat: 2, durationBeats: 1.5, velocity: 96 },
        { midi: 67, startBeat: 4, durationBeats: 1.5, velocity: 94 },
        { midi: 65, startBeat: 5.5, durationBeats: 1.5, velocity: 90 },
        { midi: 64, startBeat: 8, durationBeats: 2, velocity: 96 },
        { midi: 67, startBeat: 10, durationBeats: 1.5, velocity: 92 },
        { midi: 69, startBeat: 12, durationBeats: 1.5, velocity: 98 },
        { midi: 67, startBeat: 13.5, durationBeats: 2, velocity: 90 },
      ],
      16,
      32
    ),
    guitar: repeatPattern(
      [
        { midi: 53, startBeat: 0, durationBeats: 1, velocity: 88 },
        { midi: 57, startBeat: 1, durationBeats: 0.75, velocity: 86 },
        { midi: 60, startBeat: 2, durationBeats: 1, velocity: 92 },
        { midi: 64, startBeat: 3, durationBeats: 0.75, velocity: 90 },
        { midi: 59, startBeat: 4, durationBeats: 1, velocity: 88 },
        { midi: 62, startBeat: 5, durationBeats: 1, velocity: 92 },
        { midi: 65, startBeat: 6, durationBeats: 1.5, velocity: 94 },
        { midi: 64, startBeat: 8, durationBeats: 1.5, velocity: 92 },
        { midi: 60, startBeat: 10, durationBeats: 1, velocity: 88 },
        { midi: 55, startBeat: 11, durationBeats: 0.75, velocity: 86 },
        { midi: 57, startBeat: 12, durationBeats: 1.5, velocity: 90 },
        { midi: 60, startBeat: 14, durationBeats: 1.5, velocity: 88 },
      ],
      16,
      32
    ),
    bass: repeatPattern(
      [
        { midi: 38, startBeat: 0, durationBeats: 1, velocity: 104 },
        { midi: 41, startBeat: 1, durationBeats: 1, velocity: 96 },
        { midi: 45, startBeat: 2, durationBeats: 1, velocity: 100 },
        { midi: 40, startBeat: 3, durationBeats: 1, velocity: 94 },
        { midi: 31, startBeat: 4, durationBeats: 1, velocity: 104 },
        { midi: 35, startBeat: 5, durationBeats: 1, velocity: 96 },
        { midi: 38, startBeat: 6, durationBeats: 1, velocity: 100 },
        { midi: 35, startBeat: 7, durationBeats: 1, velocity: 94 },
        { midi: 36, startBeat: 8, durationBeats: 1, velocity: 106 },
        { midi: 40, startBeat: 9, durationBeats: 1, velocity: 96 },
        { midi: 43, startBeat: 10, durationBeats: 1, velocity: 100 },
        { midi: 40, startBeat: 11, durationBeats: 1, velocity: 92 },
        { midi: 33, startBeat: 12, durationBeats: 1, velocity: 104 },
        { midi: 36, startBeat: 13, durationBeats: 1, velocity: 96 },
        { midi: 40, startBeat: 14, durationBeats: 1, velocity: 98 },
        { midi: 37, startBeat: 15, durationBeats: 1, velocity: 92 },
      ],
      16,
      32
    ),
    keyboards: repeatPattern(
      [
        { midi: 50, startBeat: 0, durationBeats: 3, velocity: 84 },
        { midi: 57, startBeat: 0, durationBeats: 3, velocity: 80 },
        { midi: 60, startBeat: 0, durationBeats: 3, velocity: 82 },
        { midi: 64, startBeat: 0, durationBeats: 3, velocity: 80 },
        { midi: 55, startBeat: 4, durationBeats: 3, velocity: 84 },
        { midi: 59, startBeat: 4, durationBeats: 3, velocity: 80 },
        { midi: 62, startBeat: 4, durationBeats: 3, velocity: 82 },
        { midi: 65, startBeat: 4, durationBeats: 3, velocity: 80 },
        { midi: 48, startBeat: 8, durationBeats: 3.5, velocity: 84 },
        { midi: 55, startBeat: 8, durationBeats: 3.5, velocity: 80 },
        { midi: 59, startBeat: 8, durationBeats: 3.5, velocity: 82 },
        { midi: 64, startBeat: 8, durationBeats: 3.5, velocity: 80 },
        { midi: 57, startBeat: 12, durationBeats: 3.5, velocity: 84 },
        { midi: 60, startBeat: 12, durationBeats: 3.5, velocity: 80 },
        { midi: 64, startBeat: 12, durationBeats: 3.5, velocity: 82 },
        { midi: 67, startBeat: 12, durationBeats: 3.5, velocity: 78 },
      ],
      16,
      32
    ),
    drums: repeatPattern(
      [
        { voice: 'kick', midi: 36, startBeat: 0, velocity: 106 },
        { voice: 'hihat', midi: 42, startBeat: 0, velocity: 74 },
        { voice: 'hihat', midi: 42, startBeat: 0.75, velocity: 64 },
        { voice: 'snare', midi: 38, startBeat: 1, velocity: 98 },
        { voice: 'hihat', midi: 42, startBeat: 1.5, velocity: 68 },
        { voice: 'kick', midi: 36, startBeat: 2.25, velocity: 96 },
        { voice: 'hihat', midi: 42, startBeat: 2.5, velocity: 70 },
        { voice: 'snare', midi: 38, startBeat: 3, velocity: 100 },
        { voice: 'openhat', midi: 46, startBeat: 3.5, velocity: 76 },
      ],
      4,
      32
    ),
  },
];

/**
 * Synthesizes a clean stereo AudioBuffer for each stem of a demo song blueprint.
 * Runs synchronously on Float32Arrays (no OfflineAudioContext suspension quirks in headless browsers).
 */
function renderMelodicBuffer(
  ctx: BaseAudioContext,
  notes: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>,
  durationSec: number,
  bpm: number,
  timbre: 'vocals' | 'guitar' | 'bass' | 'keyboards'
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(durationSec * sampleRate);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const secPerBeat = 60 / bpm;

  for (const n of notes) {
    const startIdx = Math.floor(n.startBeat * secPerBeat * sampleRate);
    const noteDurSec = Math.max(0.08, n.durationBeats * secPerBeat);
    const tailSec = timbre === 'keyboards' ? 0.35 : timbre === 'guitar' ? 0.25 : 0.14;
    const totalSamples = Math.min(length - startIdx, Math.floor((noteDurSec + tailSec) * sampleRate));
    if (totalSamples <= 0 || startIdx < 0) continue;

    const freq = midiToFrequency(n.midi);
    const gain = (n.velocity / 127) * (timbre === 'keyboards' ? 0.16 : timbre === 'bass' ? 0.42 : 0.28);

    // Subtle stereo spread by instrument role
    const panL = timbre === 'guitar' ? 0.72 : timbre === 'keyboards' ? 0.42 : 0.5;
    const panR = 1 - panL;

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      let env = 1;
      const attack = timbre === 'vocals' ? 0.045 : timbre === 'guitar' ? 0.008 : 0.012;
      if (t < attack) {
        env = t / attack;
      } else if (t > noteDurSec) {
        env = Math.max(0, 1 - (t - noteDurSec) / tailSec);
      } else if (timbre === 'guitar' || timbre === 'bass') {
        env = Math.exp(-(t - attack) * (timbre === 'guitar' ? 2.6 : 1.4));
      } else if (timbre === 'keyboards') {
        env = 0.65 + 0.35 * Math.exp(-(t - attack) * 2.1);
      }

      let sample = 0;
      const phase = 2 * Math.PI * freq * t;

      if (timbre === 'vocals') {
        // Warm vocal-like formant vibrato tone
        const vib = Math.sin(2 * Math.PI * 5.2 * t) * 0.012 * Math.min(1, t * 3);
        const vp = 2 * Math.PI * freq * (1 + vib) * t;
        sample =
          Math.sin(vp) * 0.62 +
          Math.sin(vp * 2) * 0.26 +
          Math.sin(vp * 3) * 0.12 +
          Math.sin(vp * 4) * 0.05;
      } else if (timbre === 'guitar') {
        // Bright plucked electric guitar harmonics
        const bright = Math.exp(-t * 5.5);
        sample =
          Math.sin(phase) * 0.55 +
          Math.sin(phase * 2) * (0.28 + 0.15 * bright) +
          Math.sin(phase * 3) * (0.18 * bright) +
          Math.sin(phase * 4) * (0.1 * bright);
        sample = Math.tanh(sample * 1.45) * 0.85;
      } else if (timbre === 'bass') {
        // Warm punchy fingerstyle bass with clear 2nd/3rd harmonics (audible on laptop speakers too)
        sample =
          Math.sin(phase) * 0.68 +
          Math.sin(phase * 2) * 0.34 * (0.4 + 0.6 * Math.exp(-t * 2.5)) +
          Math.sin(phase * 3) * 0.16 * Math.exp(-t * 4.5) +
          Math.sin(phase * 4) * 0.08 * Math.exp(-t * 7.0);
      } else {
        // Rhodes electric piano bell + warm fundamental
        const tine = Math.exp(-t * 14);
        sample =
          Math.sin(phase) * 0.74 +
          Math.sin(phase * 2) * 0.18 +
          Math.sin(phase * 7) * 0.12 * tine;
      }

      const v = sample * env * gain;
      left[startIdx + i] += v * (0.5 + panL * 0.5);
      right[startIdx + i] += v * (0.5 + panR * 0.5);
    }
  }

  // Ensure clean headroom (<= 0.72 peak per stem) so summing all 5 stems never clips
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.72) {
    const scale = 0.72 / peak;
    for (let i = 0; i < length; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  return buffer;
}

function renderDrumBuffer(
  ctx: BaseAudioContext,
  hits: Array<{ voice: DrumHitEvent['voice']; midi: number; startBeat: number; velocity: number }>,
  durationSec: number,
  bpm: number
): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.ceil(durationSec * sampleRate);
  const buffer = ctx.createBuffer(2, length, sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const secPerBeat = 60 / bpm;

  // Deterministic pseudo-random noise generator for reproducible cymbals/snares
  let seed = 1337;
  const nextNoise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (const h of hits) {
    const startIdx = Math.floor(h.startBeat * secPerBeat * sampleRate);
    const amp = (h.velocity / 127) * 0.36;
    const dur =
      h.voice === 'crash' ? 0.65 : h.voice === 'openhat' ? 0.26 : h.voice === 'kick' ? 0.24 : 0.16;
    const totalSamples = Math.min(length - startIdx, Math.floor(dur * sampleRate));
    if (totalSamples <= 0 || startIdx < 0) continue;

    let lpPrev = 0;
    let hpPrev = 0;
    let prevIn = 0;

    for (let i = 0; i < totalSamples; i++) {
      const t = i / sampleRate;
      let s = 0;

      if (h.voice === 'kick') {
        const pitchEnv = 145 * Math.exp(-t * 34) + 48;
        const bodyEnv = Math.exp(-t * 14);
        const click = Math.exp(-t * 180) * nextNoise() * 0.16;
        s = (Math.sin(2 * Math.PI * pitchEnv * t) * bodyEnv + click) * 1.05;
      } else if (h.voice === 'snare') {
        const noise = nextNoise();
        hpPrev = 0.72 * (hpPrev + noise - prevIn);
        prevIn = noise;
        const body = Math.sin(2 * Math.PI * 195 * t) * Math.exp(-t * 24) * 0.62;
        const wires = hpPrev * Math.exp(-t * 17) * 0.68;
        s = body + wires;
      } else if (h.voice === 'tom') {
        const f = 140 * Math.exp(-t * 12) + 88;
        s = Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 11) * 0.8;
      } else {
        // Hi-hat / openhat / crash metallic high-passed noise
        const noise = nextNoise();
        hpPrev = 0.85 * (hpPrev + noise - prevIn);
        prevIn = noise;
        lpPrev = lpPrev + 0.4 * (hpPrev - lpPrev);
        const decay = h.voice === 'crash' ? 4.5 : h.voice === 'openhat' ? 11 : 48;
        s = (hpPrev - lpPrev * 0.5) * Math.exp(-t * decay) * (h.voice === 'crash' ? 0.52 : 0.36);
      }

      const v = s * amp;
      const panL = h.voice === 'hihat' ? 0.62 : h.voice === 'crash' ? 0.35 : 0.5;
      left[startIdx + i] += v * (0.5 + panL * 0.5);
      right[startIdx + i] += v * (0.5 + (1 - panL) * 0.5);
    }
  }

  let peak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  if (peak > 0.72) {
    const scale = 0.72 / peak;
    for (let i = 0; i < length; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  return buffer;
}

export function buildDemoSongProject(
  blueprint: DemoSongBlueprint,
  ctx: BaseAudioContext
): SongProject {
  const totalBeats = blueprint.bars * 4;
  const duration = (totalBeats * 60) / blueprint.bpm;

  const buffers: Record<StemId, AudioBuffer> = {
    vocals: renderMelodicBuffer(ctx, blueprint.vocals, duration, blueprint.bpm, 'vocals'),
    guitar: renderMelodicBuffer(ctx, blueprint.guitar, duration, blueprint.bpm, 'guitar'),
    bass: renderMelodicBuffer(ctx, blueprint.bass, duration, blueprint.bpm, 'bass'),
    drums: renderDrumBuffer(ctx, blueprint.drums, duration, blueprint.bpm),
    keyboards: renderMelodicBuffer(ctx, blueprint.keyboards, duration, blueprint.bpm, 'keyboards'),
  };

  const stems = {} as Record<StemId, StemTrackData>;
  (Object.keys(buffers) as StemId[]).forEach((id) => {
    const ch = buffers[id].getChannelData(0);
    stems[id] = {
      id,
      buffer: buffers[id],
      peaks: computeWaveformPeaks(ch, 180),
      rmsLevel: computeRms(ch),
    };
  });

  const toMidi = (
    list: Array<{ midi: number; startBeat: number; durationBeats: number; velocity: number }>,
    prefix: string
  ): MidiNoteEvent[] =>
    list.map((n, idx) => ({
      id: `${prefix}-${idx + 1}`,
      midi: n.midi,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
      channel: 0,
      label: midiToNoteName(n.midi),
    }));

  const drumHits: DrumHitEvent[] = blueprint.drums.map((d, idx) => ({
    id: `drum-${idx + 1}`,
    voice: d.voice,
    midi: d.midi,
    startBeat: d.startBeat,
    velocity: d.velocity,
  }));

  const chords: ChordEvent[] = blueprint.chords.map((c, idx) => ({
    id: `chord-${idx + 1}`,
    symbol: formatChordSymbol(c.rootPc, c.quality),
    rootPc: c.rootPc,
    quality: c.quality,
    startBeat: c.startBeat,
    durationBeats: c.durationBeats,
  }));

  return {
    id: blueprint.id,
    title: blueprint.title,
    artist: `${blueprint.artist} · ${blueprint.genre}`,
    sourceType: 'demo',
    fileFormat: 'Studio Multi-Stem',
    duration,
    bpm: blueprint.bpm,
    timeSignature: [4, 4],
    keyRootPc: blueprint.keyRootPc,
    keyMode: blueprint.keyMode,
    stems,
    keyboardMidi: toMidi(blueprint.keyboards, 'keys'),
    drumHits,
    guitarNotes: toMidi(blueprint.guitar, 'gtr'),
    bassNotes: toMidi(blueprint.bass, 'bass'),
    chords,
  };
}
