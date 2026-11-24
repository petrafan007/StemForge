import type { MidiNoteEvent, TabNoteEvent } from '../types/music';
import type { TuningPreset } from './notationEngine';

/**
 * MusicXML 4.0 (partwise) score writer.
 *
 * Produces files that open in MuseScore, Guitar Pro, Sibelius, Finale, Dorico, etc.
 * - Guitar / bass parts get a standard-notation staff plus a TAB staff (string + fret).
 * - Keyboards get a grand staff (split at middle C).
 * - Notes are quantized to a 16th-note grid; simultaneous notes become chords.
 */

export type MusicXmlClef = 'treble' | 'bass' | 'guitar' | 'grand';

export interface MusicXmlPartInput {
  id: string; // e.g. 'P1'
  name: string;
  abbreviation?: string;
  clef: MusicXmlClef;
  /** Beat-based notes (sounding pitch). Ignored when `tab` is given (tab notes are used instead). */
  notes?: MidiNoteEvent[];
  /** Adds a TAB staff under the notation staff. */
  tab?: { tuning: TuningPreset; notes: TabNoteEvent[] };
  /** Sounds an octave lower than written (guitar & bass convention). */
  octaveDown?: boolean;
  midiProgram?: number; // General MIDI program, 0-based
  midiChannel?: number; // 0-based
}

export interface MusicXmlScoreInput {
  title: string;
  subtitle?: string;
  bpm: number;
  keyRootPc: number;
  keyMode: 'major' | 'minor';
  beatsPerMeasure?: number;
  parts: MusicXmlPartInput[];
}

const DIVISIONS = 4; // divisions per quarter note -> 16th-note resolution
const ALLOWED_DURATIONS = [16, 12, 8, 6, 4, 3, 2, 1];
const TYPE_FOR_DURATION: Record<number, { type: string; dots: number }> = {
  16: { type: 'whole', dots: 0 },
  12: { type: 'half', dots: 1 },
  8: { type: 'half', dots: 0 },
  6: { type: 'quarter', dots: 1 },
  4: { type: 'quarter', dots: 0 },
  3: { type: 'eighth', dots: 1 },
  2: { type: 'eighth', dots: 0 },
  1: { type: '16th', dots: 0 },
};

const SHARP_SPELLING: Array<[string, number]> = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
];
const FLAT_SPELLING: Array<[string, number]> = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
];

// Circle-of-fifths position for each major-key tonic pitch class
const MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];

