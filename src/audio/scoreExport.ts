import type { BassTuningId, GuitarTuningId, MidiNoteEvent, NotationPart, SongProject } from '../types/music';
import { encodeMusicXml, type MusicXmlPartInput } from './musicXml';
import { BASS_TUNINGS, GUITAR_TUNINGS, detectTuning, generateAsciiTab, mapNotesToTab, type TuningPreset } from './notationEngine';
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

export function partNotes(project: SongProject, part: NotationPart): MidiNoteEvent[] {
  return part === 'guitar' ? project.guitarNotes : part === 'lead' ? project.leadNotes : project.bassNotes;
}

export function partLabel(project: SongProject, part: NotationPart): string {
  if (part === 'bass') return 'Bass';
  if (part === 'lead') return 'Lead Guitar';
  return project.stems.lead ? 'Rhythm Guitar' : 'Guitar';
}

export type ScorePartId = 'vocals' | 'guitar' | 'lead' | 'bass' | 'keyboards';

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
        abbreviation: part === 'bass' ? 'Bass' : part === 'lead' ? 'Ld. Gtr.' : 'Gtr.',
        clef: part === 'bass' ? 'bass' : 'guitar',
        octaveDown: true,
        ...(opts.includeTab ? { tab: { tuning, notes: tab } } : { notes: tab.map((n) => ({ id: n.id, midi: n.midi, startBeat: n.startBeat, durationBeats: n.durationBeats, velocity: n.velocity, channel: 0 })) }),
        midiProgram: part === 'bass' ? 33 : 30,
        midiChannel: part === 'bass' ? 2 : part === 'lead' ? 4 : 1,
      });
    }
  }
  if (parts.length === 0) throw new Error('There are no transcribed notes in the selected parts.');
  return encodeMusicXml({
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
    Math.max(1, Math.round(quarterBeatsPerMeasure(project.timeSignature)))
  );
}
