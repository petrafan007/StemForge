import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MidiNoteEvent, SongProject, StemTrackData } from '../types/music';
import { buildAsciiTab, buildMusicXml, hasGuitarSides, notationParts, partLabel, partNotes, resolveTunings } from './scoreExport';
import { GUITAR_TUNINGS, mapNotesToTab } from './notationEngine';

const note = (id: string, midi: number, startBeat: number, durationBeats = 0.5): MidiNoteEvent => ({
  id,
  midi,
  startBeat,
  durationBeats,
  velocity: 100,
  channel: 0,
});

function project(opts: { lead?: boolean; sides?: boolean } = {}): SongProject {
  const stem = {} as StemTrackData;
  // left guitar: E2 riff; right guitar: the same riff a fifth up (B2); combined: E5 power chords
  const left = [note('l1', 40, 0), note('l2', 40, 0.5), note('l3', 43, 1)];
  const right = [note('r1', 47, 0), note('r2', 47, 0.5), note('r3', 50, 1)];
  return {
    id: 'p',
    title: 'Twin Riff',
    artist: '',
    sourceType: 'project',
    fileFormat: 'FLAC',
    duration: 8,
    bpm: 120,
    beatOffsetSec: 0,
    timeSignature: [4, 4],
    keyRootPc: 4,
    keyMode: 'minor',
    stems: { guitar: stem, bass: stem, ...(opts.lead ? { lead: stem } : {}) },
    keyboardMidi: [],
    drumHits: [],
    guitarNotes: [...left, ...right].sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi),
    ...(opts.sides ? { guitarParts: { left, right } } : {}),
    leadNotes: opts.lead ? [note('ld', 64, 2)] : [],
    bassNotes: [note('b1', 28, 0)],
    vocalNotes: [],
    chords: [],
  };
}

test('left / right guitar parts appear only when the project has them', () => {
  assert.deepEqual(notationParts(project()), ['guitar', 'bass']);
  assert.deepEqual(notationParts(project({ lead: true })), ['guitar', 'lead', 'bass']);
  assert.deepEqual(notationParts(project({ lead: true, sides: true })), ['guitar', 'guitar1', 'guitar2', 'lead', 'bass']);
  assert.equal(hasGuitarSides(project({ sides: true })), true);
  const empty = { ...project(), guitarParts: { left: [], right: [] } };
  assert.equal(hasGuitarSides(empty), false);
  assert.deepEqual(notationParts(empty), ['guitar', 'bass']);
});

test('part labels and notes for the left / right guitars', () => {
  const p = project({ lead: true, sides: true });
  assert.equal(partLabel(p, 'guitar'), 'Rhythm Guitar');
  assert.equal(partLabel(p, 'guitar1'), 'Rhythm Guitar 1 – Left');
  assert.equal(partLabel(p, 'guitar2'), 'Rhythm Guitar 2 – Right');
  assert.equal(partLabel(project({ sides: true }), 'guitar1'), 'Guitar 1 – Left');
  assert.deepEqual(partNotes(p, 'guitar1').map((n) => n.midi), [40, 40, 43]);
  assert.deepEqual(partNotes(p, 'guitar2').map((n) => n.midi), [47, 47, 50]);
  assert.equal(partNotes(project(), 'guitar1').length, 0);
});

test('each guitar part is tabbed with the shared tuning and fingered as a single-note riff', () => {
  const p = project({ lead: true, sides: true });
  const tunings = resolveTunings(p, { guitar: 'auto', bass: 'auto' }, { allowExtendedRangeGuitar: false, allowFiveStringBass: false });
  assert.equal(tunings.guitar.id, 'standard');
  const left = mapNotesToTab(partNotes(p, 'guitar1'), tunings.guitar, 0);
  const right = mapNotesToTab(partNotes(p, 'guitar2'), tunings.guitar, 0);
  // one note per attack (no double-stops), on the low strings
  assert.equal(left.length, 3);
  assert.equal(right.length, 3);
  assert.deepEqual(left.map((n) => `${n.stringIndex}:${n.fret}`), ['5:0', '5:0', '5:3']);
  assert.deepEqual(right.map((n) => n.midi), [47, 47, 50]);
  assert.ok(right.every((n) => n.fret <= 5), 'the fifth-up riff stays in the first position');
});

test('MusicXML and ASCII tab export the left / right guitars as their own parts', () => {
  const p = project({ lead: true, sides: true });
  const tunings = resolveTunings(p, { guitar: 'standard', bass: 'standard4' }, { allowExtendedRangeGuitar: false, allowFiveStringBass: false });
  const xml = buildMusicXml(p, { parts: ['guitar', 'guitar1', 'guitar2'], includeTab: true, transpose: 0, tunings, maxFret: 24, accidentals: 'auto' });
  assert.match(xml, /<part-name>Rhythm Guitar \(/);
  assert.match(xml, /<part-name>Rhythm Guitar 1 – Left \(/);
  assert.match(xml, /<part-name>Rhythm Guitar 2 – Right \(/);
  assert.match(xml, /<part-abbreviation>Gtr\. 1<\/part-abbreviation>/);
  // separate MIDI channels so the parts don't share an instrument in a score editor
  const channels = [...xml.matchAll(/<midi-channel>(\d+)<\/midi-channel>/g)].map((m) => Number(m[1]));
  assert.deepEqual(channels, [2, 6, 7]);
  assert.equal((xml.match(/<staff-tuning/g) ?? []).length, 3 * GUITAR_TUNINGS.standard.openMidi.length);

  const ascii = buildAsciiTab(p, 'guitar2', tunings.guitar, 0, 24);
  assert.match(ascii, /Twin Riff \(Rhythm Guitar 2 – Right\)/);
  // only the right guitar's three single notes (B, B, D) - none of the left guitar's E notes
  const frets = ascii
    .split('\n')
    .filter((l) => /^[EADGBe] \|/.test(l))
    .flatMap((l) => l.slice(3).match(/\d+/g) ?? []);
  assert.equal(frets.length, 3);
  assert.match(ascii, /^A \|2-----2-/m);
  assert.doesNotMatch(ascii, /^E \|0/m);
});