export function keyToFifths(rootPc: number, mode: 'major' | 'minor'): number {
  const majorPc = mode === 'minor' ? (rootPc + 3) % 12 : rootPc;
  return MAJOR_FIFTHS[((majorPc % 12) + 12) % 12];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Splits a duration (in divisions) into notatable values, largest first. */
export function splitDuration(total: number): number[] {
  const out: number[] = [];
  let remaining = Math.max(0, Math.round(total));
  while (remaining > 0) {
    const piece = ALLOWED_DURATIONS.find((d) => d <= remaining) ?? 1;
    out.push(piece);
    remaining -= piece;
  }
  return out;
}

interface VPitch {
  midi: number; // written pitch
  string?: number; // 1 = highest string
  fret?: number;
}

interface VItem {
  start: number; // divisions
  dur: number;
  pitches: VPitch[];
}

interface SourceNote {
  startBeat: number;
  durationBeats: number;
  pitch: VPitch;
}

/** Quantizes notes to the grid and turns them into a non-overlapping chord timeline. */
export function buildTimeline(notes: SourceNote[]): VItem[] {
  const byStart = new Map<number, { maxDur: number; pitches: Map<number, VPitch> }>();
  for (const n of notes) {
    const start = Math.max(0, Math.round(n.startBeat * DIVISIONS));
    const dur = Math.max(1, Math.round(n.durationBeats * DIVISIONS));
    let slot = byStart.get(start);
    if (!slot) {
      slot = { maxDur: 0, pitches: new Map() };
      byStart.set(start, slot);
    }
    slot.maxDur = Math.max(slot.maxDur, dur);
    if (!slot.pitches.has(n.pitch.midi)) slot.pitches.set(n.pitch.midi, n.pitch);
  }

  const starts = [...byStart.keys()].sort((a, b) => a - b);
  const items: VItem[] = [];
  starts.forEach((start, i) => {
    const slot = byStart.get(start)!;
    const next = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
    const dur = Math.max(1, Math.min(slot.maxDur, next - start));
    const pitches = [...slot.pitches.values()].sort((a, b) => a.midi - b.midi);
    items.push({ start, dur, pitches });
  });
  return items;
}

interface Segment {
  dur: number;
  pitches: VPitch[] | null; // null = rest
  tieStart: boolean;
  tieStop: boolean;
}

function segmentsForMeasure(items: VItem[], mStart: number, mLen: number): Segment[] | 'empty' {
  const mEnd = mStart + mLen;
  const segs: Segment[] = [];
  let cursor = mStart;
  let any = false;

  const pushRest = (len: number) => {
    for (const d of splitDuration(len)) segs.push({ dur: d, pitches: null, tieStart: false, tieStop: false });
  };

  for (const item of items) {
    const itemEnd = item.start + item.dur;
    if (itemEnd <= mStart || item.start >= mEnd) continue;
    any = true;
    const segStart = Math.max(item.start, mStart);
    const segEnd = Math.min(itemEnd, mEnd);
    if (segStart > cursor) pushRest(segStart - cursor);
    const pieces = splitDuration(segEnd - segStart);
    pieces.forEach((d, k) => {
      segs.push({
        dur: d,
        pitches: item.pitches,
        tieStop: k > 0 || (k === 0 && item.start < mStart),
        tieStart: k < pieces.length - 1 || (k === pieces.length - 1 && itemEnd > mEnd),
      });
    });
    cursor = segEnd;
  }
  if (!any) return 'empty';
  if (cursor < mEnd) pushRest(mEnd - cursor);
  return segs;
}

function pitchXml(midi: number, useFlats: boolean): string {
  const pc = ((midi % 12) + 12) % 12;
  const [step, alter] = (useFlats ? FLAT_SPELLING : SHARP_SPELLING)[pc];
  const octave = Math.floor(midi / 12) - 1;
  return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
}

function renderSegments(
  segs: Segment[] | 'empty',
  mLen: number,
  staff: number,
  voice: number,
  useFlats: boolean,
  withTechnical: boolean
): string[] {
  if (segs === 'empty') {
    return [
      `<note><rest measure="yes"/><duration>${mLen}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`,
    ];
  }
  const out: string[] = [];
  for (const seg of segs) {
    const t = TYPE_FOR_DURATION[seg.dur];
    const typeXml = `<type>${t.type}</type>${'<dot/>'.repeat(t.dots)}`;
    if (!seg.pitches) {
      out.push(
        `<note><rest/><duration>${seg.dur}</duration><voice>${voice}</voice>${typeXml}<staff>${staff}</staff></note>`
      );
      continue;
    }
    seg.pitches.forEach((p, idx) => {
      const ties =
        (seg.tieStop ? '<tie type="stop"/>' : '') + (seg.tieStart ? '<tie type="start"/>' : '');
      const tied =
        (seg.tieStop ? '<tied type="stop"/>' : '') + (seg.tieStart ? '<tied type="start"/>' : '');
      const technical =
        withTechnical && p.string !== undefined && p.fret !== undefined
          ? `<technical><string>${p.string}</string><fret>${p.fret}</fret></technical>`
          : '';
      const notations = tied || technical ? `<notations>${tied}${technical}</notations>` : '';
      out.push(
        `<note>${idx > 0 ? '<chord/>' : ''}${pitchXml(p.midi, useFlats)}<duration>${seg.dur}</duration>${ties}<voice>${voice}</voice>${typeXml}<staff>${staff}</staff>${notations}</note>`
      );
    });
  }
  return out;
}

const STEP_NAMES = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const STEP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

function staffTuningXml(tuning: TuningPreset): string {
  // MusicXML staff-tuning line 1 = lowest (bottom) string
  const lowToHigh = [...tuning.openMidi].reverse();
  return lowToHigh
    .map((midi, i) => {
      const pc = ((midi % 12) + 12) % 12;
      const alter = STEP_ALTER[pc] ? `<tuning-alter>${STEP_ALTER[pc]}</tuning-alter>` : '';
      return `<staff-tuning line="${i + 1}"><tuning-step>${STEP_NAMES[pc]}</tuning-step>${alter}<tuning-octave>${Math.floor(midi / 12) - 1}</tuning-octave></staff-tuning>`;
    })
    .join('');
}

interface StaffPlan {
  staff: number;
  voice: number;
  items: VItem[];
  technical: boolean;
  clefXml: string;
  detailsXml?: string;
}

function planPart(part: MusicXmlPartInput): StaffPlan[] {
  const shift = part.octaveDown ? 12 : 0;

  if (part.tab) {
    const src: SourceNote[] = part.tab.notes.map((n) => ({
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      pitch: { midi: n.midi + shift, string: n.stringIndex + 1, fret: n.fret },
    }));
    const items = buildTimeline(src);
    const lines = part.tab.tuning.openMidi.length;
    const notationClef =
      part.clef === 'bass'
        ? '<clef number="1"><sign>F</sign><line>4</line></clef>'
        : '<clef number="1"><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>';
    return [
      { staff: 1, voice: 1, items, technical: false, clefXml: notationClef },
      {
        staff: 2,
        voice: 5,
        items,
        technical: true,
        clefXml: '<clef number="2"><sign>TAB</sign><line>5</line></clef>',
        detailsXml: `<staff-details number="2"><staff-lines>${lines}</staff-lines>${staffTuningXml(part.tab.tuning)}</staff-details>`,
      },
    ];
  }

  const notes = part.notes ?? [];
  const toSrc = (list: MidiNoteEvent[]): SourceNote[] =>
    list.map((n) => ({ startBeat: n.startBeat, durationBeats: n.durationBeats, pitch: { midi: n.midi + shift } }));

  if (part.clef === 'grand') {
    return [
      {
        staff: 1,
        voice: 1,
        items: buildTimeline(toSrc(notes.filter((n) => n.midi >= 60))),
        technical: false,
        clefXml: '<clef number="1"><sign>G</sign><line>2</line></clef>',
      },
      {
        staff: 2,
        voice: 5,
        items: buildTimeline(toSrc(notes.filter((n) => n.midi < 60))),
        technical: false,
        clefXml: '<clef number="2"><sign>F</sign><line>4</line></clef>',
      },
    ];
  }

  const clefXml =
    part.clef === 'bass'
      ? '<clef><sign>F</sign><line>4</line></clef>'
      : part.clef === 'guitar'
        ? '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>'
        : '<clef><sign>G</sign><line>2</line></clef>';
  return [{ staff: 1, voice: 1, items: buildTimeline(toSrc(notes)), technical: false, clefXml }];
}

export function encodeMusicXml(score: MusicXmlScoreInput): string {
  const beatsPerMeasure = score.beatsPerMeasure ?? 4;
  const mLen = beatsPerMeasure * DIVISIONS;
  const fifths = keyToFifths(score.keyRootPc, score.keyMode);
  const useFlats = fifths < 0;
  const bpm = Math.round(Math.max(20, Math.min(300, score.bpm || 120)));

  const plans = score.parts.map((p) => ({ part: p, staves: planPart(p) }));
  let lastDiv = mLen;
  for (const { staves } of plans) {
    for (const s of staves) {
      for (const it of s.items) lastDiv = Math.max(lastDiv, it.start + it.dur);
    }
  }
  const totalMeasures = Math.max(1, Math.ceil(lastDiv / mLen));

  const partList = plans
    .map(({ part }, idx) => {
      const channel = (part.midiChannel ?? idx) + 1;
      const program = (part.midiProgram ?? 0) + 1;
      return [
        `<score-part id="${part.id}">`,
        `<part-name>${escapeXml(part.name)}</part-name>`,
        part.abbreviation ? `<part-abbreviation>${escapeXml(part.abbreviation)}</part-abbreviation>` : '',
        `<score-instrument id="${part.id}-I1"><instrument-name>${escapeXml(part.name)}</instrument-name></score-instrument>`,
        `<midi-instrument id="${part.id}-I1"><midi-channel>${channel}</midi-channel><midi-program>${program}</midi-program></midi-instrument>`,
        '</score-part>',
      ].join('');
    })
    .join('\n    ');

  const partsXml = plans
    .map(({ part, staves }, partIdx) => {
      const measures: string[] = [];
      for (let m = 0; m < totalMeasures; m++) {
        const body: string[] = [];
        if (m === 0) {
          const stavesXml = staves.length > 1 ? `<staves>${staves.length}</staves>` : '';
          const clefs = staves.map((s) => s.clefXml).join('');
          const details = staves.map((s) => s.detailsXml ?? '').join('');
          const transpose = part.octaveDown
            ? '<transpose><diatonic>0</diatonic><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>'
            : '';
          body.push(
            `<attributes><divisions>${DIVISIONS}</divisions><key><fifths>${fifths}</fifths><mode>${score.keyMode}</mode></key><time><beats>${beatsPerMeasure}</beats><beat-type>4</beat-type></time>${stavesXml}${clefs}${details}${transpose}</attributes>`
          );
          if (partIdx === 0) {
            body.push(
              `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>`
            );
          }
        }
        staves.forEach((s, sIdx) => {
          if (sIdx > 0) body.push(`<backup><duration>${mLen}</duration></backup>`);
          const segs = segmentsForMeasure(s.items, m * mLen, mLen);
          body.push(...renderSegments(segs, mLen, s.staff, s.voice, useFlats, s.technical));
        });
        if (m === totalMeasures - 1) {
          body.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
        }
        measures.push(`    <measure number="${m + 1}">\n      ${body.join('\n      ')}\n    </measure>`);
      }
      return `  <part id="${part.id}">\n${measures.join('\n')}\n  </part>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `  <work><work-title>${escapeXml(score.title)}</work-title></work>`,
    '  <identification>',
    score.subtitle ? `    <creator type="arranger">${escapeXml(score.subtitle)}</creator>` : '',
    '    <encoding><software>StemForge</software></encoding>',
    '  </identification>',
    '  <part-list>',
    `    ${partList}`,
    '  </part-list>',
    partsXml,
    '</score-partwise>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
