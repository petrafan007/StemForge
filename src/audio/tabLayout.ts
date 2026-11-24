import type { TabNoteEvent } from '../types/music';

/**
 * Grid-based tablature layout (Guitar Pro style):
 *  - notes snap to a rhythmic grid (1/8, 1/16, 1/32 or triplets), so spacing is rhythmic and
 *    two notes can never be closer than one grid column;
 *  - duplicate detections on the same string at the same grid position are merged;
 *  - measures are as wide as their grid needs (empty measures are compressed);
 *  - measures are packed into rows that fit the available width.
 */

export interface TabLayoutNote {
  id: string;
  col: number; // absolute grid column
  beat: number; // real (unquantized) start, in beats - what the playhead highlight follows
  endBeat: number; // real end (cut at the next note on the same string)
  stringIndex: number;
  fret: number;
  midi: number;
  velocity: number;
  durSteps: number;
  x: number; // center x inside the measure (px)
}

export interface TabLayoutChord {
  x: number; // inside the measure (px)
  symbol: string;
}

export interface TabLayoutMeasure {
  index: number;
  startCol: number;
  startBeat: number;
  x: number; // left edge inside the row's music area (px)
  width: number;
  empty: boolean;
  notes: TabLayoutNote[];
  chords: TabLayoutChord[];
}

export interface TabLayoutRow {
  index: number;
  top: number;
  width: number; // music area width (excluding the string-name column)
  measures: TabLayoutMeasure[];
}

export interface TabLayout {
  rows: TabLayoutRow[];
  rowHeight: number;
  rowGap: number;
  totalHeight: number;
  maxRowWidth: number;
  labelWidth: number;
  stringGap: number;
  staffTop: number;
  grid: number; // beats per grid column
  colWidth: number;
  stepsPerMeasure: number;
  stepsPerBeat: number;
  beatsPerMeasure: number;
  padLeft: number;
  padRight: number;
  strings: number;
  noteCount: number;
  mergedCount: number;
}

export interface TabLayoutOptions {
  grid: number; // beats per column, e.g. 0.25 = 16th notes
  colWidth: number; // px per column
  beatsPerMeasure: number; // quarter-note beats per measure
  totalBeats: number;
  containerWidth: number;
  strings: number;
  minVelocity?: number;
  chords?: Array<{ startBeat: number; symbol: string }>;
}

export const TAB_LABEL_WIDTH = 30;
export const TAB_PAD_LEFT = 12;
export const TAB_PAD_RIGHT = 8;
export const TAB_STRING_GAP = 17;
export const TAB_STAFF_TOP = 28; // space above the first string for bar numbers / chords
export const TAB_BOTTOM = 22; // beat ticks under the staff

/** Snaps notes to the grid and merges duplicates on the same string + column (keeps the loudest). */
export function quantizeTabNotes(
  notes: TabNoteEvent[],
  grid: number,
  minVelocity = 0
): { notes: Array<Omit<TabLayoutNote, 'x'>>; merged: number } {
  const byKey = new Map<string, Omit<TabLayoutNote, 'x'>>();
  let merged = 0;
  for (const n of notes) {
    if (n.velocity < minVelocity) continue;
    const col = Math.max(0, Math.round(n.startBeat / grid));
    const key = `${n.stringIndex}:${col}`;
    const q = {
      id: n.id,
      col,
      beat: n.startBeat,
      endBeat: n.startBeat + Math.max(0.05, n.durationBeats),
      stringIndex: n.stringIndex,
      fret: n.fret,
      midi: n.midi,
      velocity: n.velocity,
      durSteps: Math.max(1, Math.round(n.durationBeats / grid)),
    };
    const prev = byKey.get(key);
    if (prev) {
      merged += 1;
      const beat = Math.min(prev.beat, q.beat);
      const endBeat = Math.max(prev.endBeat, q.endBeat);
      if (q.velocity > prev.velocity) byKey.set(key, { ...q, beat, endBeat, durSteps: Math.max(q.durSteps, prev.durSteps) });
      else {
        prev.durSteps = Math.max(prev.durSteps, q.durSteps);
        prev.beat = beat;
        prev.endBeat = endBeat;
      }
    } else {
      byKey.set(key, q);
    }
  }
  const out = [...byKey.values()].sort((a, b) => a.col - b.col || a.stringIndex - b.stringIndex);
  // A sustained note ends where the next note on the same string starts
  const lastOnString = new Map<number, Omit<TabLayoutNote, 'x'>>();
  for (const n of out) {
    const prev = lastOnString.get(n.stringIndex);
    if (prev && prev.col + prev.durSteps > n.col) prev.durSteps = Math.max(1, n.col - prev.col);
    if (prev && prev.endBeat > n.beat) prev.endBeat = Math.max(prev.beat + 0.05, n.beat);
    lastOnString.set(n.stringIndex, n);
  }
  return { notes: out, merged };
}

