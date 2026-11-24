import type {
  BassTuningId,
  ChordEvent,
  GuitarTuningId,
  MidiNoteEvent,
  StringInstrument,
  TabNoteEvent,
} from '../types/music';

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function midiToNoteName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const pc = clamped % 12;
  const octave = Math.floor(clamped / 12) - 1;
  return `${NOTE_NAMES_SHARP[pc]}${octave}`;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidi(freq: number): number {
  if (freq <= 0) return 0;
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

export function transposePitchClass(pc: number, semitones: number): number {
  return (((pc + semitones) % 12) + 12) % 12;
}

export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

export function formatChordSymbol(rootPc: number, quality: ChordEvent['quality'], transpose = 0, useFlats = false): string {
  const root = (useFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[transposePitchClass(rootPc, transpose)];
  switch (quality) {
    case 'maj':
      return root;
    case 'min':
      return `${root}m`;
    case '7':
      return `${root}7`;
    case 'maj7':
      return `${root}maj7`;
    case 'm7':
      return `${root}m7`;
    case '5':
      return `${root}5`;
  }
}

export function formatKeySignature(rootPc: number, mode: 'major' | 'minor', transpose = 0): string {
  const name = NOTE_NAMES_SHARP[transposePitchClass(rootPc, transpose)];
  return `${name} ${mode === 'major' ? 'Major' : 'Minor'}`;
}

export interface TuningPreset {
  id: string;
  label: string;
  // Ordered top-to-bottom on tab: stringIndex 0 = highest pitched string
  stringNames: string[];
  openMidi: number[];
}

export const GUITAR_TUNINGS: Record<GuitarTuningId, TuningPreset> = {
  standard: { id: 'standard', label: 'Standard (E A D G B e)', stringNames: ['e', 'B', 'G', 'D', 'A', 'E'], openMidi: [64, 59, 55, 50, 45, 40] },
  dropD: { id: 'dropD', label: 'Drop D (D A D G B e)', stringNames: ['e', 'B', 'G', 'D', 'A', 'D'], openMidi: [64, 59, 55, 50, 45, 38] },
  halfStepDown: { id: 'halfStepDown', label: 'Eb Standard (Eb Ab Db Gb Bb eb)', stringNames: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'], openMidi: [63, 58, 54, 49, 44, 39] },
  dStandard: { id: 'dStandard', label: 'D Standard (D G C F A d)', stringNames: ['d', 'A', 'F', 'C', 'G', 'D'], openMidi: [62, 57, 53, 48, 43, 38] },
  dropCSharp: { id: 'dropCSharp', label: 'Drop C# (C# G# C# F# A# d#)', stringNames: ['d#', 'A#', 'F#', 'C#', 'G#', 'C#'], openMidi: [63, 58, 54, 49, 44, 37] },
  dropC: { id: 'dropC', label: 'Drop C (C G C F A d)', stringNames: ['d', 'A', 'F', 'C', 'G', 'C'], openMidi: [62, 57, 53, 48, 43, 36] },
  cSharpStandard: { id: 'cSharpStandard', label: 'C# Standard (C# F# B E G# c#)', stringNames: ['c#', 'G#', 'E', 'B', 'F#', 'C#'], openMidi: [61, 56, 52, 47, 42, 37] },
  cStandard: { id: 'cStandard', label: 'C Standard (C F Bb Eb G c)', stringNames: ['c', 'G', 'Eb', 'Bb', 'F', 'C'], openMidi: [60, 55, 51, 46, 41, 36] },
  dropB: { id: 'dropB', label: 'Drop B (B F# B E G# c#)', stringNames: ['c#', 'G#', 'E', 'B', 'F#', 'B'], openMidi: [61, 56, 52, 47, 42, 35] },
  bStandard: { id: 'bStandard', label: 'B Standard (B E A D F# b)', stringNames: ['b', 'F#', 'D', 'A', 'E', 'B'], openMidi: [59, 54, 50, 45, 40, 35] },
  dropA: { id: 'dropA', label: 'Drop A (A E A D F# b)', stringNames: ['b', 'F#', 'D', 'A', 'E', 'A'], openMidi: [59, 54, 50, 45, 40, 33] },
  seven: { id: 'seven', label: '7-String Standard (B E A D G B e)', stringNames: ['e', 'B', 'G', 'D', 'A', 'E', 'B'], openMidi: [64, 59, 55, 50, 45, 40, 35] },
  sevenDropA: { id: 'sevenDropA', label: '7-String Drop A (A E A D G B e)', stringNames: ['e', 'B', 'G', 'D', 'A', 'E', 'A'], openMidi: [64, 59, 55, 50, 45, 40, 33] },
  eight: { id: 'eight', label: '8-String Standard (F# B E A D G B e)', stringNames: ['e', 'B', 'G', 'D', 'A', 'E', 'B', 'F#'], openMidi: [64, 59, 55, 50, 45, 40, 35, 30] },
};

export const BASS_TUNINGS: Record<BassTuningId, TuningPreset> = {
  standard4: { id: 'standard4', label: '4-String Standard (E A D G)', stringNames: ['G', 'D', 'A', 'E'], openMidi: [43, 38, 33, 28] },
  dropD4: { id: 'dropD4', label: '4-String Drop D (D A D G)', stringNames: ['G', 'D', 'A', 'D'], openMidi: [43, 38, 33, 26] },
  halfStepDown4: { id: 'halfStepDown4', label: '4-String Eb Standard (Eb Ab Db Gb)', stringNames: ['Gb', 'Db', 'Ab', 'Eb'], openMidi: [42, 37, 32, 27] },
  dStandard4: { id: 'dStandard4', label: '4-String D Standard (D G C F)', stringNames: ['F', 'C', 'G', 'D'], openMidi: [41, 36, 31, 26] },
  dropC4: { id: 'dropC4', label: '4-String Drop C (C G C F)', stringNames: ['F', 'C', 'G', 'C'], openMidi: [41, 36, 31, 24] },
  cStandard4: { id: 'cStandard4', label: '4-String C Standard (C F Bb Eb)', stringNames: ['Eb', 'Bb', 'F', 'C'], openMidi: [39, 34, 29, 24] },
  bStandard4: { id: 'bStandard4', label: '4-String B Standard (B E A D)', stringNames: ['D', 'A', 'E', 'B'], openMidi: [38, 33, 28, 23] },
  five: { id: 'five', label: '5-String Standard (B E A D G)', stringNames: ['G', 'D', 'A', 'E', 'B'], openMidi: [43, 38, 33, 28, 23] },
  fiveDropA: { id: 'fiveDropA', label: '5-String Drop A (A E A D G)', stringNames: ['G', 'D', 'A', 'E', 'A'], openMidi: [43, 38, 33, 28, 21] },
};

/** How unusual a tuning is (lower = more common); used as a prior by auto-detection. */
const TUNING_PRIOR: Record<string, number> = {
  standard: 0,
  dropD: 0.6,
  halfStepDown: 0.8,
  dStandard: 1.2,
  dropCSharp: 1.4,
  dropC: 1.0,
  cSharpStandard: 1.6,
  cStandard: 1.3,
  dropB: 1.3,
  bStandard: 1.4,
  dropA: 1.8,
  seven: 1.5,
  sevenDropA: 2.0,
  eight: 2.6,
  standard4: 0,
  dropD4: 0.6,
  halfStepDown4: 0.8,
  dStandard4: 1.2,
  dropC4: 1.0,
  cStandard4: 1.3,
  bStandard4: 1.4,
  five: 1.0,
  fiveDropA: 2.0,
};

/**
 * Picks the most plausible tuning for a set of notes: the tuning must reach the lowest notes
 * that are actually played (duration-weighted, ignoring stray artifacts), keep the lowest
 * open string close to the lowest played note, and prefer common tunings.
 */
export function detectTuning(notes: MidiNoteEvent[], candidates: TuningPreset[]): TuningPreset {
  const fallback = candidates[0];
  const weighted = notes
    .filter((n) => n.durationBeats > 0.05)
    .map((n) => ({ midi: n.midi, w: Math.min(4, n.durationBeats) * (n.velocity / 127) }))
    .sort((a, b) => a.midi - b.midi);
  const total = weighted.reduce((sum, n) => sum + n.w, 0);
  if (weighted.length < 8 || total <= 0) return fallback;

  // Lowest note that accounts for at least 1.5% of the playing time
  let acc = 0;
  let low = weighted[0].midi;
  for (const n of weighted) {
    acc += n.w;
    if (acc >= total * 0.015) {
      low = n.midi;
      break;
    }
  }

  let best = fallback;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const t of candidates) {
    const lowestOpen = Math.min(...t.openMidi);
    const below = weighted.reduce((sum, n) => (n.midi < lowestOpen ? sum + n.w : sum), 0) / total;
    const cost = below * 60 + Math.max(0, low - lowestOpen) * 0.35 + (TUNING_PRIOR[t.id] ?? 1.5);
    if (cost < bestCost) {
      bestCost = cost;
      best = t;
    }
  }
  return best;
}

export function getTuningPreset(
  instrument: StringInstrument,
  guitarTuning: GuitarTuningId = 'standard',
  bassTuning: BassTuningId = 'standard4'
): TuningPreset {
  return instrument === 'guitar'
    ? GUITAR_TUNINGS[guitarTuning] ?? GUITAR_TUNINGS.standard
    : BASS_TUNINGS[bassTuning] ?? BASS_TUNINGS.standard4;
}

/**
 * Maps MIDI note events onto playable guitar or bass string/fret positions.
 *
 * Notes that start together are one chord shape on distinct strings. The fingering of the whole
 * part is optimised at once (Viterbi over every chord / note's candidate shapes, as in the
 * "optimum path" approach to tablature): small stretches, few and short position shifts (shifts
 * cost more in fast passages), and the same notes fingered the same way every time they repeat.
 */
export function mapNotesToTab(
  notes: MidiNoteEvent[],
  tuning: TuningPreset,
  transpose = 0,
  maxFret = 19
): TabNoteEvent[] {
  const numStrings = tuning.openMidi.length;
  const lowestOpen = Math.min(...tuning.openMidi);
  const highestPossible = Math.max(...tuning.openMidi) + maxFret;
  const CHORD_WINDOW_BEATS = 0.08;

  const prepared = notes
    .map((note) => {
      let targetMidi = note.midi + transpose;
      // Octave-fold gracefully if outside instrument range
      while (targetMidi < lowestOpen) targetMidi += 12;
      while (targetMidi > highestPossible) targetMidi -= 12;
      return { note, midi: targetMidi };
    })
    .sort((a, b) => a.note.startBeat - b.note.startBeat || b.midi - a.midi);

  // Group simultaneous onsets into chords
  const rawGroups: Array<typeof prepared> = [];
  for (const item of prepared) {
    const last = rawGroups[rawGroups.length - 1];
    if (last && item.note.startBeat - last[0].note.startBeat <= CHORD_WINDOW_BEATS) {
      // Same pitch twice in one chord is a transcription duplicate: keep the louder one
      const dup = last.findIndex((x) => x.midi === item.midi);
      if (dup === -1) last.push(item);
      else if (item.note.velocity > last[dup].note.velocity) last[dup] = item;
    } else {
      rawGroups.push([item]);
    }
  }

  // Candidate fingerings per distinct pitch set (cached: riffs repeat the same shapes)
  const cache = new Map<string, Fingering[]>();
  const candidatesFor = (midis: number[]): Fingering[] => {
    const key = midis.join(',');
    const hit = cache.get(key);
    if (hit) return hit;
    const found = enumerateFingerings(midis, tuning, maxFret);
    cache.set(key, found);
    return found;
  };

  // Keep at most one note per string (loudest first); drop the quietest note of an unplayable chord
  const groups: Array<{ items: typeof prepared; key: string; cands: Fingering[] }> = [];
  for (const rawGroup of rawGroups) {
    let group = [...rawGroup];
    if (group.length > numStrings) group = group.sort((a, b) => b.note.velocity - a.note.velocity).slice(0, numStrings);
    group.sort((a, b) => b.midi - a.midi);
    let cands = candidatesFor(group.map((g) => g.midi));
    while (!cands.length && group.length > 1) {
      let quietest = 0;
      for (let k = 1; k < group.length; k++) if (group[k].note.velocity < group[quietest].note.velocity) quietest = k;
      group.splice(quietest, 1);
      cands = candidatesFor(group.map((g) => g.midi));
    }
    if (!cands.length) continue;
    groups.push({ items: group, key: group.map((g) => g.midi).join(','), cands });
  }
  if (!groups.length) return [];

  /**
   * Viterbi over the whole part: each chord / note picks one candidate fingering so that the total
   * of shape costs + hand movement is smallest. Fast passages make position jumps expensive, so
   * riffs stay in one position the way a guitarist plays them. A second pass gives every repeat of
   * the same notes the fingering most of its repeats got, so a riff is tabbed the same way each time.
   */
  const solve = (preferred: Map<string, string> | null): number[] => {
    const n = groups.length;
    const back: Int16Array[] = new Array(n);
    let prev = groups[0].cands.map((c) => c.cost - bonus(groups[0], c, preferred));
    back[0] = new Int16Array(prev.length).fill(-1);
    for (let i = 1; i < n; i++) {
      const g = groups[i];
      const gap = g.items[0].note.startBeat - groups[i - 1].items[0].note.startBeat;
      const cur = new Array<number>(g.cands.length).fill(Number.POSITIVE_INFINITY);
      const bk = new Int16Array(g.cands.length);
      g.cands.forEach((c, j) => {
        const own = c.cost - bonus(g, c, preferred);
        groups[i - 1].cands.forEach((p, k) => {
          const v = prev[k] + moveCost(p, c, gap) + own;
          if (v < cur[j]) {
            cur[j] = v;
            bk[j] = k;
          }
        });
      });
      prev = cur;
      back[i] = bk;
    }
    const choice = new Array<number>(n);
    let best = 0;
    for (let j = 1; j < prev.length; j++) if (prev[j] < prev[best]) best = j;
    for (let i = n - 1; i >= 0; i--) {
      choice[i] = best;
      best = back[i][best];
    }
    return choice;
  };

  let choice = solve(null);
  const votes = new Map<string, Map<string, number>>();
  groups.forEach((g, i) => {
    const sig = g.cands[choice[i]].sig;
    const m = votes.get(g.key) ?? new Map<string, number>();
    m.set(sig, (m.get(sig) ?? 0) + 1);
    votes.set(g.key, m);
  });
  const preferred = new Map<string, string>();
  for (const [key, m] of votes) {
    let top = '';
    let count = 0;
    let total = 0;
    for (const [sig, c] of m) {
      total += c;
      if (c > count) {
        top = sig;
        count = c;
      }
    }
    if (total >= 2) preferred.set(key, top);
  }
  if (preferred.size) choice = solve(preferred);

  const result: TabNoteEvent[] = [];
  groups.forEach((g, i) => {
    const f = g.cands[choice[i]];
    g.items.forEach((item, k) => {
      result.push({
        id: item.note.id,
        midi: item.midi,
        startBeat: item.note.startBeat,
        durationBeats: item.note.durationBeats,
        stringIndex: f.strings[k],
        fret: f.frets[k],
        velocity: item.note.velocity,
      });
    });
  });
  return result.sort((a, b) => a.startBeat - b.startBeat || a.stringIndex - b.stringIndex);
}

interface Fingering {
  strings: number[]; // per note (notes sorted high -> low pitch)
  frets: number[];
  cost: number; // shape cost
  pos: number | null; // hand position (lowest fretted fret), null = open strings only
  sig: string;
}

const MAX_CANDIDATES = 14;

/** All playable ways to finger a set of pitches (sorted high -> low), cheapest shapes first. */
function enumerateFingerings(midis: number[], tuning: TuningPreset, maxFret: number): Fingering[] {
  const numStrings = tuning.openMidi.length;
  const out: Fingering[] = [];
  const used = new Array<boolean>(numStrings).fill(false);
  const strings: number[] = [];
  const frets: number[] = [];
  const rec = (i: number) => {
    if (out.length > 600) return;
    if (i === midis.length) {
      const fretted = frets.filter((f) => f > 0);
      const lo = fretted.length ? Math.min(...fretted) : 0;
      const hi = fretted.length ? Math.max(...fretted) : 0;
      const span = hi - lo;
      if (span > 5) return; // unplayable stretch
      let cost = span > 3 ? (span - 3) * 2.5 : 0;
      for (const f of frets) cost += f === 0 ? 0.3 : 0.08 * f + (f > 12 ? (f - 12) * 0.3 : 0);
      // higher notes belong on higher strings (lower index); crossed voicings are awkward
      for (let k = 1; k < strings.length; k++) if (strings[k] < strings[k - 1]) cost += 2;
      if (midis.length > 1) {
        // chord shapes sit on neighbouring strings (power chords: root + fifth one string up) ...
        for (let k = 1; k < strings.length; k++) cost += 0.6 * Math.max(0, Math.abs(strings[k] - strings[k - 1]) - 1);
        // ... and an open string inside a fretted shape is only natural as its lowest note (E5 with open E)
        const lowest = frets.length - 1; // notes are sorted high -> low
        if (fretted.length) frets.forEach((f, k) => (cost += f === 0 && k !== lowest ? 0.5 : 0));
      }
      out.push({ strings: [...strings], frets: [...frets], cost, pos: fretted.length ? lo : null, sig: strings.map((s, k) => `${s}:${frets[k]}`).join('|') });
      return;
    }
    for (let s = 0; s < numStrings; s++) {
      if (used[s]) continue;
      const fret = midis[i] - tuning.openMidi[s];
      if (fret < 0 || fret > maxFret) continue;
      used[s] = true;
      strings.push(s);
      frets.push(fret);
      rec(i + 1);
      strings.pop();
      frets.pop();
      used[s] = false;
    }
  };
  rec(0);
  out.sort((a, b) => a.cost - b.cost);
  return out.slice(0, MAX_CANDIDATES);
}

/** Hand movement between two consecutive shapes; quick successions make jumps expensive. */
function moveCost(a: Fingering, b: Fingering, gapBeats: number): number {
  let cost = 0;
  if (a.pos !== null && b.pos !== null) {
    const d = Math.abs(a.pos - b.pos);
    const w = gapBeats < 0.6 ? 0.9 : gapBeats < 1.5 ? 0.6 : 0.3;
    cost += d * w + (d > 4 ? (d - 4) * 0.6 : 0);
  }
  if (a.strings.length === 1 && b.strings.length === 1) cost += 0.12 * Math.abs(a.strings[0] - b.strings[0]);
  return cost;
}

function bonus(g: { key: string }, c: Fingering, preferred: Map<string, string> | null): number {
  return preferred && preferred.get(g.key) === c.sig ? 1.5 : 0;
}

/**
 * Generates monospace ASCII tablature on a rhythmic grid (16th notes by default). Notes are snapped
 * to the grid and duplicates on the same string merge, so columns never overwrite each other;
 * each column is 3 characters wide so two-digit frets stay aligned.
 */
export function generateAsciiTab(
  tabNotes: TabNoteEvent[],
  tuning: TuningPreset,
  title: string,
  bpm: number,
  beatsPerMeasure = 4,
  stepsPerBeat = 4
): string {
  const steps = Math.max(1, Math.round(beatsPerMeasure * stepsPerBeat));
  const cell = 3;
  // snap + merge (keep the loudest note per string and column)
  const cells = new Map<string, TabNoteEvent>();
  let lastCol = 0;
  for (const n of tabNotes) {
    const col = Math.max(0, Math.round(n.startBeat * stepsPerBeat));
    const key = `${n.stringIndex}:${col}`;
    const prev = cells.get(key);
    if (!prev || n.velocity > prev.velocity) cells.set(key, n);
    lastCol = Math.max(lastCol, col);
  }
  const totalMeasures = Math.max(1, Math.ceil((lastCol + 1) / steps));
  const measuresPerRow = stepsPerBeat >= 4 ? 2 : 4;
  const labelWidth = Math.max(...tuning.stringNames.map((n) => n.length)) + 1;
  const lines: string[] = [
    `${title} — ${tuning.label}`,
    `Tempo: ${Math.round(bpm)} BPM | ${beatsPerMeasure} beats per bar | one column = 1/${stepsPerBeat * 4} note`,
    '',
  ];

  for (let rowStart = 0; rowStart < totalMeasures; rowStart += measuresPerRow) {
    const rowEnd = Math.min(totalMeasures, rowStart + measuresPerRow);
    let numbers = ' '.repeat(labelWidth + 1);
    for (let m = rowStart; m < rowEnd; m++) numbers += String(m + 1).padEnd(steps * cell + 1, ' ');
    lines.push(numbers.trimEnd());
    for (let s = 0; s < tuning.stringNames.length; s++) {
      let line = `${tuning.stringNames[s].padEnd(labelWidth, ' ')}|`;
      for (let m = rowStart; m < rowEnd; m++) {
        for (let c = 0; c < steps; c++) {
          const note = cells.get(`${s}:${m * steps + c}`);
          line += note ? String(note.fret).padEnd(cell, '-') : '-'.repeat(cell);
        }
        line += '|';
      }
      lines.push(line);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Detects the best matching chord symbol from a 12-bin pitch-class energy vector.
 */
export function detectChordFromChroma(chroma: number[]): {
  rootPc: number;
  quality: ChordEvent['quality'];
  confidence: number;
} {
  const templates: Array<{ quality: ChordEvent['quality']; intervals: number[] }> = [
    { quality: 'maj', intervals: [0, 4, 7] },
    { quality: 'min', intervals: [0, 3, 7] },
    { quality: 'm7', intervals: [0, 3, 7, 10] },
    { quality: 'maj7', intervals: [0, 4, 7, 11] },
    { quality: '7', intervals: [0, 4, 7, 10] },
  ];

  const totalEnergy = chroma.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (totalEnergy <= 1e-6) {
    return { rootPc: 0, quality: 'maj', confidence: 0 };
  }

  let bestRoot = 0;
  let bestQuality: ChordEvent['quality'] = 'maj';
  let bestScore = -Infinity;

  for (let root = 0; root < 12; root++) {
    for (const tpl of templates) {
      let inChord = 0;
      const chordSet = new Set(tpl.intervals.map((i) => (root + i) % 12));
      for (let pc = 0; pc < 12; pc++) {
        const weight = chroma[pc] / totalEnergy;
        if (chordSet.has(pc)) {
          inChord += pc === root ? weight * 1.25 : weight;
        } else {
          inChord -= weight * 0.45;
        }
      }
      // Slight parsimony preference for triads over 7ths unless 7th is clearly present
      const complexityPenalty = tpl.intervals.length === 4 ? 0.1 : 0;
      const score = inChord - complexityPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestQuality = tpl.quality;
      }
    }
  }

  // Power chord: strong root + fifth with (almost) no third, typical of distorted rock / metal guitar
  if (bestQuality === 'maj' || bestQuality === 'min') {
    const w = (pc: number) => Math.max(0, chroma[(bestRoot + pc) % 12]) / totalEnergy;
    const third = Math.max(w(3), w(4));
    if (third < 0.12 && w(0) > 0.18 && w(7) > 0.1) {
      bestQuality = '5';
    }
  }

  return {
    rootPc: bestRoot,
    quality: bestQuality,
    confidence: Math.max(0, Math.min(1, bestScore)),
  };
}

export interface ChordVoicing {
  symbol: string;
  // Low E -> High e (6 entries for guitar, 4 entries for bass). -1 = muted, 0 = open, >0 = fret
  frets: number[];
  baseFret: number;
}

const GUITAR_OPEN_SHAPES: Record<string, number[]> = {
  C: [-1, 3, 2, 0, 1, 0],
  Cm: [-1, 3, 5, 5, 4, 3],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  C7: [-1, 3, 2, 3, 1, 0],
  Cm7: [-1, 3, 5, 3, 4, 3],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  Dmaj7: [-1, -1, 0, 2, 2, 2],
  D7: [-1, -1, 0, 2, 1, 2],
  Dm7: [-1, -1, 0, 2, 1, 1],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  Emaj7: [0, 2, 1, 1, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fm: [1, 3, 3, 1, 1, 1],
  Fmaj7: [-1, -1, 3, 2, 1, 0],
  F7: [1, 3, 1, 2, 1, 1],
  Fm7: [1, 3, 1, 1, 1, 1],
  G: [3, 2, 0, 0, 0, 3],
  Gm: [3, 5, 5, 3, 3, 3],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  G7: [3, 2, 0, 0, 0, 1],
  Gm7: [3, 5, 3, 3, 3, 3],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  Amaj7: [-1, 0, 2, 1, 2, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  B: [-1, 2, 4, 4, 4, 2],
  Bm: [-1, 2, 4, 4, 3, 2],
  Bmaj7: [-1, 2, 4, 3, 4, 2],
  B7: [-1, 2, 1, 2, 0, 2],
  Bm7: [-1, 2, 4, 2, 3, 2],
};

/**
 * Returns a guitar 6-string or bass 4-string fretboard chord/arpeggio voicing for any chord.
 */
export function getChordVoicing(
  rootPc: number,
  quality: ChordEvent['quality'],
  instrument: StringInstrument,
  transpose = 0
): ChordVoicing {
  const effectiveRoot = transposePitchClass(rootPc, transpose);
  const symbol = formatChordSymbol(effectiveRoot, quality, 0);

  if (instrument === 'bass') {
    // 4-string bass: E(4), A(9), D(2), G(7) — show root + 5th + octave/3rd playable box
    const bassOpenPcs = [4, 9, 2, 7];
    const thirdInterval = quality === 'min' || quality === 'm7' ? 3 : 4;
    const fifthInterval = 7;
    const seventhInterval = quality === 'maj7' ? 11 : quality === '7' || quality === 'm7' ? 10 : 0;

    // Place root on E or A string near frets 0-7
    const rootOnE = (effectiveRoot - bassOpenPcs[0] + 12) % 12;
    const rootOnA = (effectiveRoot - bassOpenPcs[1] + 12) % 12;
    let frets: number[];

    if (rootOnE <= 7) {
      const f = rootOnE;
      frets = [
        f,
        (effectiveRoot + fifthInterval - bassOpenPcs[1] + 12) % 12,
        (effectiveRoot + (seventhInterval || 0) - bassOpenPcs[2] + 12) % 12,
        (effectiveRoot + thirdInterval - bassOpenPcs[3] + 12) % 12,
      ];
    } else {
      const f = rootOnA;
      frets = [
        -1,
        f,
        (effectiveRoot + fifthInterval - bassOpenPcs[2] + 12) % 12,
        (effectiveRoot + thirdInterval - bassOpenPcs[3] + 12) % 12,
      ];
    }

    const positive = frets.filter((x) => x > 0);
    const minFret = positive.length > 0 ? Math.min(...positive) : 1;
    const maxFret = positive.length > 0 ? Math.max(...positive) : 1;
    const baseFret = maxFret > 5 ? minFret : 1;

    return { symbol, frets, baseFret };
  }

  // Guitar 6-string: check curated open/standard shapes first
  if (GUITAR_OPEN_SHAPES[symbol]) {
    const frets = GUITAR_OPEN_SHAPES[symbol];
    const positive = frets.filter((x) => x > 0);
    const minFret = positive.length > 0 ? Math.min(...positive) : 1;
    const maxFret = positive.length > 0 ? Math.max(...positive) : 1;
    return {
      symbol,
      frets,
      baseFret: maxFret > 4 ? minFret : 1,
    };
  }

  // Movable E-shape barre chord fallback for sharp/flat roots (e.g. F#m, C#m7, Bb)
  const fretOnE = (effectiveRoot - 4 + 12) % 12 || 12;
  const barreOffsets: Record<ChordEvent['quality'], number[]> = {
    maj: [0, 2, 2, 1, 0, 0],
    min: [0, 2, 2, 0, 0, 0],
    '7': [0, 2, 0, 1, 0, 0],
    maj7: [0, 2, 1, 1, 0, 0],
    m7: [0, 2, 0, 0, 0, 0],
    '5': [0, 2, 2, -99, -99, -99],
  };

  const frets = barreOffsets[quality].map((off) => (off < -10 ? -1 : fretOnE + off));
  return {
    symbol,
    frets,
    baseFret: fretOnE > 1 ? fretOnE : 1,
  };
}

/**
 * Computes diatonic staff position (steps above C4) and accidental for standard SVG sheet music.
 * Treble clef reference: bottom line E4 = diatonic step 2, middle line B4 = step 6, top line F5 = step 10.
 * Bass clef reference: bottom line G2 = diatonic step -10, middle line D3 = step -6, top line A3 = step -2.
 */
const CHROMATIC_TO_DIATONIC: Array<{ step: number; accidental: '#' | null }> = [
  { step: 0, accidental: null }, // C
  { step: 0, accidental: '#' },  // C#
  { step: 1, accidental: null }, // D
  { step: 1, accidental: '#' },  // D#
  { step: 2, accidental: null }, // E
  { step: 3, accidental: null }, // F
  { step: 3, accidental: '#' },  // F#
  { step: 4, accidental: null }, // G
  { step: 4, accidental: '#' },  // G#
  { step: 5, accidental: null }, // A
  { step: 5, accidental: '#' },  // A#
  { step: 6, accidental: null }, // B
];

export interface StaffNotePosition {
  diatonicStep: number; // 0 = C4, 2 = E4, -10 = G2
  accidental: '#' | null;
  lineOffsetFromBottom: number; // 0 = bottom line of staff, 4 = top line of staff (in line spaces)
}

export function getStaffPosition(midi: number, clef: 'treble' | 'bass'): StaffNotePosition {
  // Guitar is conventionally written an octave higher in treble clef so notes sit comfortably on the staff
  const writtenMidi = clef === 'treble' && midi < 55 ? midi + 12 : midi;
  const octave = Math.floor(writtenMidi / 12) - 1;
  const pc = ((writtenMidi % 12) + 12) % 12;
  const info = CHROMATIC_TO_DIATONIC[pc];
  const diatonicStep = (octave - 4) * 7 + info.step;

  // Bottom line is E4 (step 2) for treble, G2 (step -10) for bass. Each staff line is 2 diatonic steps.
  const bottomLineStep = clef === 'treble' ? 2 : -10;
  const lineOffsetFromBottom = (diatonicStep - bottomLineStep) / 2;

  return {
    diatonicStep,
    accidental: info.accidental,
    lineOffsetFromBottom,
  };
}
