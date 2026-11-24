import type { ChordEvent, DrumHitEvent, DrumVoice, MidiNoteEvent } from '../types/music';
import { detectChordFromChroma, formatChordSymbol, frequencyToMidi, midiToNoteName } from './notationEngine';

/**
 * Downsamples PCM data into N normalized peak amplitudes [0..1] for canvas waveform rendering.
 */
export function computeWaveformPeaks(channelData: Float32Array, numBars = 180): number[] {
  if (channelData.length === 0 || numBars <= 0) return [];
  const blockSize = Math.max(1, Math.floor(channelData.length / numBars));
  const peaks: number[] = new Array(numBars);
  let globalMax = 1e-5;

  for (let i = 0; i < numBars; i++) {
    const start = i * blockSize;
    const end = Math.min(channelData.length, start + blockSize);
    let maxVal = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > maxVal) maxVal = abs;
    }
    peaks[i] = maxVal;
    if (maxVal > globalMax) globalMax = maxVal;
  }

  for (let i = 0; i < numBars; i++) {
    peaks[i] = Math.min(1, peaks[i] / globalMax);
  }
  return peaks;
}

export function computeRms(channelData: Float32Array): number {
  if (channelData.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < channelData.length; i++) {
    sum += channelData[i] * channelData[i];
  }
  return Math.sqrt(sum / channelData.length);
}

/**
 * Extracts Mid (center-panned, vocal-heavy) and Side (stereo-wide, guitars/keys) signals.
 */
export function extractMidSide(left: Float32Array, right: Float32Array): {
  mid: Float32Array;
  side: Float32Array;
  centerIsolated: Float32Array;
} {
  const len = Math.min(left.length, right.length);
  const mid = new Float32Array(len);
  const side = new Float32Array(len);
  const centerIsolated = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    const m = (left[i] + right[i]) * 0.5;
    const s = (left[i] - right[i]) * 0.5;
    mid[i] = m;
    side[i] = s;
    // Soft center suppression of side energy for stronger vocal isolation
    const sideMag = Math.abs(s);
    const midMag = Math.abs(m);
    const mask = midMag > 1e-6 ? Math.max(0, 1 - (sideMag / (midMag + 1e-5)) * 0.85) : 0;
    centerIsolated[i] = m * mask;
  }

  return { mid, side, centerIsolated };
}

/**
 * Separates percussive transients from sustained harmonic content using fast vs slow envelope tracking.
 */
export function separateTransientHarmonic(mono: Float32Array, sampleRate: number): {
  percussive: Float32Array;
  harmonic: Float32Array;
} {
  const len = mono.length;
  const percussive = new Float32Array(len);
  const harmonic = new Float32Array(len);

  const fastAlpha = Math.exp(-1 / (sampleRate * 0.004)); // 4ms attack follower
  const slowAlpha = Math.exp(-1 / (sampleRate * 0.055)); // 55ms sustain follower

  let fastEnv = 0;
  let slowEnv = 0;

  for (let i = 0; i < len; i++) {
    const x = mono[i];
    const abs = Math.abs(x);
    fastEnv = fastAlpha * fastEnv + (1 - fastAlpha) * abs;
    slowEnv = slowAlpha * slowEnv + (1 - slowAlpha) * abs;

    const ratio = fastEnv / (slowEnv + 1e-5);
    const transientMask = Math.max(0, Math.min(1, (ratio - 1.05) * 1.35));
    const harmonicMask = Math.max(0.12, 1 - transientMask * 0.85);

    percussive[i] = x * transientMask;
    harmonic[i] = x * harmonicMask;
  }

  return { percussive, harmonic };
}

/**
 * YIN-style normalized difference pitch detector for monophonic/dominant fundamental frequency.
 * Returns frequency in Hz or null if frame is unpitched/silent.
 */
export function detectPitchYin(
  frame: Float32Array,
  sampleRate: number,
  minFreq = 50,
  maxFreq = 1100,
  threshold = 0.2
): number | null {
  const rms = computeRms(frame);
  if (rms < 0.012) return null;

  const halfLen = Math.floor(frame.length / 2);
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(halfLen - 1, Math.floor(sampleRate / minFreq));
  if (minLag >= maxLag) return null;

  const diff = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    for (let i = 0; i < halfLen; i++) {
      const d = frame[i] - frame[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  const cmndf = new Float32Array(maxLag + 1);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += diff[tau];
    cmndf[tau] = runningSum > 0 ? (diff[tau] * tau) / runningSum : 1;
  }

  let bestTau = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= maxLag && cmndf[tau + 1] < cmndf[tau]) {
        tau++;
      }
      bestTau = tau;
      break;
    }
  }

  if (bestTau === -1) {
    // Fallback to global minimum if clearly periodic
    let minVal = 1;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmndf[tau] < minVal) {
        minVal = cmndf[tau];
        bestTau = tau;
      }
    }
    if (minVal > 0.35 || bestTau === -1) return null;
  }

  // Parabolic interpolation around bestTau
  let refinedTau = bestTau;
  if (bestTau > minLag && bestTau < maxLag) {
    const s0 = cmndf[bestTau - 1];
    const s1 = cmndf[bestTau];
    const s2 = cmndf[bestTau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-6) {
      refinedTau = bestTau + (s2 - s0) / denom;
    }
  }

  const freq = sampleRate / refinedTau;
  if (!Number.isFinite(freq) || freq < minFreq || freq > maxFreq) return null;
  return freq;
}

