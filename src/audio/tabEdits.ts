import type { MidiNoteEvent, NotationPart, SongProject } from '../types/music';
import { midiToNoteName } from './notationEngine';
import { partNotes } from './scoreExport';
import { barIndexAt, barStartsFor } from './bars';
import { beatToTime, timeToBeat, type BeatGrid } from './timeline';

/**
 * Tab corrections. The first edit of a part copies its automatic notes; from then on the part shows
 * the corrected copy (tabs, sheet music, MIDI and exports), saved with the song. Notes are kept in
 * seconds so tempo / grid changes and re-transcription don't move them. Bars the user marks as
 * checked form a real-song answer key: the automatic transcription is scored against them.
 */

/** One note of a corrected part. `string` pins the fingering (0 = highest string). */
export interface EditedNote {
  id: number;
  t: number; // start (s)
  d: number; // duration (s)
  midi: number;
  vel: number;
  string?: number;
}

export interface PartEdit {
  notes: EditedNote[];
  /** Start times (s) of the bars the user has checked against the recording (bar lines can move). */
  checkedAt: number[];
  nextId: number;
}

export type TabEdits = Partial<Record<NotationPart, PartEdit>>;

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Copies a part's current (automatic) notes as the start of its corrected version. */
export function snapshotPart(project: SongProject, part: NotationPart): PartEdit {
  const notes = partNotes(project, part).map((n, i) => {
    const t = beatToTime(project, n.startBeat);
    return { id: i + 1, t: round(t), d: round(Math.max(0.02, beatToTime(project, n.startBeat + n.durationBeats) - t)), midi: n.midi, vel: n.velocity };
  });
  return { notes, checkedAt: [], nextId: notes.length + 1 };
}

export const editedNoteId = (part: NotationPart, id: number) => `edit-${part}-${id}`;

/** A corrected part as studio notes on the current beat grid. */
export function editedPartNotes(grid: BeatGrid, part: NotationPart, edit: PartEdit): MidiNoteEvent[] {
  return edit.notes
    .map((n) => {
      const startBeat = timeToBeat(grid, n.t);
      return {
        id: editedNoteId(part, n.id),
        midi: n.midi,
        startBeat: Math.max(0, startBeat),
        durationBeats: Math.max(0.0625, timeToBeat(grid, n.t + n.d) - startBeat),
        velocity: n.vel,
        channel: 0,
        label: midiToNoteName(n.midi),
        ...(n.string !== undefined ? { stringIndex: n.string } : {}),
      };
    })
    .sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
}

/** The project with every corrected part replacing its automatic notes. */
export function applyTabEdits(project: SongProject, edits: TabEdits): SongProject {
  const parts = Object.keys(edits) as NotationPart[];
  if (!parts.length) return project;
  let next: SongProject = { ...project };
  for (const part of parts) {
    const edit = edits[part];
    if (!edit) continue;
    const notes = editedPartNotes(project, part, edit);
    if (part === 'guitar') next = { ...next, guitarNotes: notes };
    else if (part === 'lead') next = { ...next, leadNotes: notes };
    else if (part === 'bass') next = { ...next, bassNotes: notes };
    else if (next.guitarParts) next = { ...next, guitarParts: { ...next.guitarParts, [part === 'guitar1' ? 'left' : 'right']: notes } };
  }
  return next;
}

// ------------------------------------------------------------------------------- edit operations

