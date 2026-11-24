import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotationPart, SongProject } from '../types/music';
import type { TuningPreset } from '../audio/notationEngine';
import { partNotes } from '../audio/scoreExport';
import type { TabLayout, TabLayoutNote } from '../audio/tabLayout';
import {
  addNote,
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
 * Tab correction mode: select / add / change / delete notes with the mouse and keyboard, mark bars
 * as checked, undo / redo. Edits go to the part's corrected copy (src/audio/tabEdits.ts).
 *
 * Keys (while a note is selected): 0-9 type a fret (two digits within 0.7 s, e.g. 1 then 2 = 12),
 * Up / Down move the note to the next string at the same pitch, Shift+Up / Down change the pitch by
 * a semitone, Left / Right select the previous / next note, Delete removes it, Escape deselects,
 * Ctrl+Z / Ctrl+Y undo / redo.
 */
export interface TabEditorOptions {
  project: SongProject; // with corrections applied (what is shown)
  autoProject: SongProject; // the automatic transcription
  part: NotationPart;
  edit: PartEdit | undefined;
  onTabEdit: (part: NotationPart, edit: PartEdit | undefined) => void;
  layout: TabLayout;
  tuning: TuningPreset;
  transpose: number;
  maxFret: number;
  beatsPerMeasure: number;
  onPreviewNote: (midi: number, durationSec?: number) => void;
}

export interface TabEditor {
  editing: boolean;
  start: () => void;
  stop: () => void;
  discard: () => void;
  selectedId: string | null;
  selectNote: (n: TabLayoutNote) => void;
  addAt: (col: number, stringIndex: number) => void;
  toggleBar: (bar: number) => void;
  checkedBars: Set<number>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  score: CorrectionScore | null;
}

export function useTabEditor(o: TabEditorOptions): TabEditor {
  const { project, autoProject, part, edit, onTabEdit, layout, tuning, transpose, maxFret, beatsPerMeasure, onPreviewNote } = o;
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [history, setHistory] = useState<{ past: PartEdit[]; future: PartEdit[] }>({ past: [], future: [] });
  const lastFret = useRef(0);
  const typed = useRef<{ value: number; at: number } | null>(null);

  useEffect(() => {
    setEditing(false);
    setSelected(null);
    setHistory({ past: [], future: [] });
  }, [part, autoProject.id]);

  const commit = useCallback(
    (next: PartEdit) => {
      if (edit) setHistory((h) => ({ past: [...h.past.slice(-199), edit], future: [] }));
      onTabEdit(part, next);
    },
    [edit, onTabEdit, part]
  );

  const barOfTime = useCallback((t: number) => Math.floor(timeToBeat(project, t) / beatsPerMeasure + 1e-9), [project, beatsPerMeasure]);

  // the notes as laid out (string / fret as shown), in reading order
  const shown = useMemo(() => {
    const list: TabLayoutNote[] = [];
    for (const row of layout.rows) for (const m of row.measures) list.push(...m.notes);
    return list.sort((a, b) => a.col - b.col || a.stringIndex - b.stringIndex);
  }, [layout]);
  const shownById = useMemo(() => new Map(shown.map((n) => [n.id, n])), [shown]);

  const start = useCallback(() => {
    if (!edit) onTabEdit(part, snapshotPart(autoProject, part));
    setEditing(true);
  }, [edit, onTabEdit, part, autoProject]);

  const stop = useCallback(() => {
    setEditing(false);
    setSelected(null);
  }, []);

  const discard = useCallback(() => {
    if (!window.confirm('Discard your corrections for this part and go back to the automatic transcription?')) return;
    onTabEdit(part, undefined);
    setHistory({ past: [], future: [] });
    setEditing(false);
    setSelected(null);
  }, [onTabEdit, part]);

  const selectNote = useCallback(
    (n: TabLayoutNote) => {
      onPreviewNote(n.midi, 0.4);
      const id = parseEditedId(n.id);
      if (id !== null) setSelected(id);
      lastFret.current = n.fret;
    },
    [onPreviewNote]
  );

  const addAt = useCallback(
    (col: number, stringIndex: number) => {
      if (!edit) return;
      const beat = col * layout.grid;
      const t = beatToTime(project, beat);
      const d = Math.max(0.02, beatToTime(project, beat + layout.grid) - t);
      const shownMidi = tuning.openMidi[stringIndex] + lastFret.current;
      const res = addNote(edit, { t: Math.round(t * 10000) / 10000, d: Math.round(d * 10000) / 10000, midi: shownMidi - transpose, vel: 100, string: stringIndex });
      commit(toggleChecked(res.edit, barOfTime(t), true));
      setSelected(res.id);
      onPreviewNote(shownMidi, 0.4);
    },
    [edit, layout.grid, project, tuning, transpose, commit, barOfTime, onPreviewNote]
  );

  const toggleBar = useCallback((bar: number) => edit && commit(toggleChecked(edit, bar)), [edit, commit]);

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
      if (ctrl) return;
      const note = selected !== null ? edit.notes.find((n) => n.id === selected) : undefined;
      const shownNote = note ? shownById.get(editedNoteId(part, note.id)) : undefined;
      if (e.key === 'Escape') return handled(), setSelected(null);
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        handled();
        if (!shown.length) return;
        const idx = shownNote ? shown.indexOf(shownNote) : -1;
        const nextIdx = idx < 0 ? (e.key === 'ArrowRight' ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, idx + (e.key === 'ArrowRight' ? 1 : -1)));
        const pick = shown[nextIdx];
        const id = parseEditedId(pick.id);
        if (id !== null) setSelected(id);
        onPreviewNote(pick.midi, 0.3);
        return;
      }
      if (!note || !shownNote) return;
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
        if (e.shiftKey) {
          // pitch +-1 on the same string
          const fret = shownNote.fret + (e.key === 'ArrowUp' ? 1 : -1);
          if (fret < 0 || fret > Math.max(maxFret, 24)) return;
          commit(toggleChecked(updateNote(edit, note.id, { midi: note.midi + (e.key === 'ArrowUp' ? 1 : -1), string: shownNote.stringIndex }), bar, true));
          onPreviewNote(shownNote.midi + (e.key === 'ArrowUp' ? 1 : -1), 0.3);
          lastFret.current = fret;
        } else {
          // same pitch on the neighbouring string (index 0 = highest string, drawn on top)
          const s = shownNote.stringIndex + (e.key === 'ArrowUp' ? -1 : 1);
          if (s < 0 || s >= tuning.openMidi.length) return;
          const fret = shownNote.midi - tuning.openMidi[s];
          if (fret < 0 || fret > Math.max(maxFret, 24)) return;
          commit(toggleChecked(updateNote(edit, note.id, { string: s }), bar, true));
          lastFret.current = fret;
        }
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        handled();
        const digit = Number(e.key);
        const now = performance.now();
        const prev = typed.current;
        const fret = prev && now - prev.at < 700 && prev.value * 10 + digit <= Math.max(maxFret, 24) ? prev.value * 10 + digit : digit;
        typed.current = { value: fret, at: now };
        const shownMidi = tuning.openMidi[shownNote.stringIndex] + fret;
        commit(toggleChecked(updateNote(edit, note.id, { midi: shownMidi - transpose, string: shownNote.stringIndex }), bar, true));
        lastFret.current = fret;
        onPreviewNote(shownMidi, 0.3);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editing, edit, selected, shown, shownById, part, commit, undo, redo, barOfTime, tuning, transpose, maxFret, onPreviewNote]);

  const score = useMemo(() => (edit ? scoreAgainstCorrections(project, partNotes(autoProject, part), edit) : null), [edit, project, autoProject, part]);
  const checkedBars = useMemo(() => new Set(edit?.checked ?? []), [edit]);

  return {
    editing,
    start,
    stop,
    discard,
    selectedId: selected !== null ? editedNoteId(part, selected) : null,
    selectNote,
    addAt,
    toggleBar,
    checkedBars,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    score,
  };
}
