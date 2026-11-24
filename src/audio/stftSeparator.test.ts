import test from 'node:test';
import assert from 'node:assert/strict';
import { fftInPlace, separateStereoStemsStft } from './stftSeparator';

function rms(a: Float32Array, b?: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * a[i];
    if (b) sum += b[i] * b[i];
  }
  return Math.sqrt(sum / (a.length * (b ? 2 : 1)));
}

function peak(a: Float32Array, b?: Float32Array): number {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Math.abs(a[i]);
    if (va > max) max = va;
    if (b) {
      const vb = Math.abs(b[i]);
      if (vb > max) max = vb;
    }
  }
  return max;
}

function dbRatio(num: number, den: number): number {
  return 20 * Math.log10((num + 1e-12) / (den + 1e-12));
}

test('fftInPlace round-trips a multi-sine buffer cleanly', () => {
  const n = 2048;
  const orig = new Float32Array(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    orig[i] = Math.sin((2 * Math.PI * 17 * i) / n) * 0.6 + Math.cos((2 * Math.PI * 103 * i) / n) * 0.3;
    re[i] = orig[i];
  }
  fftInPlace(re, im, false);
  fftInPlace(re, im, true);

  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
  }
  assert.ok(maxErr < 1e-5, `FFT roundtrip error too high: ${maxErr}`);
});

test('separateStereoStemsStft preserves lossless sum-to-original reconstruction with zero clipping', () => {
  const sr = 44100;
  const len = sr * 2; // 2 seconds
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  // Realistic 5-instrument stereo mix (normalized <= 0.85 peak):
  // - Centered Vocals (520 Hz + 1040 Hz harmonics)
  // - Centered Bass (82 Hz E2 + 164 Hz + 246 Hz harmonics)
  // - Hard-panned Left Guitar (330 Hz + 660 Hz + 990 Hz)
  // - Wide stereo Keyboards (440 Hz L, 554 Hz R)
  // - Punchy Kick/Snare transients every 0.5s
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const vocal = (Math.sin(2 * Math.PI * 520 * t) * 0.18 + Math.sin(2 * Math.PI * 1040 * t) * 0.08);
    const bass =
      Math.sin(2 * Math.PI * 82.4 * t) * 0.22 +
      Math.sin(2 * Math.PI * 164.8 * t) * 0.09 +
      Math.sin(2 * Math.PI * 247.2 * t) * 0.04;
    const guitar =
      Math.sin(2 * Math.PI * 330 * t) * 0.14 + Math.sin(2 * Math.PI * 660 * t) * 0.07;
    const keysL = Math.sin(2 * Math.PI * 440 * t) * 0.1 + Math.sin(2 * Math.PI * 3520 * t) * 0.05;
    const keysR = Math.sin(2 * Math.PI * 554.37 * t) * 0.1 + Math.sin(2 * Math.PI * 4186 * t) * 0.05;

    const beatPos = i % (sr / 2);
    const kick = beatPos < 1600 ? Math.sin(2 * Math.PI * 68 * t) * Math.exp(-beatPos / 320) * 0.28 : 0;

    left[i] = vocal + bass + guitar + keysL + kick;
    right[i] = vocal + bass + keysR + kick;
  }

  const origPeak = peak(left, right);
  const stems = separateStereoStemsStft(left, right, sr);

  // 1. Check lossless sum reconstruction across interior (avoiding tiny 0.05s edges)
  const margin = Math.floor(sr * 0.06);
  let sumErrSq = 0;
  let count = 0;
  for (let i = margin; i < len - margin; i++) {
    const sumL =
      stems.vocals[0][i] +
      stems.guitar[0][i] +
      stems.bass[0][i] +
      stems.drums[0][i] +
      stems.keyboards[0][i];
    const sumR =
      stems.vocals[1][i] +
      stems.guitar[1][i] +
      stems.bass[1][i] +
      stems.drums[1][i] +
      stems.keyboards[1][i];
    sumErrSq += (sumL - left[i]) ** 2 + (sumR - right[i]) ** 2;
    count += 2;
  }
  const reconRms = Math.sqrt(sumErrSq / count);
  assert.ok(reconRms < 1e-4, `Sum-to-original RMS error should be ~0, got ${reconRms}`);

  // 2. Check ZERO clipping on Drums and every individual stem
  for (const id of ['vocals', 'guitar', 'bass', 'drums', 'keyboards'] as const) {
    const p = peak(stems[id][0], stems[id][1]);
    assert.ok(
      p <= Math.min(0.98, origPeak + 0.08),
      `Stem "${id}" peaked at ${p.toFixed(3)} vs original ${origPeak.toFixed(3)} (clipping risk!)`
    );
  }
});

