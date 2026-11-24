import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoBarAnchors, barAt, barCountTo, barIndexAt, barStartsFor, barTimeSignature, computeBarStarts, isBarStart, toggleBarLine, DEFAULT_BAR_SETTINGS } from './bars';

test('regular bars without edits', () => {
  assert.deepEqual(computeBarStarts(16, 4, []), [0, 4, 8, 12]);
  assert.deepEqual(computeBarStarts(9, 3, []), [0, 3, 6]);
});

test('an anchor starts a bar; a removed line joins two bars; a one-beat bar joins the bar before', () => {
  assert.deepEqual(computeBarStarts(24, 4, [11]), [0, 4, 8, 11, 15, 19, 23], 'a 3/4 bar (8-11), then 4/4 from beat 11');
  assert.deepEqual(computeBarStarts(24, 4, [], [8]), [0, 4, 12, 16, 20], 'bars 4-8 and 8-12 joined');
  assert.deepEqual(computeBarStarts(24, 4, [9]), [0, 4, 9, 13, 17, 21], 'phase +1: one 5/4 bar (4-9) instead of a 1/4 bar');
  assert.deepEqual(computeBarStarts(24, 4, [10]), [0, 4, 8, 10, 14, 18, 22], 'a 2/4 bar stays');
  assert.deepEqual(computeBarStarts(24, 4, [11], [11]), [0, 4, 8, 12, 16, 20], 'removing an added line cancels it');
});

test('the tracker\'s downbeats move the bar phase only where several bars in a row agree', () => {
  // downbeats on beat 1 (phase 1) from beat 5, then back on phase 0 from 64, one stray downbeat at 30
  const db = [5, 9, 13, 17, 21, 30, 64, 68, 72, 76];
  assert.deepEqual(autoBarAnchors(db, 4), [5, 64]);
  assert.deepEqual(autoBarAnchors([1, 2, 7], 4), [], 'scattered downbeats change nothing');
  const starts = computeBarStarts(80, 4, autoBarAnchors(db, 4));
  assert.equal(starts[1], 5, 'bar 0 becomes a 5/4 bar, then bars start on the tracked downbeats');
  assert.ok(starts.includes(61) && starts.includes(64), 'a 3/4 bar (61-64) brings the phase back');
});

test('finding bars and their time signatures', () => {
  const s = [0, 4, 8, 11, 15];
  assert.equal(barIndexAt(s, 9.5), 2);
  assert.equal(barIndexAt(s, -1), 0);
  assert.deepEqual(barAt(s, 2, 4), { start: 8, length: 3 });
  assert.deepEqual(barAt(s, 6, 4), { start: 23, length: 4 }, 'regular bars after the listed ones');
  assert.equal(barCountTo(s, 16, 4), 5);
  assert.equal(barCountTo(s, 26, 4), 7, 'bars 15-19, 19-23 and 23-27 after the listed ones');
  assert.equal(barCountTo(s, 19, 4), 5);
  assert.deepEqual(barTimeSignature(3, 4), [3, 4]);
  assert.deepEqual(barTimeSignature(2.5, 4), [5, 8]);
  assert.ok(isBarStart(s, 11, 4) && isBarStart(s, 19, 4) && !isBarStart(s, 12, 4));
});

test('bar lines follow the tempo map and user edits stored in seconds', () => {
  const song = { bpm: 120, beatOffsetSec: 0, timeSignature: [4, 4] as [number, number], duration: 12, downbeatTimes: [2.5, 4.5, 6.5, 8.5] };
  // downbeats every 4 beats from beat 5 (0.5 s per beat)
  assert.deepEqual(barStartsFor(song).slice(0, 4), [0, 5, 9, 13]);
  const off = { ...song, barSettings: { ...DEFAULT_BAR_SETTINGS, auto: false } };
  assert.deepEqual(barStartsFor(off).slice(0, 4), [0, 4, 8, 12]);
  // user removes the line at beat 8 (4 s) and starts a bar at beat 14 (7 s)
  let settings = toggleBarLine(off.barSettings, barStartsFor(off), 8, 4, (b) => b * 0.5);
  assert.deepEqual(settings.remove, [4]);
  settings = toggleBarLine(settings, barStartsFor({ ...off, barSettings: settings }), 14, 7, (b) => b * 0.5);
  assert.deepEqual(barStartsFor({ ...off, barSettings: settings }).slice(0, 5), [0, 4, 12, 14, 18]);
  // toggling an added line again removes it
  settings = toggleBarLine(settings, barStartsFor({ ...off, barSettings: settings }), 14, 7, (b) => b * 0.5);
  assert.deepEqual(settings.add, []);
});

test('tabs, MusicXML, MIDI and text tabs follow bars of other lengths', async () => {
  const { layoutTab, locateBeat } = await import('./tabLayout');
  const { encodeMusicXml } = await import('./musicXml');
  const { encodeMidiFile } = await import('./midiEncoder');
  const { generateAsciiTab, GUITAR_TUNINGS } = await import('./notationEngine');
  const { timeSignatureChanges } = await import('./bars');
  const starts = [0, 4, 7, 11]; // 4/4, 3/4, 4/4 ...
  const notes = [0, 4, 6, 7, 11].map((b, i) => ({ id: `n${i}`, midi: 52, startBeat: b, durationBeats: 0.5, stringIndex: 2, fret: 2, velocity: 100 }));
  const layout = layoutTab(notes, { grid: 0.25, colWidth: 20, beatsPerMeasure: 4, totalBeats: 15, containerWidth: 4000, strings: 6, barStarts: starts });
  const measures = layout.rows.flatMap((r) => r.measures);
  assert.deepEqual(measures.map((m) => [m.startBeat, m.lengthBeats, m.notes.length]), [[0, 4, 1], [4, 3, 2], [7, 4, 1], [11, 4, 1]]);
  assert.ok(measures[1].width < measures[0].width, 'the 3/4 bar is narrower');
  assert.equal(locateBeat(layout, 7.5)?.measure.index, 2);

  const xml = encodeMusicXml({
    title: 't', bpm: 120, keyRootPc: 4, keyMode: 'minor', timeSignature: [4, 4], barStarts: starts,
    parts: [{ id: 'P1', name: 'Gtr', clef: 'guitar', notes: notes.map((n) => ({ ...n, channel: 0 })) }],
  });
  const times = [...xml.matchAll(/<time><beats>(\d+)<\/beats><beat-type>(\d+)<\/beat-type><\/time>/g)].map((m) => `${m[1]}/${m[2]}`);
  assert.deepEqual(times, ['4/4', '3/4', '4/4'], 'a time signature change at the 3/4 bar and back');

  const changes = timeSignatureChanges(starts, 4, 4);
  assert.deepEqual(changes, [{ beat: 0, num: 4, den: 4 }, { beat: 4, num: 3, den: 4 }, { beat: 7, num: 4, den: 4 }]);
  const midi = encodeMidiFile({ bpm: 120, timeSignatureChanges: changes, tracks: [] });
  const tsEvents = [...midi.keys()].filter((i) => midi[i] === 0xff && midi[i + 1] === 0x58).length;
  assert.equal(tsEvents, 3);

  const ascii = generateAsciiTab(notes, GUITAR_TUNINGS.standard, 't', 120, 4, 4, starts);
  const gLine = ascii.split('\n').find((l) => l.startsWith('G'))!;
  const segments = gLine.split('|').slice(1, 3);
  assert.deepEqual(segments.map((s) => s.length), [16 * 3, 12 * 3], 'a 4/4 bar has 16 sixteenth columns, the 3/4 bar 12');
});
