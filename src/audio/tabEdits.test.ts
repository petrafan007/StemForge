import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MidiNoteEvent, SongProject, StemTrackData } from '../types/music';
import { GUITAR_TUNINGS, mapNotesToTab } from './notationEngine';
import { partNotes } from './scoreExport';
import {
  addNote,
  applyTabEdits,
  deleteNote,
  editedPartNotes,
  parseEditedId,
  parseTabEdits,
  scoreAgainstCorrections,
  snapshotPart,
  toggleChecked,
  updateNote,
} from './tabEdits';

const note = (id: string, midi: number, startBeat: number, durationBeats = 0.5): MidiNoteEvent => ({ id, midi, startBeat, durationBeats, velocity: 100, channel: 0 });

function project(): SongProject {
  const stem = {} as StemTrackData;
  return {
    id: 'p',
    title: 'Riff',
    artist: '',
    sourceType: 'project',
    fileFormat: 'FLAC',
    duration: 8,
    bpm: 120, // 0.5 s per beat
    beatOffsetSec: 0,
    timeSignature: [4, 4],
    keyRootPc: 4,
    keyMode: 'minor',
    stems: { guitar1: stem, guitar2: stem, lead: stem, bass: stem },
    keyboardMidi: [],
    drumHits: [],
    guitarNotes: [note('g1', 40, 0), note('g2', 47, 0)],
    guitarParts: { left: [note('l1', 40, 0), note('l2', 40, 0.5), note('l3', 43, 1), note('l4', 45, 4.5)], right: [note('r1', 47, 0)] },
    leadNotes: [],
    bassNotes: [note('b1', 28, 0)],
    vocalNotes: [],
    chords: [],
  };
}

test('a corrected part starts as a copy of the automatic notes and survives a round trip', () => {
  const p = project();
  const edit = snapshotPart(p, 'guitar1');
  assert.equal(edit.notes.length, 4);
  assert.deepEqual(edit.notes.map((n) => n.t), [0, 0.25, 0.5, 2.25]);
  const back = editedPartNotes(p, 'guitar1', edit);
  assert.deepEqual(back.map((n) => [n.midi, n.startBeat]), [[40, 0], [40, 0.5], [43, 1], [45, 4.5]]);
  assert.equal(back[0].id, 'edit-guitar1-1');
  assert.equal(parseEditedId(back[2].id), 3);
});

test('edits replace only their own part and keep the user strings', () => {
  const p = project();
  let edit = snapshotPart(p, 'guitar1');
  edit = updateNote(edit, 3, { midi: 44, string: 4 }); // G2 -> G#2, on the A string
  edit = deleteNote(edit, 2);
  const res = addNote(edit, { t: 1.0, d: 0.25, midi: 52, vel: 90 });
  edit = res.edit;
  const out = applyTabEdits(p, { guitar1: edit });
  assert.deepEqual(partNotes(out, 'guitar1').map((n) => n.midi), [40, 44, 52, 45]);
  assert.equal(partNotes(out, 'guitar1')[1].stringIndex, 4);
  assert.deepEqual(partNotes(out, 'guitar2').map((n) => n.midi), [47], 'the other guitar is untouched');
  assert.equal(out.guitarNotes, p.guitarNotes);
  assert.equal(res.id, 5);
});

test('the fingering keeps a string the user chose', () => {
  const tuning = GUITAR_TUNINGS.standard;
  const auto = mapNotesToTab([note('a', 64, 0)], tuning, 0);
  assert.deepEqual([auto[0].stringIndex, auto[0].fret], [0, 0], 'E4 on the open high e by default');
  const pinned = mapNotesToTab([{ ...note('a', 64, 0), stringIndex: 1 }], tuning, 0);
  assert.deepEqual([pinned[0].stringIndex, pinned[0].fret], [1, 5], 'E4 on the B string, 5th fret, as the user set it');
  const chord = mapNotesToTab([{ ...note('a', 45, 0), stringIndex: 5 }, note('b', 52, 0)], tuning, 0);
  assert.deepEqual(chord.map((n) => `${n.stringIndex}:${n.fret}`).sort(), ['4:7', '5:5'], 'A on the low E string pulls its fifth along');
});

test('the automatic transcription is scored against the corrections in checked bars only', () => {
  const p = project();
  let edit = snapshotPart(p, 'guitar1');
  edit = updateNote(edit, 3, { midi: 44 }); // the automatic G2 was wrong
  edit = deleteNote(edit, 2); // a phantom note
  edit = addNote(edit, { t: 1.5, d: 0.25, midi: 40, vel: 100 }).edit; // a missed note (bar 1)
  assert.equal(scoreAgainstCorrections(p, partNotes(p, 'guitar1'), edit), null, 'nothing checked yet');
  edit = toggleChecked(edit, 0);
  const s = scoreAgainstCorrections(p, partNotes(p, 'guitar1'), edit)!;
  // bar 0 (beats 0-4): corrected E2@0s, G#2@0.5s, E2@1.5s vs automatic E2@0s, E2@0.25s, G2@0.5s:
  // only the first note is right (wrong pitch, phantom and missed note otherwise)
  assert.equal(s.bars, 1);
  assert.equal(s.reference, 3);
  assert.equal(s.detected, 3);
  assert.equal(s.matched, 1);
  assert.ok(Math.abs(s.f - 1 / 3) < 1e-9);
  assert.deepEqual(toggleChecked(edit, 0).checkedAt, [], 'toggling again unchecks');
});

test('stored corrections are validated when a song is opened', () => {
  const parsed = parseTabEdits({ guitar1: { notes: [{ id: 1, t: 0, d: 0.2, midi: 40, vel: 90, string: 5 }, { bad: true }], checkedAt: [0, 'x'] }, nonsense: {} });
  assert.equal(parsed.guitar1?.notes.length, 1);
  assert.deepEqual(parsed.guitar1?.checkedAt, [0]);
  assert.equal(parsed.guitar1?.nextId, 2);
  assert.deepEqual(parseTabEdits(null), {});
});
