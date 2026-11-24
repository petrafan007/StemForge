import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MidiNoteEvent, NoteTuple } from '../types/music';
import { chordsFromNotes, deriveMusic, detectKey, drumTuplesToHits, simplifyPowerChords } from './musicAnalysis';
import { BASS_TUNINGS, GUITAR_TUNINGS, detectTuning, mapNotesToTab } from './notationEngine';
import { beatToTime, quarterBeatsPerMeasure, retimeBeat, timeToBeat } from './timeline';
import { defaultSettings, mergeSettings, applyGenrePreset } from '../settings/appSettings';
import { quantizeMidiNotes, encodeMidiFile } from './midiEncoder';

const note = (midi: number, startBeat: number, durationBeats = 1, velocity = 100): MidiNoteEvent => ({
  id: `${midi}-${startBeat}`,
  midi,
  startBeat,
  durationBeats,
  velocity,
  channel: 0,
});

test('simplifyPowerChords removes distortion overtones but keeps root, fifth and octave', () => {
  // E2 power chord (40, 47, 52) plus overtones the transcriber hears (59 = +19, 64 = +24)
  const chord: NoteTuple[] = [
    [1.0, 1.5, 40, 110],
    [1.01, 1.5, 47, 100],
    [1.0, 1.5, 52, 90],
    [1.02, 1.5, 59, 70],
    [1.0, 1.5, 64, 60],
  ];
  const out = simplifyPowerChords(chord);
  assert.deepEqual(out.map((n) => n[2]).sort((a, b) => a - b), [40, 47, 52]);
  // single notes are untouched
  assert.equal(simplifyPowerChords([[0, 1, 64, 100]]).length, 1);
});

test('timeline converts between seconds and beats with a beat-grid offset', () => {
  const grid = { bpm: 120, beatOffsetSec: 0.25 };
  assert.equal(timeToBeat(grid, 0.25), 0);
  assert.equal(timeToBeat(grid, 1.25), 2);
  assert.equal(beatToTime(grid, 4), 2.25);
  assert.equal(quarterBeatsPerMeasure([6, 8]), 3);
  assert.equal(quarterBeatsPerMeasure([7, 4]), 7);
  // a note at 2.25 s stays at 2.25 s after a tempo change
  const b = retimeBeat(4, grid, { bpm: 90, beatOffsetSec: 0.25 });
  assert.ok(Math.abs(beatToTime({ bpm: 90, beatOffsetSec: 0.25 }, b) - 2.25) < 1e-9);
});

test('detectTuning picks standard, drop and extended-range tunings from the lowest notes played', () => {
  const riff = (low: number) => Array.from({ length: 40 }, (_, i) => note(i % 4 === 0 ? low : low + 7 + (i % 3), i * 0.5, 0.5));
  const six = Object.values(GUITAR_TUNINGS).filter((t) => t.openMidi.length === 6);
  assert.equal(detectTuning(riff(41), six).id, 'standard'); // F2 riffs
  assert.equal(detectTuning(riff(38), six).id, 'dropD');
  assert.equal(detectTuning(riff(36), six).id, 'dropC');
  assert.equal(detectTuning(riff(35), Object.values(GUITAR_TUNINGS)).id, 'dropB');
  const bass4 = Object.values(BASS_TUNINGS).filter((t) => t.openMidi.length === 4);
  assert.equal(detectTuning(riff(29), bass4).id, 'standard4');
  assert.equal(detectTuning(riff(24), Object.values(BASS_TUNINGS)).id, 'dropC4');
});

test('drop-tuned riffs map onto playable frets of the detected tuning', () => {
  const notes = [note(36, 0), note(43, 0), note(48, 0), note(38, 1), note(45, 1)];
  const tab = mapNotesToTab(notes, GUITAR_TUNINGS.dropC);
  assert.equal(tab.length, 5);
  assert.ok(tab.every((t) => t.fret >= 0 && t.fret <= 5));
  assert.equal(tab.find((t) => t.midi === 36)?.fret, 0); // open low C
});