/**
 * Goertzel filter energy at a specific target frequency (fast single-bin DFT).
 */
export function goertzelEnergy(frame: Float32Array, sampleRate: number, targetFreq: number): number {
  const n = frame.length;
  const k = Math.round((n * targetFreq) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < n; i++) {
    // Hann window reduces spectral leakage
    const win = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    s0 = frame[i] * win + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.max(0, power) / (n * n);
}

/**
 * Computes a 12-bin pitch-class chroma vector over an audio slice (MIDI 36..83).
 */
export function computeChromaVector(frame: Float32Array, sampleRate: number): number[] {
  const chroma = new Array<number>(12).fill(0);
  // Check 3 octaves (C2..B4 -> MIDI 36..71) for clean harmonic chord capture
  for (let midi = 36; midi <= 71; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const e = goertzelEnergy(frame, sampleRate, freq);
    chroma[midi % 12] += Math.sqrt(e);
  }
  return chroma;
}

/**
 * Estimates BPM from onset energy autocorrelation in the 70-165 BPM range.
 */
export function estimateBpm(mono: Float32Array, sampleRate: number): number {
  const hop = Math.floor(sampleRate * 0.02); // 50 Hz envelope
  const numFrames = Math.floor(mono.length / hop);
  if (numFrames < 50) return 116;

  const env = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = mono[base + i];
      sum += v * v;
    }
    env[f] = Math.sqrt(sum / hop);
  }

  // First-order onset flux
  const flux = new Float32Array(numFrames);
  for (let f = 1; f < numFrames; f++) {
    flux[f] = Math.max(0, env[f] - env[f - 1]);
  }

  const envRate = sampleRate / hop;
  const minLag = Math.floor((60 / 165) * envRate);
  const maxLag = Math.min(Math.floor(numFrames / 2), Math.ceil((60 / 72) * envRate));

  let bestLag = Math.round((60 / 120) * envRate);
  let bestCorr = -1;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < numFrames - lag; i++) {
      corr += flux[i] * flux[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  const bpm = Math.round((60 * envRate) / bestLag);
  return Math.max(72, Math.min(165, bpm));
}

/**
 * Extracts quantized melodic MIDI notes from a guitar, bass, or keyboard AudioBuffer channel.
 */
export function transcribeStemToMidi(
  mono: Float32Array,
  sampleRate: number,
  bpm: number,
  options: {
    minFreq: number;
    maxFreq: number;
    channel?: number;
    prefix?: string;
    gridBeats?: number;
  }
): MidiNoteEvent[] {
  const gridBeats = options.gridBeats ?? 0.25; // 16th-note analysis grid
  const secPerBeat = 60 / bpm;
  const stepSec = gridBeats * secPerBeat;
  const totalBeats = mono.length / sampleRate / secPerBeat;
  const frameLen = Math.min(2048, Math.max(512, Math.floor(sampleRate * 0.045)));
  const channel = options.channel ?? 0;
  const prefix = options.prefix ?? 'note';

  const events: MidiNoteEvent[] = [];
  let activeNote: { midi: number; startBeat: number; velocity: number } | null = null;
  let idCounter = 1;

  for (let beat = 0; beat < totalBeats; beat += gridBeats) {
    const startSample = Math.floor(beat * secPerBeat * sampleRate);
    if (startSample + frameLen >= mono.length) break;

    const slice = mono.subarray(startSample, startSample + frameLen);
    const rms = computeRms(slice);
    const freq = rms > 0.015 ? detectPitchYin(slice, sampleRate, options.minFreq, options.maxFreq) : null;
    const midi = freq ? frequencyToMidi(freq) : null;
    const velocity = Math.max(38, Math.min(122, Math.round(rms * 380)));

    if (midi !== null) {
      if (activeNote && activeNote.midi === midi && beat - activeNote.startBeat < 3.5) {
        activeNote.velocity = Math.max(activeNote.velocity, velocity);
      } else {
        if (activeNote) {
          events.push({
            id: `${prefix}-${idCounter++}`,
            midi: activeNote.midi,
            startBeat: activeNote.startBeat,
            durationBeats: Math.max(gridBeats, beat - activeNote.startBeat),
            velocity: activeNote.velocity,
            channel,
            label: midiToNoteName(activeNote.midi),
          });
        }
        activeNote = { midi, startBeat: beat, velocity };
      }
    } else if (activeNote) {
      events.push({
        id: `${prefix}-${idCounter++}`,
        midi: activeNote.midi,
        startBeat: activeNote.startBeat,
        durationBeats: Math.max(gridBeats, beat - activeNote.startBeat),
        velocity: activeNote.velocity,
        channel,
        label: midiToNoteName(activeNote.midi),
      });
      activeNote = null;
    }
  }

  if (activeNote) {
    events.push({
      id: `${prefix}-${idCounter++}`,
      midi: activeNote.midi,
      startBeat: activeNote.startBeat,
      durationBeats: Math.max(gridBeats, Math.min(2, totalBeats - activeNote.startBeat)),
      velocity: activeNote.velocity,
      channel,
      label: midiToNoteName(activeNote.midi),
    });
  }

  return events;
}

/**
 * Detects multi-band drum hits (Kick, Snare, Hi-Hat, Tom, Crash) from a Drums stem PCM array.
 */
export function transcribeDrumsToMidi(
  mono: Float32Array,
  sampleRate: number,
  bpm: number
): DrumHitEvent[] {
  const gridBeats = 0.25; // 16th-note grid
  const secPerBeat = 60 / bpm;
  const totalBeats = mono.length / sampleRate / secPerBeat;
  const winLen = Math.min(1024, Math.floor(sampleRate * 0.025));

  const hits: DrumHitEvent[] = [];
  let prevLow = 0;
  let prevMid = 0;
  let prevHigh = 0;
  let idCounter = 1;

  for (let beat = 0; beat < totalBeats; beat += gridBeats) {
    const startSample = Math.floor(beat * secPerBeat * sampleRate);
    if (startSample + winLen >= mono.length) break;
    const slice = mono.subarray(startSample, startSample + winLen);

    // Measure low (kick ~75Hz), mid (snare ~220Hz + crack ~1200Hz), high (hi-hat/cymbal ~6500Hz)
    const lowE =
      Math.sqrt(goertzelEnergy(slice, sampleRate, 65)) +
      Math.sqrt(goertzelEnergy(slice, sampleRate, 95));
    const midE =
      Math.sqrt(goertzelEnergy(slice, sampleRate, 210)) +
      Math.sqrt(goertzelEnergy(slice, sampleRate, 1150));
    const highE =
      Math.sqrt(goertzelEnergy(slice, sampleRate, 5500)) +
      Math.sqrt(goertzelEnergy(slice, sampleRate, 8200));

    // Zero-crossing rate helps distinguish snare/hi-hat noise bursts from tonal lows
    let zcr = 0;
    for (let i = 1; i < slice.length; i++) {
      if ((slice[i] >= 0 && slice[i - 1] < 0) || (slice[i] < 0 && slice[i - 1] >= 0)) zcr++;
    }
    const zcrRatio = zcr / slice.length;

    const pushHit = (voice: DrumVoice, midi: number, energy: number) => {
      const vel = Math.max(55, Math.min(125, Math.round(energy * 480)));
      hits.push({
        id: `drum-${idCounter++}`,
        voice,
        midi,
        startBeat: Math.round(beat * 4) / 4,
        velocity: vel,
      });
    };

    if (lowE > 0.045 && lowE > prevLow * 1.15) {
      pushHit('kick', 36, lowE * 1.4);
    }
    if (midE > 0.04 && midE > prevMid * 1.15 && zcrRatio > 0.04) {
      pushHit('snare', 38, midE * 1.6);
    } else if (midE > 0.065 && lowE > 0.025 && zcrRatio <= 0.04) {
      pushHit('tom', 45, midE * 1.3);
    }
    if (highE > 0.014 && highE > prevHigh * 1.05 && zcrRatio > 0.1) {
      if (highE > 0.055) {
        pushHit('crash', 49, highE * 2.2);
      } else {
        pushHit('hihat', 42, highE * 2.5);
      }
    }

    prevLow = lowE * 0.65;
    prevMid = midE * 0.65;
    prevHigh = highE * 0.65;
  }

  return hits;
}

/**
 * Extracts a measure-by-measure chord progression from harmonic stems.
 */
export function transcribeChords(
  mono: Float32Array,
  sampleRate: number,
  bpm: number,
  beatsPerChord = 4
): ChordEvent[] {
  const secPerBeat = 60 / bpm;
  const totalBeats = mono.length / sampleRate / secPerBeat;
  const frameLen = Math.min(4096, Math.floor(sampleRate * 0.09));
  const chords: ChordEvent[] = [];
  let idCounter = 1;

  for (let beat = 0; beat < totalBeats - 0.5; beat += beatsPerChord) {
    const startSample = Math.floor((beat + 0.25) * secPerBeat * sampleRate);
    if (startSample + frameLen >= mono.length) break;

    const slice = mono.subarray(startSample, startSample + frameLen);
    const chroma = computeChromaVector(slice, sampleRate);
    const detected = detectChordFromChroma(chroma);

    chords.push({
      id: `chord-${idCounter++}`,
      symbol: formatChordSymbol(detected.rootPc, detected.quality),
      rootPc: detected.rootPc,
      quality: detected.quality,
      startBeat: beat,
      durationBeats: Math.min(beatsPerChord, totalBeats - beat),
    });
  }

  return chords;
}
