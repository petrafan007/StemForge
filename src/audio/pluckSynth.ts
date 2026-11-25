import { midiToFrequency } from './notationEngine';

/**
 * Plucked-string synth for hearing tabs, sheet music and chords (Karplus-Strong). Each pitch is
 * rendered once into a short buffer and cached; a note plays that buffer, damped when the note ends.
 */

export type PluckInstrument = 'guitar' | 'bass';

interface PluckVoice {
  /** Ring time (s) of a low note; higher notes ring shorter. */
  ring: number;
  /** 0..1: how bright the pick attack is (low = softer, rounder). */
  bright: number;
  /** Buffer length (s): notes longer than this fade with it. */
  seconds: number;
  /** Lowpass after the string (Hz). */
  tone: number;
}

export const PLUCK_VOICES: Record<PluckInstrument, PluckVoice> = {
  guitar: { ring: 3.2, bright: 0.62, seconds: 2.4, tone: 5200 },
  bass: { ring: 3.6, bright: 0.3, seconds: 2.6, tone: 1800 },
};

/**
 * One plucked string (Karplus-Strong): a noise burst circulating in a delay line one period long,
 * averaged each pass. The loop is a whole number of samples and averaging with the next sample
 * shortens it by half a sample (`period` - 0.5), so `rate` is the playback rate that puts it on pitch.
 */
export function renderPluck(midi: number, sampleRate: number, voice: PluckVoice, random: () => number = Math.random): { data: Float32Array; rate: number } {
  const freq = midiToFrequency(midi);
  const period = Math.max(2, Math.round(sampleRate / freq + 0.5));
  const rate = (freq * (period - 0.5)) / sampleRate;
  const length = Math.floor(sampleRate * voice.seconds);
  const data = new Float32Array(length);
  // pick attack: lowpassed noise, without DC
  const line = new Float32Array(period);
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < period; i++) {
    lp += voice.bright * (random() * 2 - 1 - lp);
    line[i] = lp;
    mean += lp;
  }
  mean /= period;
  let peak = 1e-9;
  for (let i = 0; i < period; i++) {
    line[i] -= mean;
    peak = Math.max(peak, Math.abs(line[i]));
  }
  for (let i = 0; i < period; i++) line[i] /= peak;
  // loss per pass so the note fades by 60 dB over its ring time (shorter for higher notes)
  const ring = voice.ring * Math.min(1, Math.pow(110 / freq, 0.35));
  const loss = Math.pow(0.001, 1 / Math.max(1, freq * ring));
  let idx = 0;
  for (let n = 0; n < length; n++) {
    const cur = line[idx];
    const next = line[idx + 1 === period ? 0 : idx + 1];
    data[n] = cur;
    line[idx] = loss * 0.5 * (cur + next);
    idx = idx + 1 === period ? 0 : idx + 1;
  }
  // short fade at the end of the buffer
  const fade = Math.min(length, Math.floor(sampleRate * 0.05));
  for (let n = 0; n < fade; n++) data[length - 1 - n] *= n / fade;
  return { data, rate };
}

/** A note to play: times in quarter-note beats, `midi` is the pitch to sound (key change included). */
export interface PartVoice {
  beat: number;
  endBeat: number;
  midi: number;
  velocity: number;
}

/** Index of the first voice starting at or after `beat` (voices sorted by beat). */
export function firstVoiceAt(voices: PartVoice[], beat: number): number {
  let lo = 0;
  let hi = voices.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (voices[mid].beat < beat) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
