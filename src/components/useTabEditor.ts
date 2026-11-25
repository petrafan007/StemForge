import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotationPart, SongProject } from '../types/music';
import type { TuningPreset } from '../audio/notationEngine';
import { partNotes } from '../audio/scoreExport';
import { columnCount, type TabCell, type TabLayout, type TabLayoutNote } from '../audio/tabLayout';
import { barAt, barPosition } from '../audio/bars';
import {
  addNote,
  checkedBarIndices,
  deleteNote,
  editedNoteId,
  parseEditedId,
  scoreAgainstCorrections,
  snapshotPart,
  toggleChecked,
  updateNote,
  type CorrectionScore,
  type PartEdit,
} from '../audio/tabEdits';
import { beatToTime, timeToBeat } from '../audio/timeline';

/**
 * Tab correction mode. Edits go to the part's corrected copy (src/audio/tabEdits.ts).
 *
 * Mouse (src/components/TabStaff.tsx): a click selects a note or an empty spot (it never adds
 * anything), a double-click adds a note on an empty spot or removes a note, a drag over empty spots
 * adds a note on each (along a string for tremolo picking, across strings for a chord), a drag of a
 * note moves it, a click on a bar number marks the bar as checked.
 *
 * Keys (while a note or spot is selected): type a fret and press Enter (1, 1, Enter = 11), Escape
 * clears what was typed / the selection, Up / Down move a note to the next string at the same pitch
 * (or move the selected spot), Shift+Up / Down change a note's pitch by a semitone, Left / Right go to
 * the previous / next note (or move the spot), Delete removes the note, Ctrl+Z / Ctrl+Y undo / redo.
 */
export interface TabEditorOptions {
  project: SongProject; // with corrections applied (what is shown)
  autoProject: SongProject; // the automatic transcription
  part: NotationPart;
  edit: PartEdit | undefined;
  onTabEdit: (part: NotationPart, edit: PartEdit | undefined) => void;
  /** Edit mode on / off (owned by the page: the tab is laid out differently while editing). */
  editing: boolean;
  setEditing: (on: boolean) => void;
  layout: TabLayout;
  tuning: TuningPreset;
  transpose: number;
  maxFret: number;
  beatsPerMeasure: number;
  /** The song's bar starts (src/audio/bars.ts). */
  barStarts: number[];
  onPreviewNote: (midi: number, durationSec?: number) => void;
}

export interface TabEditor {
  editing: boolean;
  start: () => void;
  stop: () => void;
  discard: () => void;
  selectedId: string | null;
  /** The selected empty spot (a click on a string where there is no note). */
  selectedCell: TabCell | null;
  /** Digits typed for the selected note / spot, applied with Enter. */
  typedFret: string;
  /** The fret new notes get (the last one selected, typed or added). */
  fillFret: number;
  selectNote: (n: TabLayoutNote) => void;
  selectCell: (cell: TabCell | null) => void;
  /** Adds a note on each empty spot (occupied spots are skipped). */
  addNotes: (cells: TabCell[], fret?: number) => void;
  deleteNote: (n: TabLayoutNote) => void;
  /** Moves a note to another spot, keeping its fret number (a note already there is replaced). */
  moveNote: (n: TabLayoutNote, to: TabCell) => void;
  toggleBar: (bar: number) => void;
  checkedBars: Set<number>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  score: CorrectionScore | null;
}

const round = (x: number) => Math.round(x * 10000) / 10000;
const cellKey = (col: number, string: number) => `${col}:${string}`;
/** Highest fret that can be typed. */
const TOP_FRET = 24;

