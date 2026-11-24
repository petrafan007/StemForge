import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRms,
  computeWaveformPeaks,
  detectPitchYin,
  extractMidSide,
  separateTransientHarmonic,
  transcribeDrumsToMidi,
  transcribeStemToMidi,
} from './stemDsp';

function makeSine(freq: number, sampleRate: number, durationSec: number, amp = 0.6): Float32Array {
  const len = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
  }
  return out;
}

test('computeWaveformPeaks normalizes peak array to [0, 1]', () => {
  const sine = makeSine(220, 44100, 0.2, 0.5);
  const peaks = computeWaveformPeaks(sine, 20);
  assert.equal(peaks.length, 20);
  assert.ok(Math.max(...peaks) <= 1.0001);
  assert.ok(Math.max(...peaks) > 0.95);
});

test('extractMidSide isolates center mono signal vs stereo side signal', () => {
  const left = new Float32Array([0.8, 0.8, 0.8, 0.8]);
  const right = new Float32Array([0.8, 0.8, 0.8, 0.8]);
  const { mid, side, centerIsolated } = extractMidSide(left, right);
  assert.ok(Math.abs(mid[0] - 0.8) < 1e-5);
  assert.ok(Math.abs(side[0]) < 1e-5);
  assert.ok(Math.abs(centerIsolated[0] - 0.8) < 1e-3);

  // Pure hard-panned side signal should cancel from centerIsolated
  const sideOnly = extractMidSide(new Float32Array([0.8, 0.8]), new Float32Array([-0.8, -0.8]));
  assert.ok(Math.abs(sideOnly.mid[0]) < 1e-5);
  assert.ok(Math.abs(sideOnly.centerIsolated[0]) < 1e-5);
});

test('detectPitchYin accurately tracks 440 Hz (A4) and 110 Hz (A2)', () => {
  const sr = 44100;
  const a4 = makeSine(440, sr, 0.06);
  const freqA4 = detectPitchYin(a4, sr, 60, 1000);
  assert.ok(freqA4 !== null && Math.abs(freqA4 - 440) < 3, `Expected ~440Hz, got ${freqA4}`);

  const a2 = makeSine(110, sr, 0.08);
  const freqA2 = detectPitchYin(a2, sr, 50, 500);
  assert.ok(freqA2 !== null && Math.abs(freqA2 - 110) < 2, `Expected ~110Hz, got ${freqA2}`);
});

test('separateTransientHarmonic distinguishes sharp impulse from sustained tone', () => {
  const sr = 22050;
  const len = sr; // 1 second
  const sig = makeSine(220, sr, 1.0, 0.2);
  // Add a sharp kick-like transient at 0.5s
  const start = Math.floor(sr * 0.5);
  for (let i = 0; i < 120; i++) {
    sig[start + i] += Math.exp(-i / 35) * 0.95;
  }
  const { percussive, harmonic } = separateTransientHarmonic(sig, sr);
  const quietRegionRms = computeRms(percussive.subarray(2000, 4000));
  const transientRegionRms = computeRms(percussive.subarray(start, start + 150));
  assert.ok(transientRegionRms > quietRegionRms * 5, 'Transient energy should spike in percussive output');
  assert.ok(computeRms(harmonic) > 0.05, 'Sustained tone should remain in harmonic output');
});

test('transcribeStemToMidi extracts notes from synthesized 2-note melody', () => {
  const sr = 22050;
  const bpm = 120; // 0.5s per beat
  const totalLen = sr * 2; // 4 beats
  const buf = new Float32Array(totalLen);
  // Beat 0-2: A3 (220 Hz, MIDI 57), Beat 2-4: E4 (329.63 Hz, MIDI 64)
  for (let i = 0; i < sr; i++) {
    buf[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;
  }
  for (let i = sr; i < totalLen; i++) {
    buf[i] = Math.sin((2 * Math.PI * 329.63 * i) / sr) * 0.5;
  }

  const notes = transcribeStemToMidi(buf, sr, bpm, { minFreq: 80, maxFreq: 800 });
  assert.ok(notes.length >= 2, `Expected at least 2 transcribed notes, got ${notes.length}`);
  assert.equal(notes[0].midi, 57);
  assert.equal(notes[1].midi, 64);
});

test('transcribeDrumsToMidi detects synthetic low-frequency kick hits', () => {
  const sr = 22050;
  const bpm = 120; // 0.5s per beat
  const buf = new Float32Array(sr * 2);
  // Kick on beat 0 and beat 2
  for (const beat of [0, 2]) {
    const start = Math.floor(beat * 0.5 * sr);
    for (let i = 0; i < 2000 && start + i < buf.length; i++) {
      const t = i / sr;
      buf[start + i] = Math.sin(2 * Math.PI * 75 * t) * Math.exp(-t * 15) * 0.9;
    }
  }
  const hits = transcribeDrumsToMidi(buf, sr, bpm);
  const kicks = hits.filter((h) => h.voice === 'kick');
  assert.ok(kicks.length >= 2, `Expected at least 2 kicks detected, got ${kicks.length}`);
});
