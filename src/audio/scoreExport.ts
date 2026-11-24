import type { BassTuningId, GuitarTuningId, MidiNoteEvent, NotationPart, SongProject } from '../types/music';
import { encodeMusicXml, type MusicXmlPartInput } from './musicXml';
import { BASS_TUNINGS, GUITAR_TUNINGS, detectTuning, generateAsciiTab, mapNotesToTab, type TuningPreset } from './notationEngine';
import { barStartsFor } from './bars';
import { quarterBeatsPerMeasure } from './timeline';

export interface TuningChoice {
  guitar: GuitarTuningId | 'auto';
  bass: BassTuningId | 'auto';
}

export interface TuningOptions {
  allowExtendedRangeGuitar: boolean;
  allowFiveStringBass: boolean;
}

export interface ResolvedTunings {
  guitar: TuningPreset;
  lead: TuningPreset;
  bass: TuningPreset;
  detectedGuitar: TuningPreset;
  detectedBass: TuningPreset;
}

export function guitarCandidates(opts: TuningOptions): TuningPreset[] {
  return Object.values(GUITAR_TUNINGS).filter((t) => opts.allowExtendedRangeGuitar || t.openMidi.length === 6);
}

export function bassCandidates(opts: TuningOptions): TuningPreset[] {
  return Object.values(BASS_TUNINGS).filter((t) => opts.allowFiveStringBass || t.openMidi.length === 4);
}

/** Resolves "Auto" tunings by analysing the transcribed notes (transposition applied). */
export function resolveTunings(project: SongProject, choice: TuningChoice, opts: TuningOptions, transpose = 0): ResolvedTunings {
  const shift = (list: MidiNoteEvent[]) => (transpose ? list.map((n) => ({ ...n, midi: n.midi + transpose })) : list);
  const detectedGuitar = detectTuning(shift([...project.guitarNotes, ...project.leadNotes]), guitarCandidates(opts));
  const detectedBass = detectTuning(shift(project.bassNotes), bassCandidates(opts));
  const guitar = choice.guitar === 'auto' ? detectedGuitar : GUITAR_TUNINGS[choice.guitar] ?? detectedGuitar;
  const bass = choice.bass === 'auto' ? detectedBass : BASS_TUNINGS[choice.bass] ?? detectedBass;
  return { guitar, lead: guitar, bass, detectedGuitar, detectedBass };
}

/** True when the left and right rhythm guitars have their own parts (they play different parts somewhere). */
export function hasGuitarSides(project: SongProject): boolean {
  const sides = project.guitarParts;
  return Boolean(sides && (sides.left.length > 0 || sides.right.length > 0));
}

/** Tab / score parts of a project, in display order: guitar (both), guitar 1 / 2, lead, bass. */
export function notationParts(project: SongProject): NotationPart[] {
  return [
    'guitar',
    ...(hasGuitarSides(project) ? (['guitar1', 'guitar2'] as NotationPart[]) : []),
    ...(project.stems.lead ? (['lead'] as NotationPart[]) : []),
    'bass',
  ];
}

export function partNotes(project: SongProject, part: NotationPart): MidiNoteEvent[] {
  switch (part) {
    case 'guitar':
      return project.guitarNotes;
    case 'guitar1':
      return project.guitarParts?.left ?? [];
    case 'guitar2':
      return project.guitarParts?.right ?? [];
    case 'lead':
      return project.leadNotes;
    case 'bass':
      return project.bassNotes;
  }
}

export function partLabel(project: SongProject, part: NotationPart): string {
  if (part === 'bass') return 'Bass';
  if (part === 'lead') return 'Lead Guitar';
  const guitar = project.stems.lead ? 'Rhythm Guitar' : 'Guitar';
  if (part === 'guitar1') return `${guitar} 1 – Left`;
  if (part === 'guitar2') return `${guitar} 2 – Right`;
  return guitar;
}

export type ScorePartId = 'vocals' | 'keyboards' | NotationPart;