export function useTabEditor(o: TabEditorOptions): TabEditor {
  const { project, autoProject, part, edit, onTabEdit, editing, setEditing, layout, tuning, transpose, beatsPerMeasure, barStarts, onPreviewNote } = o;
  const topFret = Math.max(o.maxFret, TOP_FRET);
  const [selected, setSelected] = useState<number | null>(null);
  const [cell, setCell] = useState<TabCell | null>(null);
  const [typed, setTyped] = useState('');
  const [fillFret, setFillFret] = useState(0);
  const [history, setHistory] = useState<{ past: PartEdit[]; future: PartEdit[] }>({ past: [], future: [] });

  const clearSelection = useCallback(() => {
    setSelected(null);
    setCell(null);
    setTyped('');
  }, []);

  useEffect(() => {
    setEditing(false);
    clearSelection();
    setHistory({ past: [], future: [] });
  }, [part, autoProject.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // the notes as laid out (string / fret as shown), in reading order, and by spot
  const shown = useMemo(() => {
    const list: TabLayoutNote[] = [];
    for (const row of layout.rows) for (const m of row.measures) list.push(...m.notes);
    return list.sort((a, b) => a.col - b.col || a.stringIndex - b.stringIndex);
  }, [layout]);
  const shownById = useMemo(() => new Map(shown.map((n) => [n.id, n])), [shown]);

  const commit = useCallback(
    (next: PartEdit) => {
      if (edit) setHistory((h) => ({ past: [...h.past.slice(-199), edit], future: [] }));
      // Every note keeps the string it is shown on: without this, one added or changed note can make
      // the fingering search move the notes around it to other strings.
      const notes = next.notes.map((n) => {
        if (n.string !== undefined) return n;
        const s = shownById.get(editedNoteId(part, n.id));
        return s ? { ...n, string: s.stringIndex } : n;
      });
      onTabEdit(part, { ...next, notes });
    },
    [edit, onTabEdit, part, shownById]
  );

  /** Start time (s) of the bar that contains `t`: how checked bars are stored. */
  const barOfTime = useCallback(
    (t: number) => beatToTime(project, barPosition(barStarts, timeToBeat(project, t) + 1e-6, beatsPerMeasure).start),
    [project, barStarts, beatsPerMeasure]
  );
  const shownAt = useMemo(() => new Map(shown.map((n) => [cellKey(n.col, n.stringIndex), n])), [shown]);
  const lastCol = useMemo(() => Math.max(0, columnCount(layout) - 1), [layout]);

  const start = useCallback(() => {
    if (!edit) onTabEdit(part, snapshotPart(autoProject, part));
    setEditing(true);
  }, [edit, onTabEdit, part, autoProject, setEditing]);

  const stop = useCallback(() => {
    setEditing(false);
    clearSelection();
  }, [setEditing, clearSelection]);

  const discard = useCallback(() => {
    if (!window.confirm('Discard your corrections for this part and go back to the automatic transcription?')) return;
    onTabEdit(part, undefined);
    setHistory({ past: [], future: [] });
    setEditing(false);
    clearSelection();
  }, [onTabEdit, part, setEditing, clearSelection]);

  const selectNote = useCallback(
    (n: TabLayoutNote) => {
      onPreviewNote(n.midi, 0.4);
      const id = parseEditedId(n.id);
      if (id === null) return;
      setSelected(id);
      setCell(null);
      setTyped('');
      setFillFret(n.fret);
    },
    [onPreviewNote]
  );

  const selectCell = useCallback(
    (c: TabCell | null) => {
      const note = c ? shownAt.get(cellKey(c.col, c.string)) : undefined;
      if (note) return selectNote(note);
      setSelected(null);
      setCell(c ? { col: Math.max(0, Math.min(lastCol, c.col)), string: Math.max(0, Math.min(tuning.openMidi.length - 1, c.string)) } : null);
      setTyped('');
    },
    [shownAt, selectNote, lastCol, tuning]
  );

  const addNotes = useCallback(
    (cells: TabCell[], fret = fillFret) => {
      if (!edit || fret < 0 || fret > topFret) return;
      let next = edit;
      const ids: number[] = [];
      const seen = new Set<string>();
      for (const c of cells) {
        const key = cellKey(c.col, c.string);
        if (seen.has(key) || shownAt.has(key) || c.string < 0 || c.string >= tuning.openMidi.length || c.col < 0) continue;
        seen.add(key);
        const beat = c.col * layout.grid;
        const t = beatToTime(project, beat);
        const d = Math.max(0.02, beatToTime(project, beat + layout.grid) - t);
        const res = addNote(next, { t: round(t), d: round(d), midi: tuning.openMidi[c.string] + fret - transpose, vel: 100, string: c.string });
        next = toggleChecked(res.edit, barOfTime(t), true);
        ids.push(res.id);
      }
      if (!ids.length) return;
      commit(next);
      setFillFret(fret);
      setTyped('');
      setCell(null);
      setSelected(ids.length === 1 ? ids[0] : null);
      const first = cells.find((c) => !shownAt.has(cellKey(c.col, c.string))) ?? cells[0];
      onPreviewNote(tuning.openMidi[first.string] + fret, 0.4);
    },
    [edit, fillFret, topFret, shownAt, tuning, layout.grid, project, transpose, barOfTime, commit, onPreviewNote]
  );

  const removeNote = useCallback(
    (n: TabLayoutNote) => {
      const id = parseEditedId(n.id);
      const note = edit && id !== null ? edit.notes.find((x) => x.id === id) : undefined;
      if (!edit || !note || id === null) return;
      commit(toggleChecked(deleteNote(edit, id), barOfTime(note.t), true));
      // the spot stays selected, so a fret can be typed there right away
      setSelected(null);
      setTyped('');
      setCell({ col: n.col, string: n.stringIndex });
    },
    [edit, commit, barOfTime]
  );

  const moveNote = useCallback(
    (n: TabLayoutNote, to: TabCell) => {
      const id = parseEditedId(n.id);
      const note = edit && id !== null ? edit.notes.find((x) => x.id === id) : undefined;
      if (!edit || !note || id === null) return;
      const s = Math.max(0, Math.min(tuning.openMidi.length - 1, to.string));
      const dc = Math.max(0, Math.min(lastCol, to.col)) - n.col;
      if (!dc && s === n.stringIndex) return selectNote(n);
      // a sideways move keeps the note's timing inside its grid step
      const t = dc ? round(beatToTime(project, Math.max(0, timeToBeat(project, note.t) + dc * layout.grid))) : note.t;
      const shownMidi = tuning.openMidi[s] + n.fret;
      let next = edit;
      const there = shownAt.get(cellKey(n.col + dc, s));
      const thereId = there && there.id !== n.id ? parseEditedId(there.id) : null;
      if (thereId !== null) next = deleteNote(next, thereId);
      next = updateNote(next, id, { t, midi: shownMidi - transpose, string: s });
      next = { ...next, notes: [...next.notes].sort((a, b) => a.t - b.t || a.midi - b.midi) };
      next = toggleChecked(toggleChecked(next, barOfTime(note.t), true), barOfTime(t), true);
      commit(next);
      setSelected(id);
      setCell(null);
      setTyped('');
      setFillFret(n.fret);
      onPreviewNote(shownMidi, 0.3);
    },
    [edit, tuning, lastCol, project, layout.grid, shownAt, transpose, barOfTime, commit, selectNote, onPreviewNote]
  );

  const toggleBar = useCallback(
    (bar: number) => edit && commit(toggleChecked(edit, beatToTime(project, barAt(barStarts, bar, beatsPerMeasure).start))),
    [edit, commit, project, barStarts, beatsPerMeasure]
  );

  const undo = useCallback(() => {
    const prev = history.past[history.past.length - 1];
    if (!prev || !edit) return;
    setHistory({ past: history.past.slice(0, -1), future: [edit, ...history.future] });
    onTabEdit(part, prev);
  }, [history, edit, onTabEdit, part]);

  const redo = useCallback(() => {
    const next = history.future[0];
    if (!next || !edit) return;
    setHistory({ past: [...history.past, edit], future: history.future.slice(1) });
    onTabEdit(part, next);
  }, [history, edit, onTabEdit, part]);

  // keyboard
  useEffect(() => {
    if (!editing || !edit) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (ctrl && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) return handled(), undo();
      if (ctrl && (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) return handled(), redo();
      if (ctrl || e.altKey) return;
      const note = selected !== null ? edit.notes.find((n) => n.id === selected) : undefined;
      const shownNote = note ? shownById.get(editedNoteId(part, note.id)) : undefined;
      if (e.key === 'Escape') {
        if (!typed && !shownNote && !cell) return;
        handled();
        if (typed) setTyped('');
        else clearSelection();
        return;
      }
      // with nothing selected the keys keep their usual meaning (transport, stem mutes)
      if (!shownNote && !cell) return;

      // typing a fret: digits collect, Enter applies (0-24)
      if (/^[0-9]$/.test(e.key)) {
        handled();
        setTyped((prev) => {
          const next = (prev.length >= 2 ? '' : prev) + e.key;
          return Number(next) > topFret ? e.key : next;
        });
        return;
      }
      if (e.key === 'Enter') {
        handled();
        if (!typed) return;
        const fret = Number(typed);
        setTyped('');
        if (cell) return addNotes([cell], fret);
        if (!note || !shownNote) return;
        const shownMidi = tuning.openMidi[shownNote.stringIndex] + fret;
        commit(toggleChecked(updateNote(edit, note.id, { midi: shownMidi - transpose, string: shownNote.stringIndex }), barOfTime(note.t), true));
        setFillFret(fret);
        onPreviewNote(shownMidi, 0.3);
        return;
      }
      if (e.key === 'Backspace' && typed) {
        handled();
        setTyped((prev) => prev.slice(0, -1));
        return;
      }

      // an empty spot is selected: the arrows move it (onto a note = select that note)
      if (cell) {
        const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const d = step[e.key];
        if (d) {
          handled();
          selectCell({ col: cell.col + d[0], string: cell.string + d[1] });
        }
        return;
      }
      if (!note || !shownNote) return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        handled();
        const idx = shown.indexOf(shownNote);
        const pick = shown[Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)))];
        if (pick) selectNote(pick);
        return;
      }
      const bar = barOfTime(note.t);
      if (e.key === 'Delete' || e.key === 'Backspace') {
        handled();
        const idx = shown.indexOf(shownNote);
        const after = shown[idx + 1] ?? shown[idx - 1];
        commit(toggleChecked(deleteNote(edit, note.id), bar, true));
        setSelected(after ? parseEditedId(after.id) : null);
        return;
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        handled();
        setTyped('');
        if (e.shiftKey) {
          // pitch +-1 on the same string
          const fret = shownNote.fret + (e.key === 'ArrowUp' ? 1 : -1);
          if (fret < 0 || fret > topFret) return;
          commit(toggleChecked(updateNote(edit, note.id, { midi: note.midi + (e.key === 'ArrowUp' ? 1 : -1), string: shownNote.stringIndex }), bar, true));
          onPreviewNote(shownNote.midi + (e.key === 'ArrowUp' ? 1 : -1), 0.3);
          setFillFret(fret);
        } else {
          // same pitch on the neighbouring string (index 0 = highest string, drawn on top)
          const s = shownNote.stringIndex + (e.key === 'ArrowUp' ? -1 : 1);
          if (s < 0 || s >= tuning.openMidi.length) return;
          const fret = shownNote.midi - tuning.openMidi[s];
          if (fret < 0 || fret > topFret) return;
          commit(toggleChecked(updateNote(edit, note.id, { string: s }), bar, true));
          setFillFret(fret);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, edit, selected, cell, typed, shown, shownById, part, commit, undo, redo, barOfTime, tuning, transpose, topFret, addNotes, selectCell, selectNote, clearSelection, onPreviewNote]);

  const score = useMemo(() => (edit ? scoreAgainstCorrections(project, partNotes(autoProject, part), edit) : null), [edit, project, autoProject, part]);
  const checkedBars = useMemo(() => (edit ? checkedBarIndices(project, edit) : new Set<number>()), [edit, project]);

  return {
    editing,
    start,
    stop,
    discard,
    selectedId: selected !== null ? editedNoteId(part, selected) : null,
    selectedCell: cell,
    typedFret: typed,
    fillFret,
    selectNote,
    selectCell,
    addNotes,
    deleteNote: removeNote,
    moveNote,
    toggleBar,
    checkedBars,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    score,
  };
}
