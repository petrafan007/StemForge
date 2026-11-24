import type {
  ChordEvent,
  DrumHitEvent,
  DrumTuple,
  DrumVoice,
  GuitarSides,
  MelodicStemId,
  MidiNoteEvent,
  NoteTuple,
  RawTranscription,
} from '../types/music';
import { detectChordFromChroma, formatChordSymbol, midiToNoteName } from './notationEngine';
import { type BeatGrid, quarterBeatsPerMeasure, timeToBeat } from './timeline';

/**
 * Turns the server's seconds-based transcription into the studio's beat-based notes,
 * cleans up distorted-guitar artifacts, and derives chords and the song key.
 */

export interface DeriveOptions {
  simplifyPowerChords: boolean;
  timeSignature: [number, number];
}

export interface DerivedMusic {
  keyboardMidi: MidiNoteEvent[];
  guitarNotes: MidiNoteEvent[];
  /** Left / right rhythm guitar on its own (only when the transcription has separate parts). */
  guitarParts?: GuitarSides<MidiNoteEvent>;
  leadNotes: MidiNoteEvent[];
  bassNotes: MidiNoteEvent[];
  vocalNotes: MidiNoteEvent[];
  drumHits: DrumHitEvent[];
  chords: ChordEvent[];
  key: { rootPc: number; mode: 'major' | 'minor' } | null;
}

/** Overtone intervals (semitones above the root) that distortion makes the transcriber hear as notes. */
const DISTORTION_HARMONICS = new Set([19, 24, 28, 31, 36]);

/**
 * Cleans distorted guitar transcriptions: within a chord (notes starting together), removes notes that
 * sit on overtones of the lowest note (12th, 2 octaves, 17th, 19th...) so power chords read as
 * root + fifth (+ octave) instead of a cluster.
 */
export function simplifyPowerChords(notes: NoteTuple[], windowSec = 0.04): NoteTuple[] {
  if (notes.length === 0) return notes;
  const sorted = [...notes].sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  const out: NoteTuple[] = [];
  let i = 0;
  while (i < sorted.length) {
    const group: NoteTuple[] = [sorted[i]];
    let j = i + 1;
    while (j < sorted.length && sorted[j][0] - sorted[i][0] <= windowSec) {
      group.push(sorted[j]);
      j++;
    }
    if (group.length === 1) {
      out.push(group[0]);
    } else {
      const root = group.reduce((lo, n) => (n[2] < lo[2] ? n : lo), group[0]);
      for (const n of group) {
        const interval = n[2] - root[2];
        if (n !== root && DISTORTION_HARMONICS.has(interval) && n[3] <= root[3] * 1.25) continue;
        out.push(n);
      }
    }
    i = j;
  }
  return out;
}

export function tuplesToMidiEvents(tuples: NoteTuple[] | undefined, grid: BeatGrid, prefix: string, channel = 0): MidiNoteEvent[] {
  if (!tuples || tuples.length === 0) return [];
  const events: MidiNoteEvent[] = [];
  tuples.forEach(([start, end, midi, velocity], idx) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const startBeat = timeToBeat(grid, start);
    if (startBeat < -0.25) return;
    const pitch = Math.max(0, Math.min(127, Math.round(midi)));
    events.push({
      id: `${prefix}-${idx + 1}`,
      midi: pitch,
      startBeat: Math.max(0, startBeat),
      durationBeats: Math.max(0.0625, timeToBeat(grid, end) - startBeat),
      velocity: Math.max(1, Math.min(127, Math.round(velocity))),
      channel,
      label: midiToNoteName(pitch),
    });
  });
  return events.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

const GM_TO_VOICE: Record<number, DrumVoice> = {
  35: 'kick',
  36: 'kick',
  38: 'snare',
  40: 'snare',
  42: 'hihat',
  44: 'hihat',
  46: 'openhat',
  41: 'tom',
  43: 'tom',
  45: 'tom',
  47: 'tom',
  48: 'tom',
  50: 'tom',
  49: 'crash',
  51: 'crash',
  52: 'crash',
  55: 'crash',
  57: 'crash',
};

const VOICE_TO_GM: Record<DrumVoice, number> = { kick: 36, snare: 38, hihat: 42, openhat: 46, tom: 45, crash: 49 };

export function drumTuplesToHits(tuples: DrumTuple[] | undefined, grid: BeatGrid): DrumHitEvent[] {
  if (!tuples) return [];
  const hits: DrumHitEvent[] = [];
  tuples.forEach(([time, midi, velocity], idx) => {
    const voice = GM_TO_VOICE[Math.round(midi)];
    if (!voice) return;
    const startBeat = timeToBeat(grid, time);
    if (startBeat < -0.25) return;
    hits.push({
      id: `drum-${idx + 1}`,
      voice,
      midi: VOICE_TO_GM[voice],
      startBeat: Math.max(0, startBeat),
      velocity: Math.max(1, Math.min(127, Math.round(velocity))),
    });
  });
  return hits.sort((a, b) => a.startBeat - b.startBeat);
}

