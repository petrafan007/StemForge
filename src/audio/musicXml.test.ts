import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, encodeMusicXml, keyToFifths, splitDuration } from './musicXml';
import { GUITAR_TUNINGS, mapNotesToTab } from './notationEngine';
import { tuplesToMidiEvents } from './musicAnalysis';

test('keyToFifths maps major and minor keys onto the circle of fifths', () => {
  assert.equal(keyToFifths(0, 'major'), 0); // C
  assert.equal(keyToFifths(7, 'major'), 1); // G
  assert.equal(keyToFifths(5, 'major'), -1); // F
  assert.equal(keyToFifths(9, 'minor'), 0); // A minor
  assert.equal(keyToFifths(4, 'minor'), 1); // E minor
  assert.equal(keyToFifths(2, 'minor'), -1); // D minor
});

test('splitDuration breaks odd lengths into notatable values', () => {
  assert.deepEqual(splitDuration(16), [16]);
  assert.deepEqual(splitDuration(5), [4, 1]);
  assert.deepEqual(splitDuration(7), [6, 1]);
  assert.deepEqual(splitDuration(0), []);
});

test('buildTimeline merges simultaneous notes into chords and trims overlaps', () => {
  const items = buildTimeline([
    { startBeat: 0, durationBeats: 2, pitch: { midi: 60 } },
    { startBeat: 0.01, durationBeats: 2, pitch: { midi: 64 } },
    { startBeat: 1, durationBeats: 1, pitch: { midi: 67 } },
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].pitches.map((p) => p.midi), [60, 64]);
  assert.equal(items[0].dur, 4); // trimmed to the next onset (1 beat = 4 divisions)
  assert.equal(items[1].start, 4);
});

test('mapNotesToTab puts a chord on distinct strings', () => {
  // Open-position C major: C3 E3 G3 C4 E4
  const chord = [48, 52, 55, 60, 64].map((midi, i) => ({
    id: `c${i}`,
    midi,
    startBeat: 0,
    durationBeats: 2,
    velocity: 90,
    channel: 0,
  }));
  const tab = mapNotesToTab(chord, GUITAR_TUNINGS.standard);
  assert.equal(tab.length, 5);
  assert.equal(new Set(tab.map((t) => t.stringIndex)).size, 5);
  const frets = tab.filter((t) => t.fret > 0).map((t) => t.fret);
  assert.ok(Math.max(...frets) - Math.min(...frets) <= 5);
});

test('encodeMusicXml writes a guitar part with notation + TAB staves, chords and ties', () => {
  const notes = tuplesToMidiEvents(
    [
      [0, 1, 48, 90],
      [0, 1, 52, 90],
      [0, 1, 55, 90],
      [1.5, 3.5, 57, 80], // crosses the bar line at 120 BPM (beat 3 -> beat 7)
    ],
    { bpm: 120, beatOffsetSec: 0 },
    'gtr'
  );
  const tabNotes = mapNotesToTab(notes, GUITAR_TUNINGS.standard);
  const xml = encodeMusicXml({
    title: 'Test & Song',
    bpm: 120,
    keyRootPc: 0,
    keyMode: 'major',
    parts: [
      {
        id: 'P1',
        name: 'Guitar',
        clef: 'guitar',
        octaveDown: true,
        tab: { tuning: GUITAR_TUNINGS.standard, notes: tabNotes },
        midiProgram: 25,
      },
    ],
  });
  assert.ok(xml.startsWith('<?xml'));
  assert.ok(xml.includes('<work-title>Test &amp; Song</work-title>'));
  assert.ok(xml.includes('<staves>2</staves>'));
  assert.ok(xml.includes('<sign>TAB</sign>'));
  assert.ok(xml.includes('<staff-lines>6</staff-lines>'));
  assert.ok(xml.includes('<chord/>'));
  assert.ok(xml.includes('<tie type="start"/>'));
  assert.ok(xml.includes('<technical><string>'));
  assert.ok(xml.includes('<measure number="2">'));
  assert.ok(xml.includes('<per-minute>120</per-minute>'));
  // Every opened note element is closed
  assert.equal((xml.match(/<note>/g) || []).length, (xml.match(/<\/note>/g) || []).length);
});

test('tuplesToMidiEvents converts seconds to beats and drops invalid notes', () => {
  const ev = tuplesToMidiEvents(
    [
      [1, 1.5, 60, 100],
      [2, 1, 62, 100], // end before start -> dropped
    ],
    { bpm: 120, beatOffsetSec: 0 },
    'k'
  );
  assert.equal(ev.length, 1);
  assert.equal(ev[0].startBeat, 2);
  assert.equal(ev[0].durationBeats, 1);
});
