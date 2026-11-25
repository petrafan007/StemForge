import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChordEvent, SongProject } from '../types/music';
import { chordVoices, notesToVoices, partStems, voicingPitches } from './partPlayback';
import { firstVoiceAt, PLUCK_VOICES, renderPluck } from './pluckSynth';
import { midiToFrequency } from './notationEngine';

/** Deterministic noise for the synth tests. */
function seeded(seed = 1): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/** Period (samples) of a signal: the lag with the strongest autocorrelation, refined to a fraction. */
function periodOf(data: Float32Array, minLag: number, maxLag: number): number {
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < 8192; i++) s += data[i] * data[i + lag];
    return s;
  };
  let best = minLag;
  let bestV = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = ac(lag);
    if (v > bestV) {
      bestV = v;
      best = lag;
    }
  }
  const a = ac(best - 1);
  const c = ac(best + 1);
  return best + (0.5 * (a - c)) / (a - 2 * bestV + c || 1);
}

test('the plucked string is on pitch and fades out', () => {
  const sr = 48000;
  for (const midi of [28, 40, 52, 64, 76]) {
    const voice = midi < 40 ? PLUCK_VOICES.bass : PLUCK_VOICES.guitar;
    const { data, rate } = renderPluck(midi, sr, voice, seeded(midi));
    const target = midiToFrequency(midi);
    const lag = periodOf(data, Math.floor((sr / target) * 0.8), Math.ceil((sr / target) * 1.2));
    const heard = (sr / lag) * rate;
    assert.ok(Math.abs(1200 * Math.log2(heard / target)) < 8, `midi ${midi}: ${heard.toFixed(2)} Hz vs ${target.toFixed(2)} Hz`);
    const rms = (from: number, to: number) => Math.sqrt(data.slice(from, to).reduce((s, x) => s + x * x, 0) / (to - from));
    assert.ok(rms(data.length - sr * 0.3, data.length - sr * 0.1) < rms(0, sr * 0.2) * 0.5, `midi ${midi} does not decay`);
    assert.ok(Math.max(...data.slice(0, 4000).map(Math.abs)) <= 1.0001);
  }
});

test('firstVoiceAt finds the first note at or after a beat', () => {
  const voices = notesToVoices([3, 1, 2, 2, 5].map((beat) => ({ beat, endBeat: beat + 0.5, midi: 40, velocity: 90 })));
  assert.deepEqual(voices.map((v) => v.beat), [1, 2, 2, 3, 5]);
  assert.equal(firstVoiceAt(voices, 0), 0);
  assert.equal(firstVoiceAt(voices, 2), 1);
  assert.equal(firstVoiceAt(voices, 2.1), 3);
  assert.equal(firstVoiceAt(voices, 9), 5);
});

const project = (stems: string[]) => ({ stems: Object.fromEntries(stems.map((s) => [s, {}])) }) as unknown as SongProject;

test('a part replaces the recorded track it was transcribed from', () => {
  const split = project(['vocals', 'guitar1', 'guitar2', 'lead', 'bass', 'drums']);
  assert.deepEqual(partStems(split, 'guitar1'), ['guitar1']);
  assert.deepEqual(partStems(split, 'guitar2'), ['guitar2']);
  assert.deepEqual(partStems(split, 'guitar'), ['guitar1', 'guitar2']);
  assert.deepEqual(partStems(split, 'lead'), ['lead']);
  assert.deepEqual(partStems(split, 'bass'), ['bass']);
  const plain = project(['vocals', 'guitar', 'bass', 'drums']);
  assert.deepEqual(partStems(plain, 'guitar'), ['guitar']);
  assert.deepEqual(partStems(plain, 'lead'), ['guitar']);
  assert.deepEqual(partStems(project(['vocals', 'drums']), 'bass'), []);
});

test('chord diagrams sound their notes; bass plays the root', () => {
  const am = voicingPitches({ rootPc: 9, quality: 'min' }, 'guitar', 0);
  assert.ok(am.length >= 4);
  assert.deepEqual([...new Set(am.map((m) => m % 12))].sort((a, b) => a - b), [0, 4, 9]); // A C E
  assert.ok(am.every((m, i) => i === 0 || m >= am[i - 1]), 'low to high');
  const bassAm = voicingPitches({ rootPc: 9, quality: 'min' }, 'bass', 0);
  assert.equal(bassAm.length, 1);
  assert.equal(bassAm[0] % 12, 9);
  // a key change moves the chord
  const up = voicingPitches({ rootPc: 9, quality: 'min' }, 'guitar', 2);
  assert.deepEqual([...new Set(up.map((m) => m % 12))].sort((a, b) => a - b), [2, 6, 11]); // B D F#
});

test('the chord chart is strummed at each chord and again at each bar line', () => {
  const chords: ChordEvent[] = [
    { id: 'a', symbol: 'Am', rootPc: 9, quality: 'min', startBeat: 0, durationBeats: 8 },
    { id: 'b', symbol: 'F', rootPc: 5, quality: 'maj', startBeat: 8, durationBeats: 2 },
    { id: 'c', symbol: 'C', rootPc: 0, quality: 'maj', startBeat: 10, durationBeats: 6 },
  ];
  const voices = chordVoices(chords, 'bass', 0, [0], 4, 0.02);
  // bass: one root per strum: Am at 0 and 4, F at 8, C at 10 and again at the bar line 12
  assert.deepEqual(voices.map((v) => v.beat), [0, 4, 8, 10, 12]);
  assert.deepEqual(voices.map((v) => v.endBeat), [4, 8, 10, 12, 16]);
  assert.deepEqual(voices.map((v) => v.midi % 12), [9, 9, 5, 0, 0]);
  const guitar = chordVoices(chords.slice(0, 1), 'guitar', 0, [0], 4, 0.02);
  const first = guitar.filter((v) => v.beat < 1);
  assert.ok(first.length >= 4);
  assert.ok(first.every((v, i) => Math.abs(v.beat - i * 0.02) < 1e-9), 'strummed low to high');
  assert.ok(first.every((v) => v.endBeat === 4));
});