test('detectKey finds A minor and C major from note durations', () => {
  const aMinor = [57, 60, 64, 69, 62, 65, 64, 57, 59, 60, 57].map((m, i) => note(m, i, m === 57 ? 2 : 1));
  assert.deepEqual(detectKey([aMinor]), { rootPc: 9, mode: 'minor' });
  const cMajor = [60, 64, 67, 72, 65, 69, 67, 60, 62, 64, 60].map((m, i) => note(m, i, m === 60 ? 2 : 1));
  assert.deepEqual(detectKey([cMajor]), { rootPc: 0, mode: 'major' });
});

test('chordsFromNotes labels power chords as 5 chords and merges repeats', () => {
  const g = [note(40, 0, 2), note(47, 0, 2), note(52, 0, 2), note(40, 2, 2), note(47, 2, 2), note(45, 4, 4), note(52, 4, 4)];
  const chords = chordsFromNotes([g], [note(28, 0, 4), note(33, 4, 4)], [4, 4], 8);
  assert.equal(chords[0].symbol, 'E5');
  assert.equal(chords[0].durationBeats, 4);
  assert.equal(chords[1].symbol, 'A5');
});

test('drumTuplesToHits maps ADTOF / GM notes onto studio drum voices', () => {
  const hits = drumTuplesToHits(
    [
      [0.5, 36, 100],
      [0.75, 38, 90],
      [1.0, 47, 80],
      [1.0, 42, 70],
      [1.25, 49, 110],
      [1.5, 99, 50], // unknown -> dropped
    ],
    { bpm: 120, beatOffsetSec: 0.5 }
  );
  assert.deepEqual(hits.map((h) => h.voice), ['kick', 'snare', 'tom', 'hihat', 'crash']);
  assert.equal(hits[0].startBeat, 0);
  assert.equal(hits[2].midi, 45);
});

test('deriveMusic builds every part, chords and key from a server transcription', () => {
  const raw = {
    notes: {
      guitar: [
        [0.5, 1.0, 40, 100],
        [0.5, 1.0, 47, 100],
        [0.5, 1.0, 59, 50],
      ] as NoteTuple[],
      bass: [[0.5, 1.0, 28, 100]] as NoteTuple[],
      vocals: [[1, 2, 64, 90]] as NoteTuple[],
    },
    drums: [[0.5, 36, 100]] as Array<[number, number, number]>,
  };
  const d = deriveMusic(raw, { bpm: 120, beatOffsetSec: 0.5 }, 4, { simplifyPowerChords: true, timeSignature: [4, 4] });
  assert.equal(d.guitarNotes.length, 2);
  assert.equal(d.guitarNotes[0].startBeat, 0);
  assert.equal(d.bassNotes.length, 1);
  assert.equal(d.vocalNotes[0].startBeat, 1);
  assert.equal(d.drumHits.length, 1);
  assert.equal(d.leadNotes.length, 0);
  assert.equal(d.guitarParts, undefined, 'no left / right parts unless the server sends them');
});

test('deriveMusic keeps the left / right guitar parts with the same clean-up, chords from the combined part', () => {
  // left guitar plays E, the right guitar the B a fifth above; together they sound as E5
  const raw = {
    notes: {
      guitar: [
        [0.5, 1.0, 40, 100],
        [0.5, 1.0, 47, 100],
      ] as NoteTuple[],
    },
    guitarParts: {
      left: [
        [0.5, 1.0, 40, 100],
        [0.5, 1.0, 64, 40], // distortion overtone (two octaves up): removed like on the combined part
      ] as NoteTuple[],
      right: [[0.52, 1.0, 47, 100]] as NoteTuple[],
    },
    drums: [] as Array<[number, number, number]>,
  };
  const grid = { bpm: 120, beatOffsetSec: 0.5 };
  const d = deriveMusic(raw, grid, 4, { simplifyPowerChords: true, timeSignature: [4, 4] });
  assert.ok(d.guitarParts);
  assert.deepEqual(d.guitarParts.left.map((n) => n.midi), [40]);
  assert.deepEqual(d.guitarParts.right.map((n) => n.midi), [47]);
  assert.equal(d.guitarParts.left[0].id, 'gtr1-1');
  assert.equal(d.guitarParts.right[0].id, 'gtr2-1');
  assert.ok(Math.abs(d.guitarParts.right[0].startBeat - 0.04) < 1e-9);
  assert.equal(d.chords[0]?.symbol, 'E5');
  const raw2 = deriveMusic(raw, grid, 4, { simplifyPowerChords: false, timeSignature: [4, 4] });
  assert.deepEqual(raw2.guitarParts?.left.map((n) => n.midi), [40, 64], 'clean-up off keeps every note');
});

