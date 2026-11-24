import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TabNoteEvent } from '../types/music';
import { beatX, layoutTab, locateBeat, quantizeTabNotes } from './tabLayout';
import { GUITAR_TUNINGS, generateAsciiTab } from './notationEngine';
import { encodeMusicXml } from './musicXml';

const tn = (stringIndex: number, fret: number, startBeat: number, durationBeats = 0.25, velocity = 100, id = `${stringIndex}-${startBeat}-${fret}`): TabNoteEvent => ({
  id,
  midi: 40 + fret,
  startBeat,
  durationBeats,
  stringIndex,
  fret,
  velocity,
});

test('quantizeTabNotes snaps to the grid and merges duplicates on the same string', () => {
  const { notes, merged } = quantizeTabNotes(
    [tn(4, 6, 1.0, 0.25, 80, 'a'), tn(4, 6, 1.02, 0.25, 110, 'b'), tn(4, 6, 1.26, 0.25, 90, 'c'), tn(3, 4, 1.0, 0.25, 90, 'd')],
    0.25
  );
  assert.equal(merged, 1);
  assert.equal(notes.length, 3);
  assert.equal(notes.find((n) => n.stringIndex === 4 && n.col === 4)?.id, 'b'); // the louder duplicate wins
});

test('layoutTab never places two notes on the same string closer than one column', () => {
  // A dense 16th-note metal riff with jittery timing and duplicate detections
  const notes: TabNoteEvent[] = [];
  for (let i = 0; i < 64; i++) {
    const jitter = (i % 3) * 0.02;
    notes.push(tn(5, i % 2 ? 0 : 3, i * 0.25 + jitter, 0.2, 100, `n${i}`));
    if (i % 4 === 0) notes.push(tn(5, 3, i * 0.25 + 0.03, 0.2, 60, `dup${i}`));
  }
  const layout = layoutTab(notes, { grid: 0.25, colWidth: 20, beatsPerMeasure: 4, totalBeats: 16, containerWidth: 900, strings: 6 });
  for (const row of layout.rows) {
    for (const m of row.measures) {
      const xs = m.notes.filter((n) => n.stringIndex === 5).map((n) => n.x).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 19.99, `notes too close: ${xs[i - 1]} / ${xs[i]}`);
    }
    assert.ok(row.width <= 900 - 30, 'row must fit the container');
  }
  assert.equal(layout.mergedCount, 16);
});

test('empty measures are compressed and locateBeat / beatX find the playhead', () => {
  const layout = layoutTab([tn(0, 5, 0), tn(0, 7, 8.5)], { grid: 0.25, colWidth: 20, beatsPerMeasure: 4, totalBeats: 12, containerWidth: 2000, strings: 6 });
  const [m0, m1, m2] = layout.rows[0].measures;
  assert.equal(m1.empty, true);
  assert.ok(m1.width < m0.width);
  const loc = locateBeat(layout, 8.5);
  assert.equal(loc?.measure.index, 2);
  const x = beatX(layout, m2, 8.5);
  assert.ok(Math.abs(x - (m2.x + m2.notes[0].x)) < 1e-6, 'playhead lines up with the note center');
});

test('ASCII tab uses 16th columns so fast notes do not overwrite each other', () => {
  const ascii = generateAsciiTab([tn(5, 3, 0), tn(5, 5, 0.25), tn(5, 12, 0.5)], GUITAR_TUNINGS.standard, 'Riff', 180);
  const low = ascii.split('\n').find((l) => l.startsWith('E'))!;
  assert.ok(low.startsWith('E |3--5--12-'), low);
});

test('MusicXML carries chord symbols as harmony elements', () => {
  const xml = encodeMusicXml({
    title: 'T',
    bpm: 120,
    keyRootPc: 4,
    keyMode: 'minor',
    chords: [
      { startBeat: 0, rootPc: 4, quality: '5' },
      { startBeat: 2, rootPc: 7, quality: 'maj' },
      { startBeat: 4, rootPc: 9, quality: 'm7' },
    ],
    parts: [{ id: 'P1', name: 'Gtr', clef: 'treble', notes: [{ id: 'a', midi: 64, startBeat: 0, durationBeats: 4, velocity: 90, channel: 0 }, { id: 'b', midi: 67, startBeat: 4, durationBeats: 4, velocity: 90, channel: 0 }] }],
  });
  assert.equal((xml.match(/<harmony>/g) || []).length, 3);
  assert.ok(xml.includes('<kind text="5">power</kind>'));
  assert.ok(xml.includes('<kind text="m7">minor-seventh</kind>'));
});

test('tab notes keep their real start so the highlight follows the audio, not the grid slot', () => {
  const n = (id: string, startBeat: number, fret: number): TabNoteEvent => ({ id, midi: 40 + fret, startBeat, durationBeats: 0.5, stringIndex: 5, fret, velocity: 100 });
  const { notes } = quantizeTabNotes([n('a', 0.11, 0), n('b', 0.62, 2)], 0.25);
  assert.equal(notes[0].col, 0); // drawn in the first 16th slot...
  assert.equal(notes[0].beat, 0.11); // ...but played 0.11 beats later
  assert.equal(notes[0].endBeat, 0.61);
  assert.ok(Math.abs(notes[0].endBeat - 0.61) < 1e-9);
  // a held note ends where the next note on the same string really starts
  const held = quantizeTabNotes([{ ...n('c', 0, 0), durationBeats: 2 }, n('d', 0.62, 2)], 0.25).notes;
  assert.equal(held[0].endBeat, 0.62);
});
