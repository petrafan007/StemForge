import type { ChordEvent, NotationPart, SongProject, StemId, StringInstrument } from '../types/music';
import { getChordVoicing } from './notationEngine';
import { barPosition } from './bars';
import type { PartVoice } from './pluckSynth';

/**
 * "Hear the part" on Tabs & Sheet: the notes of the tab / sheet music / chord chart played by a synth,
 * instead of, together with, or without the recording.
 */

/** recording = the song as is; midi = the part's synth replaces its recorded track; both = synth on
 * top of the recording; solo = only the synth. */
export type PartListen = 'recording' | 'midi' | 'both' | 'solo';

export interface PartPlayback {
  voices: PartVoice[]; // sorted by beat
  instrument: StringInstrument;
  /** The part's recorded track(s), silenced in 'midi' mode. */
  stems: StemId[];
  listen: Exclude<PartListen, 'recording'>;
}

/** The recorded tracks a part was transcribed from (the ones its synth replaces). */
export function partStems(project: SongProject, part: NotationPart): StemId[] {
  const has = (id: StemId) => Boolean(project.stems[id]);
  const guitars = (['guitar', 'guitar1', 'guitar2'] as StemId[]).filter(has);
  if (part === 'bass') return has('bass') ? ['bass'] : [];
  if (part === 'lead') return has('lead') ? ['lead'] : guitars;
  if (part === 'guitar1' || part === 'guitar2') return has(part) ? [part] : guitars;
  return guitars;
}

/** Notes (shown pitch, beats) as voices, sorted by start. */
export function notesToVoices(notes: Array<{ beat: number; endBeat: number; midi: number; velocity: number }>): PartVoice[] {
  return notes
    .map((n) => ({ beat: n.beat, endBeat: Math.max(n.endBeat, n.beat + 0.05), midi: n.midi, velocity: n.velocity }))
    .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}

/** Open strings of the standard tunings the chord diagrams are drawn in (low to high). */
const DIAGRAM_OPEN: Record<StringInstrument, number[]> = {
  guitar: [40, 45, 50, 55, 59, 64],
  bass: [28, 33, 38, 43],
};

/** The pitches of a chord diagram, low to high (bass: just the root, the lowest note of the box). */
export function voicingPitches(chord: Pick<ChordEvent, 'rootPc' | 'quality'>, instrument: StringInstrument, transpose: number): number[] {
  const v = getChordVoicing(chord.rootPc, chord.quality, instrument, transpose);
  const open = DIAGRAM_OPEN[instrument];
  const pitches = v.frets.map((f, s) => (f >= 0 && s < open.length ? open[s] + f : -1)).filter((m) => m >= 0);
  return instrument === 'bass' ? pitches.slice(0, 1) : pitches;
}

/**
 * The chord chart as strums: each chord is strummed (low to high, `strumBeats` apart) where it starts
 * and again at every bar line while it lasts; bass plays the root.
 */
export function chordVoices(
  chords: ChordEvent[],
  instrument: StringInstrument,
  transpose: number,
  barStarts: number[],
  beatsPerMeasure: number,
  strumBeats: number
): PartVoice[] {
  const out: PartVoice[] = [];
  const sorted = [...chords].sort((a, b) => a.startBeat - b.startBeat);
  sorted.forEach((c, i) => {
    const end = Math.max(c.startBeat + 0.25, Math.min(c.startBeat + c.durationBeats, sorted[i + 1]?.startBeat ?? Number.POSITIVE_INFINITY));
    const pitches = voicingPitches(c, instrument, transpose);
    if (!pitches.length) return;
    let at = c.startBeat;
    for (let guard = 0; at < end - 1e-6 && guard < 256; guard++) {
      const bar = barPosition(barStarts, at + 1e-6, beatsPerMeasure);
      const next = Math.min(end, bar.start + bar.length);
      const accent = Math.abs(at - bar.start) < 1e-6;
      pitches.forEach((midi, k) => out.push({ beat: at + k * strumBeats, endBeat: next, midi, velocity: accent ? 96 : 84 }));
      at = next;
    }
  });
  return out.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
}