test('settings merge keeps defaults for missing keys and applies genre presets', () => {
  const merged = mergeSettings(defaultSettings(), { processing: { quality: 'high' }, unknown: 1, notation: { maxFret: 'bad' } });
  assert.equal(merged.processing.quality, 'high');
  assert.equal(merged.processing.splitGuitars, false);
  assert.equal(merged.notation.maxFret, 22);
  const metal = applyGenrePreset(defaultSettings(), 'metal');
  assert.equal(metal.genre, 'metal');
  assert.equal(metal.transcription.tempoMax, 260);
  assert.equal(metal.notation.allowExtendedRangeGuitar, true);
});

test('triplet / off quantize and Type 0 MIDI files', () => {
  const q = quantizeMidiNotes([note(60, 0.34, 0.3)], '1/8T');
  assert.ok(Math.abs(q[0].startBeat - 1 / 3) < 1e-9);
  assert.equal(quantizeMidiNotes([note(60, 0.34, 0.3)], 'off')[0].startBeat, 0.34);
  const bytes = encodeMidiFile({ bpm: 120, tracks: [{ name: 'A', notes: [note(60, 0)] }, { name: 'B', notes: [note(64, 1)] }], format: 0 });
  assert.equal((bytes[8] << 8) | bytes[9], 0); // format 0
  assert.equal((bytes[10] << 8) | bytes[11], 1); // single track
});

test('a tempo map maps beats to the real beat times and survives half / double time', async () => {
  const { mapBpm, scaleBeatMap, shiftBeatMap, tempoChanges } = await import('./timeline');
  const { gridWithChanges } = await import('./projectModel');
  // a band that speeds up: beats 0.5 s apart, then 0.4 s apart
  const beatTimes = [-0.2, 0.3, 0.8, 1.3, 1.8, 2.2, 2.6, 3.0, 3.4];
  const grid = { bpm: mapBpm(beatTimes), beatOffsetSec: beatTimes[0], beatTimes };
  assert.ok(Math.abs(timeToBeat(grid, 0.3) - 1) < 1e-9);
  assert.ok(Math.abs(timeToBeat(grid, 2.4) - 5.5) < 1e-9);
  assert.ok(Math.abs(beatToTime(grid, 5.5) - 2.4) < 1e-9);
  for (const t of [-1, 0, 0.55, 2.95, 5]) assert.ok(Math.abs(beatToTime(grid, timeToBeat(grid, t)) - t) < 1e-9);
  assert.equal(scaleBeatMap(beatTimes, 0.5).length, 5);
  assert.equal(scaleBeatMap(beatTimes, 2).length, 17);
  assert.deepEqual(shiftBeatMap([1, 2], 0.5), [1.5, 2.5]);
  const changes = tempoChanges(grid, 8);
  assert.equal(changes[0].bpm, 120);
  assert.equal(changes[1].beat, 4);
  assert.ok(Math.abs(changes[1].bpm - 150) < 1e-6);
  // ½× keeps the map (every other beat); typing another tempo switches to a fixed grid
  const half = gridWithChanges(grid, { bpm: grid.bpm / 2 });
  assert.deepEqual(half.beatTimes, scaleBeatMap(beatTimes, 0.5));
  const typed = gridWithChanges(grid, { bpm: 97 });
  assert.equal(typed.beatTimes, undefined);
  assert.equal(typed.bpm, 97);
  const shifted = gridWithChanges(grid, { beatOffsetSec: -0.1 });
  assert.ok(Math.abs(shifted.beatTimes![1] - 0.4) < 1e-9);
});