export function layoutTab(source: TabNoteEvent[], opts: TabLayoutOptions): TabLayout {
  const grid = opts.grid;
  const stepsPerMeasure = Math.max(1, Math.round(opts.beatsPerMeasure / grid));
  const stepsPerBeat = Math.max(1, Math.round(1 / grid));
  const { notes: qnotes, merged } = quantizeTabNotes(source, grid, opts.minVelocity ?? 0);
  const lastCol = qnotes.reduce((m, n) => Math.max(m, n.col), 0);
  const totalMeasures = Math.max(1, Math.ceil(Math.max(opts.totalBeats / opts.beatsPerMeasure, (lastCol + 1) / stepsPerMeasure)));
  const fullWidth = TAB_PAD_LEFT + stepsPerMeasure * opts.colWidth + TAB_PAD_RIGHT;
  const emptyWidth = Math.min(fullWidth, Math.max(56, fullWidth * 0.3));

  // bucket notes and chord changes per measure
  const perMeasure: Array<Array<Omit<TabLayoutNote, 'x'>>> = Array.from({ length: totalMeasures }, () => []);
  for (const n of qnotes) {
    const m = Math.floor(n.col / stepsPerMeasure);
    if (m < totalMeasures) perMeasure[m].push(n);
  }
  const chordsPer: Array<Array<{ col: number; symbol: string }>> = Array.from({ length: totalMeasures }, () => []);
  let lastSymbol = '';
  for (const c of [...(opts.chords ?? [])].sort((a, b) => a.startBeat - b.startBeat)) {
    if (c.symbol === lastSymbol) continue;
    lastSymbol = c.symbol;
    const col = Math.max(0, Math.round(c.startBeat / grid));
    const m = Math.floor(col / stepsPerMeasure);
    if (m < totalMeasures) chordsPer[m].push({ col, symbol: c.symbol });
  }

  const measures: TabLayoutMeasure[] = perMeasure.map((list, m) => {
    const startCol = m * stepsPerMeasure;
    const empty = list.length === 0;
    const width = empty ? emptyWidth : fullWidth;
    const scale = empty ? (width - TAB_PAD_LEFT - TAB_PAD_RIGHT) / (stepsPerMeasure * opts.colWidth) : 1;
    const xOf = (col: number) => TAB_PAD_LEFT + (col - startCol + 0.5) * opts.colWidth * scale;
    const chords: TabLayoutChord[] = [];
    for (const c of chordsPer[m]) {
      const x = TAB_PAD_LEFT + (c.col - startCol) * opts.colWidth * scale;
      const prev = chords[chords.length - 1];
      if (prev && x - prev.x < prev.symbol.length * 7 + 8) continue; // don't let chord names collide
      chords.push({ x, symbol: c.symbol });
    }
    return {
      index: m,
      startCol,
      startBeat: m * opts.beatsPerMeasure,
      x: 0,
      width,
      empty,
      notes: list.map((n) => ({ ...n, x: xOf(n.col) })),
      chords,
    };
  });

  const available = Math.max(fullWidth, opts.containerWidth - TAB_LABEL_WIDTH - 4);
  const staffHeight = (opts.strings - 1) * TAB_STRING_GAP;
  const rowHeight = TAB_STAFF_TOP + staffHeight + TAB_BOTTOM;
  const rowGap = 14;
  const rows: TabLayoutRow[] = [];
  let current: TabLayoutMeasure[] = [];
  let cursor = 0;
  const flush = () => {
    if (!current.length) return;
    rows.push({ index: rows.length, top: rows.length * (rowHeight + rowGap), width: cursor, measures: current });
    current = [];
    cursor = 0;
  };
  for (const m of measures) {
    if (cursor + m.width > available && current.length) flush();
    m.x = cursor;
    cursor += m.width;
    current.push(m);
  }
  flush();

  return {
    rows,
    rowHeight,
    rowGap,
    totalHeight: rows.length * (rowHeight + rowGap),
    maxRowWidth: rows.reduce((w, r) => Math.max(w, r.width), 0),
    labelWidth: TAB_LABEL_WIDTH,
    stringGap: TAB_STRING_GAP,
    staffTop: TAB_STAFF_TOP,
    grid,
    colWidth: opts.colWidth,
    stepsPerMeasure,
    stepsPerBeat,
    beatsPerMeasure: opts.beatsPerMeasure,
    padLeft: TAB_PAD_LEFT,
    padRight: TAB_PAD_RIGHT,
    strings: opts.strings,
    noteCount: qnotes.length,
    mergedCount: merged,
  };
}

/** x position (inside the row's music area) for a beat within a measure. */
export function beatX(layout: TabLayout, measure: TabLayoutMeasure, beat: number): number {
  const inner = measure.width - layout.padLeft - layout.padRight;
  const scale = inner / (layout.stepsPerMeasure * layout.colWidth);
  const cols = (beat - measure.startBeat) / layout.grid + 0.5; // a note's center is half a column after its start
  return measure.x + layout.padLeft + Math.max(0, Math.min(inner, cols * layout.colWidth * scale));
}

/** Finds the row / measure that contains a beat. */
export function locateBeat(layout: TabLayout, beat: number): { row: TabLayoutRow; measure: TabLayoutMeasure } | null {
  const m = Math.floor(beat / layout.beatsPerMeasure);
  for (const row of layout.rows) {
    const first = row.measures[0].index;
    const last = row.measures[row.measures.length - 1].index;
    if (m >= first && m <= last) return { row, measure: row.measures[m - first] };
  }
  return null;
}