/** Krumhansl-Kessler key profiles. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function detectKey(noteSets: MidiNoteEvent[][]): { rootPc: number; mode: 'major' | 'minor' } | null {
  const hist = new Array<number>(12).fill(0);
  let total = 0;
  for (const set of noteSets) {
    for (const n of set) {
      const w = Math.min(4, n.durationBeats) * (n.velocity / 127);
      hist[((n.midi % 12) + 12) % 12] += w;
      total += w;
    }
  }
  if (total <= 0) return null;
  let best: { rootPc: number; mode: 'major' | 'minor'; score: number } = { rootPc: 0, mode: 'major', score: -2 };
  for (let root = 0; root < 12; root++) {
    const rotated = hist.map((_, i) => hist[(i + root) % 12]);
    const maj = correlation(rotated, MAJOR_PROFILE);
    const min = correlation(rotated, MINOR_PROFILE);
    if (maj > best.score) best = { rootPc: root, mode: 'major', score: maj };
    if (min > best.score) best = { rootPc: root, mode: 'minor', score: min };
  }
  return { rootPc: best.rootPc, mode: best.mode };
}

/**
 * Chord progression from the transcribed notes: half-bar windows, duration/velocity weighted
 * pitch classes (bass notes count extra toward the root), template matching incl. power chords.
 */
export function chordsFromNotes(
  harmonic: MidiNoteEvent[][],
  bass: MidiNoteEvent[],
  timeSignature: [number, number],
  totalBeats: number
): ChordEvent[] {
  const window = Math.max(1, quarterBeatsPerMeasure(timeSignature) / 2);
  const chords: ChordEvent[] = [];
  const all = harmonic.flat();
  let id = 1;
  for (let start = 0; start < totalBeats; start += window) {
    const end = start + window;
    const chroma = new Array<number>(12).fill(0);
    let weight = 0;
    const add = (n: MidiNoteEvent, factor: number) => {
      const overlap = Math.min(end, n.startBeat + n.durationBeats) - Math.max(start, n.startBeat);
      if (overlap <= 0) return;
      const w = overlap * (n.velocity / 127) * factor;
      chroma[((n.midi % 12) + 12) % 12] += w;
      weight += w;
    };
    for (const n of all) add(n, 1);
    for (const n of bass) add(n, 1.6);
    if (weight < window * 0.25) continue;
    const det = detectChordFromChroma(chroma);
    if (det.confidence < 0.2) continue;
    const prev = chords[chords.length - 1];
    if (prev && prev.rootPc === det.rootPc && prev.quality === det.quality && Math.abs(prev.startBeat + prev.durationBeats - start) < 1e-6) {
      prev.durationBeats += window;
      continue;
    }
    chords.push({
      id: `chord-${id++}`,
      symbol: formatChordSymbol(det.rootPc, det.quality),
      rootPc: det.rootPc,
      quality: det.quality,
      startBeat: start,
      durationBeats: window,
    });
  }
  return chords;
}

export function deriveMusic(raw: RawTranscription, grid: BeatGrid, durationSec: number, opts: DeriveOptions): DerivedMusic {
  const n = raw.notes;
  const clean = (stem: MelodicStemId) => {
    const tuples = n[stem] ?? [];
    return (stem === 'guitar' || stem === 'lead') && opts.simplifyPowerChords ? simplifyPowerChords(tuples) : tuples;
  };
  const keyboardMidi = tuplesToMidiEvents(clean('keyboards'), grid, 'keys');
  const guitarNotes = tuplesToMidiEvents(clean('guitar'), grid, 'gtr');
  // the left / right guitars get the same clean-up as the rhythm guitar part they make up together
  const side = (tuples: NoteTuple[], prefix: string) =>
    tuplesToMidiEvents(opts.simplifyPowerChords ? simplifyPowerChords(tuples) : tuples, grid, prefix);
  const guitarParts = raw.guitarParts
    ? { left: side(raw.guitarParts.left ?? [], 'gtr1'), right: side(raw.guitarParts.right ?? [], 'gtr2') }
    : undefined;
  const leadNotes = tuplesToMidiEvents(clean('lead'), grid, 'lead');
  const bassNotes = tuplesToMidiEvents(clean('bass'), grid, 'bass');
  const vocalNotes = tuplesToMidiEvents(clean('vocals'), grid, 'vox');
  const drumHits = drumTuplesToHits(raw.drums, grid);
  const beats = Math.ceil(timeToBeat(grid, durationSec));
  const chords = chordsFromNotes([guitarNotes, leadNotes, keyboardMidi], bassNotes, opts.timeSignature, beats);
  const key = detectKey([guitarNotes, leadNotes, keyboardMidi, bassNotes, vocalNotes]);
  // chords and key come from the combined parts only (the left / right parts are subsets of guitarNotes)
  return { keyboardMidi, guitarNotes, guitarParts, leadNotes, bassNotes, vocalNotes, drumHits, chords, key };
}