const PART_ABBREVIATION: Record<NotationPart, string> = { guitar: 'Gtr.', guitar1: 'Gtr. 1', guitar2: 'Gtr. 2', lead: 'Ld. Gtr.', bass: 'Bass' };
/** 0-based MIDI channels per part (keys 0, guitar 1, bass 2, vocals 3, lead 4, guitar 1 / 2: 5 / 6). */
const PART_CHANNEL: Record<NotationPart, number> = { guitar: 1, guitar1: 5, guitar2: 6, lead: 4, bass: 2 };

export interface ScoreExportOptions {
  parts: ScorePartId[];
  includeTab: boolean;
  transpose: number;
  tunings: ResolvedTunings;
  maxFret: number;
  accidentals: 'auto' | 'sharps' | 'flats';
  includeChords?: boolean;
}

export function buildMusicXml(project: SongProject, opts: ScoreExportOptions): string {
  const t = opts.transpose;
  const shift = (list: MidiNoteEvent[], lo: number, hi: number) =>
    list.map((n) => ({ ...n, midi: Math.max(lo, Math.min(hi, n.midi + t)) }));
  const parts: MusicXmlPartInput[] = [];
  let idx = 1;
  const pid = () => `P${idx++}`;
  for (const part of opts.parts) {
    if (part === 'vocals') {
      if (!project.vocalNotes.length) continue;
      parts.push({ id: pid(), name: 'Vocals', abbreviation: 'Vox.', clef: 'treble', notes: shift(project.vocalNotes, 36, 96), midiProgram: 52, midiChannel: 3 });
    } else if (part === 'keyboards') {
      if (!project.keyboardMidi.length) continue;
      parts.push({ id: pid(), name: 'Keyboards', abbreviation: 'Keys', clef: 'grand', notes: shift(project.keyboardMidi, 21, 108), midiProgram: 0, midiChannel: 0 });
    } else {
      const notes = partNotes(project, part);
      if (!notes.length) continue;
      const tuning = part === 'bass' ? opts.tunings.bass : opts.tunings.guitar;
      const tab = mapNotesToTab(notes, tuning, t, opts.maxFret);
      const name = `${partLabel(project, part)} (${tuning.label.split(' (')[0]})`;
      parts.push({
        id: pid(),
        name,
        abbreviation: PART_ABBREVIATION[part],
        clef: part === 'bass' ? 'bass' : 'guitar',
        octaveDown: true,
        ...(opts.includeTab ? { tab: { tuning, notes: tab } } : { notes: tab.map((n) => ({ id: n.id, midi: n.midi, startBeat: n.startBeat, durationBeats: n.durationBeats, velocity: n.velocity, channel: 0 })) }),
        midiProgram: part === 'bass' ? 33 : 30,
        midiChannel: PART_CHANNEL[part],
      });
    }
  }
  if (parts.length === 0) throw new Error('There are no transcribed notes in the selected parts.');
  return encodeMusicXml({
    barStarts: barStartsFor(project),
    title: project.title,
    subtitle: 'Transcribed with StemForge',
    bpm: project.bpm,
    keyRootPc: (((project.keyRootPc + t) % 12) + 12) % 12,
    keyMode: project.keyMode,
    timeSignature: project.timeSignature,
    accidentals: opts.accidentals,
    chords: opts.includeChords === false ? [] : project.chords.map((c) => ({ startBeat: c.startBeat, rootPc: (((c.rootPc + t) % 12) + 12) % 12, quality: c.quality })),
    parts,
  });
}

export function buildAsciiTab(project: SongProject, part: NotationPart, tuning: TuningPreset, transpose: number, maxFret: number): string {
  const tab = mapNotesToTab(partNotes(project, part), tuning, transpose, maxFret);
  return generateAsciiTab(
    tab,
    tuning,
    `${project.title} (${partLabel(project, part)})`,
    project.bpm,
    quarterBeatsPerMeasure(project.timeSignature),
    4,
    barStartsFor(project)
  );
}