export function updateNote(edit: PartEdit, id: number, patch: Partial<Omit<EditedNote, 'id'>>): PartEdit {
  return { ...edit, notes: edit.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

export function deleteNote(edit: PartEdit, id: number): PartEdit {
  return { ...edit, notes: edit.notes.filter((n) => n.id !== id) };
}

export function addNote(edit: PartEdit, note: Omit<EditedNote, 'id'>): { edit: PartEdit; id: number } {
  const id = edit.nextId;
  return { edit: { ...edit, notes: [...edit.notes, { ...note, id }].sort((a, b) => a.t - b.t || a.midi - b.midi), nextId: id + 1 }, id };
}

/** Marks / unmarks the bar that starts at `barStartTime` (s) as checked. */
export function toggleChecked(edit: PartEdit, barStartTime: number, on?: boolean): PartEdit {
  const t = Math.round(barStartTime * 1000) / 1000;
  const has = edit.checkedAt.some((x) => Math.abs(x - t) < 0.02);
  const want = on ?? !has;
  if (want === has) return edit;
  return { ...edit, checkedAt: want ? [...edit.checkedAt, t].sort((a, b) => a - b) : edit.checkedAt.filter((x) => Math.abs(x - t) >= 0.02) };
}

/** Indices of the checked bars under the song's current bar lines. */
export function checkedBarIndices(project: SongProject, edit: PartEdit): Set<number> {
  const starts = barStartsFor(project);
  return new Set(edit.checkedAt.map((t) => barIndexAt(starts, timeToBeat(project, t) + 1e-6)));
}

/** Parses the id of a corrected note from a studio note id ("edit-guitar1-17" -> 17). */
export function parseEditedId(id: string): number | null {
  const m = /^edit-[a-z0-9]+-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------------------- scoring

export interface CorrectionScore {
  bars: number; // checked bars
  reference: number; // corrected notes in them
  detected: number; // automatic notes in them
  matched: number; // same pitch, attack within 50 ms
  precision: number;
  recall: number;
  f: number;
}

/**
 * The automatic transcription scored against the user's corrections, in the checked bars only:
 * a note counts when the corrected part has the same pitch starting within `tolerance` seconds.
 */
export function scoreAgainstCorrections(project: SongProject, auto: MidiNoteEvent[], edit: PartEdit, tolerance = 0.05): CorrectionScore | null {
  if (!edit.checkedAt.length) return null;
  const starts = barStartsFor(project);
  const checked = checkedBarIndices(project, edit);
  const inChecked = (beat: number) => checked.has(barIndexAt(starts, beat));
  const ref = edit.notes.filter((n) => inChecked(timeToBeat(project, n.t)));
  const est = auto.filter((n) => inChecked(n.startBeat)).map((n) => ({ t: beatToTime(project, n.startBeat), midi: n.midi }));
  const used = new Set<number>();
  let matched = 0;
  for (const r of ref) {
    let best = -1;
    let bestDt = tolerance + 1e-9;
    est.forEach((e, i) => {
      const dt = Math.abs(e.t - r.t);
      if (!used.has(i) && e.midi === r.midi && dt <= bestDt) {
        best = i;
        bestDt = dt;
      }
    });
    if (best >= 0) {
      used.add(best);
      matched += 1;
    }
  }
  const precision = est.length ? matched / est.length : ref.length ? 0 : 1;
  const recall = ref.length ? matched / ref.length : 1;
  const f = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { bars: checked.size, reference: ref.length, detected: est.length, matched, precision, recall, f };
}

/** Validates stored corrections (from a saved project state). */
export function parseTabEdits(raw: unknown): TabEdits {
  const out: TabEdits = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const part of ['guitar', 'guitar1', 'guitar2', 'lead', 'bass'] as NotationPart[]) {
    const e = (raw as Record<string, unknown>)[part] as Partial<PartEdit> | undefined;
    if (!e || !Array.isArray(e.notes)) continue;
    const notes = e.notes
      .filter((n): n is EditedNote => Boolean(n) && typeof n.t === 'number' && typeof n.d === 'number' && typeof n.midi === 'number' && typeof n.id === 'number')
      .map((n) => ({ id: n.id, t: n.t, d: n.d, midi: n.midi, vel: typeof n.vel === 'number' ? n.vel : 100, ...(typeof n.string === 'number' ? { string: n.string } : {}) }));
    const checkedAt = Array.isArray(e.checkedAt) ? e.checkedAt.filter((b): b is number => typeof b === 'number') : [];
    const nextId = typeof e.nextId === 'number' ? e.nextId : notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    out[part] = { notes, checkedAt, nextId };
  }
  return out;
}