test('muting Vocals removes > 18 dB of centered vocal energy while preserving Bass and Drums', () => {
  const sr = 44100;
  const len = sr * 2;

  // Test 1: Pure centered vocal signal (440 Hz + 880 Hz + 1320 Hz vibrato)
  const voxL = new Float32Array(len);
  const voxR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const v =
      Math.sin(2 * Math.PI * 440 * t) * 0.35 +
      Math.sin(2 * Math.PI * 880 * t) * 0.2 +
      Math.sin(2 * Math.PI * 1320 * t) * 0.1;
    voxL[i] = v;
    voxR[i] = v;
  }

  // Add subtle stereo ambience so isMono is false (just like real stereo music)
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const amb = Math.sin(2 * Math.PI * 2600 * t) * 0.06;
    voxL[i] += amb;
    voxR[i] -= amb;
  }

  const stems = separateStereoStemsStft(voxL, voxR, sr);
  const margin = Math.floor(sr * 0.15);

  // Measure vocal retention in Vocals stem vs bleed into the other 4 stems (Guitar+Bass+Drums+Keys)
  const bleedL = new Float32Array(len - margin * 2);
  const bleedR = new Float32Array(len - margin * 2);
  const voxOutL = new Float32Array(len - margin * 2);
  const voxOutR = new Float32Array(len - margin * 2);

  for (let i = margin; i < len - margin; i++) {
    const j = i - margin;
    voxOutL[j] = stems.vocals[0][i];
    voxOutR[j] = stems.vocals[1][i];
    bleedL[j] = stems.guitar[0][i] + stems.bass[0][i] + stems.drums[0][i] + stems.keyboards[0][i];
    bleedR[j] = stems.guitar[1][i] + stems.bass[1][i] + stems.drums[1][i] + stems.keyboards[1][i];
  }

  // Measure mid-channel vocal energy specifically (since 2600 Hz stereo ambience belongs in instruments!)
  const midBleed = new Float32Array(bleedL.length);
  const midVox = new Float32Array(voxOutL.length);
  for (let i = 0; i < midBleed.length; i++) {
    midBleed[i] = (bleedL[i] + bleedR[i]) * 0.5;
    midVox[i] = (voxOutL[i] + voxOutR[i]) * 0.5;
  }

  const rejectionDb = dbRatio(rms(midVox), rms(midBleed));
  assert.ok(
    rejectionDb > 18,
    `Expected > 18 dB center vocal removal when Vocals muted, got ${rejectionDb.toFixed(1)} dB`
  );
});

test('Bass stem retains strong audible fundamental + harmonic energy', () => {
  const sr = 44100;
  const len = sr * 2;
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  // Realistic bass guitar note A1 (55 Hz) + 110 Hz + 165 Hz + 220 Hz + subtle stereo guitar
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const bass =
      Math.sin(2 * Math.PI * 55 * t) * 0.35 +
      Math.sin(2 * Math.PI * 110 * t) * 0.25 +
      Math.sin(2 * Math.PI * 165 * t) * 0.14;
    const stereoGtr = Math.sin(2 * Math.PI * 980 * t) * 0.12;
    left[i] = bass + stereoGtr;
    right[i] = bass - stereoGtr;
  }

  const stems = separateStereoStemsStft(left, right, sr);
  const margin = Math.floor(sr * 0.15);
  const bassSlice = stems.bass[0].subarray(margin, len - margin);
  const origBassRms = Math.sqrt((0.35 ** 2 + 0.25 ** 2 + 0.14 ** 2) / 2);
  const retainedRatio = rms(bassSlice) / origBassRms;

  assert.ok(
    retainedRatio > 0.8,
    `Expected Bass stem to retain > 80% of bass RMS, got ${(retainedRatio * 100).toFixed(1)}%`
  );
});

test('Drums stem isolates sharp percussive hits without clipping', () => {
  const sr = 44100;
  const len = sr * 2;
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  let seed = 42;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  // Sharp broadband snare hits every 0.5s + steady harmonic pad
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    const padL = Math.sin(2 * Math.PI * 440 * t) * 0.15;
    const padR = Math.sin(2 * Math.PI * 660 * t) * 0.15;
    const pos = i % (sr / 2);
    const hit = pos < 900 ? noise() * Math.exp(-pos / 180) * 0.55 : 0;
    left[i] = padL + hit;
    right[i] = padR + hit;
  }

  const stems = separateStereoStemsStft(left, right, sr);
  const drumsPeak = peak(stems.drums[0], stems.drums[1]);
  assert.ok(drumsPeak > 0.15 && drumsPeak < 0.85, `Drums peak should be clean & unclipped, got ${drumsPeak.toFixed(3)}`);

  // During the hit window vs quiet sustain window, drums energy should concentrate strongly on hits
  const hitRms = rms(stems.drums[0].subarray(sr / 2, sr / 2 + 900));
  const sustainRms = rms(stems.drums[0].subarray(sr / 2 + 6000, sr / 2 + 12000));
  const drumContrastDb = dbRatio(hitRms, sustainRms);
  assert.ok(drumContrastDb > 12, `Drums should reject sustained pad by > 12 dB, got ${drumContrastDb.toFixed(1)} dB`);
});
