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

export function formatChordSymbol(rootPc: number, quality: ChordEvent['quality'], transpose = 0): string {
  const root = NOTE_NAMES_SHARP[transposePitchClass(rootPc, transpose)];
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
  standard: {
    id: 'standard',
    label: 'Standard (E A D G B e)',
    stringNames: ['e', 'B', 'G', 'D', 'A', 'E'],
    openMidi: [64, 59, 55, 50, 45, 40],
  },
  dropD: {
    id: 'dropD',
    label: 'Drop D (D A D G B e)',
    stringNames: ['e', 'B', 'G', 'D', 'A', 'D'],
    openMidi: [64, 59, 55, 50, 45, 38],
  },
  halfStepDown: {
    id: 'halfStepDown',
    label: 'Eb Standard (Eb Ab Db Gb Bb eb)',
    stringNames: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'],
    openMidi: [63, 58, 54, 49, 44, 39],
  },
};

export const BASS_TUNINGS: Record<BassTuningId, TuningPreset> = {
  standard4: {
    id: 'standard4',
    label: '4-String Standard (E A D G)',
    stringNames: ['G', 'D', 'A', 'E'],
    openMidi: [43, 38, 33, 28],
  },
  dropD4: {
    id: 'dropD4',
    label: '4-String Drop D (D A D G)',
    stringNames: ['G', 'D', 'A', 'D'],
    openMidi: [43, 38, 33, 26],
  },
};

export function getTuningPreset(
  instrument: StringInstrument,
  guitarTuning: GuitarTuningId = 'standard',
  bassTuning: BassTuningId = 'standard4'
): TuningPreset {
  return instrument === 'guitar' ? GUITAR_TUNINGS[guitarTuning] : BASS_TUNINGS[bassTuning];
}

/**
 * Maps MIDI note events onto optimal guitar or bass string/fret positions,
 * minimizing hand position jumps while keeping frets inside [0, maxFret].
 */
export function mapNotesToTab(
  notes: MidiNoteEvent[],
  tuning: TuningPreset,
  transpose = 0,
  maxFret = 19
): TabNoteEvent[] {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
  const lowestOpen = Math.min(...tuning.openMidi);
  const highestPossible = Math.max(...tuning.openMidi) + maxFret;

  let anchorFret = 5;
  const result: TabNoteEvent[] = [];

  for (const note of sorted) {
    let targetMidi = note.midi + transpose;
    // Octave-fold gracefully if outside instrument range
    while (targetMidi < lowestOpen) targetMidi += 12;
    while (targetMidi > highestPossible) targetMidi -= 12;

    let bestString = -1;
    let bestFret = -1;
    let bestCost = Number.POSITIVE_INFINITY;

    for (let s = 0; s < tuning.openMidi.length; s++) {
      const fret = targetMidi - tuning.openMidi[s];
      if (fret < 0 || fret > maxFret) continue;

      // Prefer frets close to current hand position, with gentle bonus for open strings & lower frets
      const distanceCost = fret === 0 ? 1.5 : Math.abs(fret - anchorFret);
      const highFretPenalty = fret > 12 ? (fret - 12) * 0.6 : 0;
      const cost = distanceCost + highFretPenalty;

      if (cost < bestCost) {
        bestCost = cost;
        bestString = s;
        bestFret = fret;
      }
    }

    if (bestString !== -1) {
      if (bestFret > 0) {
        anchorFret = Math.round(anchorFret * 0.6 + bestFret * 0.4);
      }
      result.push({
        id: note.id,
        midi: targetMidi,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        stringIndex: bestString,
        fret: bestFret,
        velocity: note.velocity,
      });
    }
  }

  return result;
}

/**
 * Generates clean monospace ASCII tablature grouped by 4-beat measures.
 */
export function generateAsciiTab(
  tabNotes: TabNoteEvent[],
  tuning: TuningPreset,
  title: string,
  bpm: number,
  beatsPerMeasure = 4
): string {
  const maxBeat = tabNotes.reduce((max, n) => Math.max(max, n.startBeat + 0.5), beatsPerMeasure * 2);
  const totalMeasures = Math.max(1, Math.ceil(maxBeat / beatsPerMeasure));
  const stepsPerBeat = 2; // 8th-note columns
  const colsPerMeasure = beatsPerMeasure * stepsPerBeat;

  const lines: string[] = [
    `${title} — ${tuning.label}`,
    `Tempo: ${Math.round(bpm)} BPM | Time: ${beatsPerMeasure}/4`,
    '',
  ];

  const measuresPerRow = 4;
  for (let rowStart = 0; rowStart < totalMeasures; rowStart += measuresPerRow) {
    const rowEnd = Math.min(totalMeasures, rowStart + measuresPerRow);
    const stringRows = tuning.stringNames.map((name) => `${name.padEnd(2, ' ')}|`);

    for (let m = rowStart; m < rowEnd; m++) {
      const mStart = m * beatsPerMeasure;
      const grid: string[][] = tuning.stringNames.map(() =>
        Array.from({ length: colsPerMeasure }, () => '--')
      );

      for (const note of tabNotes) {
        if (note.startBeat >= mStart - 0.01 && note.startBeat < mStart + beatsPerMeasure - 0.01) {
          const col = Math.min(
            colsPerMeasure - 1,
            Math.max(0, Math.round((note.startBeat - mStart) * stepsPerBeat))
          );
          const fretStr = note.fret >= 10 ? String(note.fret) : `${note.fret}-`;
          grid[note.stringIndex][col] = fretStr;
        }
      }

      for (let s = 0; s < tuning.stringNames.length; s++) {
        stringRows[s] += `${grid[s].join('')}|`;
      }
    }

    lines.push(...stringRows, '');
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
      const complexityPenalty = tpl.intervals.length === 4 ? 0.04 : 0;
      const score = inChord - complexityPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestQuality = tpl.quality;
      }
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
