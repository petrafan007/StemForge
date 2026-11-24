import type {
  SeparationProgress,
  SongProject,
  StemId,
  StemTrackData,
} from '../types/music';
import {
  computeRms,
  computeWaveformPeaks,
  estimateBpm,
  transcribeChords,
  transcribeDrumsToMidi,
  transcribeStemToMidi,
} from './stemDsp';
import { separateStereoStemsStft, type SeparatedStemsPcm } from './stftSeparator';

/** The browser STFT engine produces these five stems. */
type BrowserStemId = Exclude<StemId, 'lead'>;

export const ACCEPTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.aif', '.aiff'];
export const ACCEPTED_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi'];

/** Value for <input type="file" accept="..."> covering every supported audio & video format. */
export const FILE_INPUT_ACCEPT = [
  'audio/*',
  'video/*',
  ...ACCEPTED_AUDIO_EXTENSIONS,
  ...ACCEPTED_VIDEO_EXTENSIONS,
].join(',');

export function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function detectFormatLabel(fileName: string): string {
  const ext = fileName.split('.').pop()?.toUpperCase();
  if (!ext || ext.length > 5) return 'AUDIO';
  return ext;
}

export function isSupportedAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/') || isVideoFile(file)) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function makeStereoBuffer(
  ctx: BaseAudioContext,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): AudioBuffer {
  const buf = ctx.createBuffer(2, left.length, sampleRate);
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  return buf;
}

function mixPairToMono(left: Float32Array, right: Float32Array, maxSamples?: number): Float32Array {
  const len = maxSamples ? Math.min(left.length, maxSamples) : left.length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    mono[i] = (left[i] + right[i]) * 0.5;
  }
  return mono;
}

function bufferToMono(buffer: AudioBuffer, maxSamples?: number): Float32Array {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  return mixPairToMono(ch0, ch1, maxSamples);
}

const pauseUi = () => new Promise<void>((resolve) => setTimeout(resolve, 16));

/**
 * Runs STFT 5-stem separation off the main thread in a dedicated Web Worker
 * (with automatic synchronous fallback if Workers are unavailable).
 */
function runStftSeparation(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  onFraction: (fraction: number) => void
): Promise<SeparatedStemsPcm> {
  if (typeof Worker === 'undefined') {
    return Promise.resolve(separateStereoStemsStft(left, right, sampleRate, onFraction));
  }

  return new Promise<SeparatedStemsPcm>((resolve) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./separationWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(separateStereoStemsStft(left, right, sampleRate, onFraction));
      return;
    }

    const leftCopy = left.slice();
    const rightCopy = right.slice();

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onFraction(msg.fraction);
      } else if (msg.type === 'done') {
        worker?.terminate();
        resolve(msg.stems as SeparatedStemsPcm);
      } else if (msg.type === 'error') {
        worker?.terminate();
        resolve(separateStereoStemsStft(left, right, sampleRate, onFraction));
      }
    };

    worker.onerror = () => {
      worker?.terminate();
      resolve(separateStereoStemsStft(left, right, sampleRate, onFraction));
    };

    worker.postMessage(
      { left: leftCopy, right: rightCopy, sampleRate },
      [leftCopy.buffer, rightCopy.buffer]
    );
  });
}

async function buildTranscribedProject(params: {
  file: File;
  stemBuffers: Record<BrowserStemId, AudioBuffer>;
  mixMono: Float32Array;
  sampleRate: number;
  duration: number;
  engineLabel: string;
  onProgress?: (p: SeparationProgress) => void;
}): Promise<SongProject> {
  const { file, stemBuffers, mixMono, sampleRate, duration, engineLabel, onProgress } = params;

  onProgress?.({ stage: 'Transcribing Keyboards & Drums to MIDI', percent: 83 });
  await pauseUi();

  // Tempo from the first 90 s; notes, drums and chords cover the whole song.
  const bpm = estimateBpm(mixMono.subarray(0, Math.min(mixMono.length, Math.floor(sampleRate * 90))), sampleRate);
  const analysisFrames = stemBuffers.drums.length;

  const keysMono = bufferToMono(stemBuffers.keyboards, analysisFrames);
  const drumsMono = bufferToMono(stemBuffers.drums, analysisFrames);
  const guitarMono = bufferToMono(stemBuffers.guitar, analysisFrames);
  const bassMono = bufferToMono(stemBuffers.bass, analysisFrames);

  const keyboardMidi = transcribeStemToMidi(keysMono, sampleRate, bpm, {
    minFreq: 130,
    maxFreq: 1050,
    channel: 0,
    prefix: 'keys',
  });
  const drumHits = transcribeDrumsToMidi(drumsMono, sampleRate, bpm);

  onProgress?.({ stage: 'Extracting Guitar & Bass Tabs, Chords & Sheet Music', percent: 93 });
  await pauseUi();

  const guitarNotes = transcribeStemToMidi(guitarMono, sampleRate, bpm, {
    minFreq: 82,
    maxFreq: 880,
    channel: 0,
    prefix: 'gtr',
  });
  const bassNotes = transcribeStemToMidi(bassMono, sampleRate, bpm, {
    minFreq: 41,
    maxFreq: 260,
    channel: 0,
    prefix: 'bass',
  });
  const vocalNotes = transcribeStemToMidi(bufferToMono(stemBuffers.vocals, analysisFrames), sampleRate, bpm, {
    minFreq: 80,
    maxFreq: 1000,
    channel: 0,
    prefix: 'vox',
  });

  const chordLen = Math.min(guitarMono.length, keysMono.length, bassMono.length);
  const harmonicForChords = new Float32Array(chordLen);
  for (let i = 0; i < chordLen; i++) {
    harmonicForChords[i] = guitarMono[i] + keysMono[i] + bassMono[i];
  }
  const chords = transcribeChords(harmonicForChords, sampleRate, bpm, 4);

  const detectedRoot = chords[0]?.rootPc ?? 0;
  const detectedMode: 'major' | 'minor' =
    chords[0]?.quality === 'min' || chords[0]?.quality === 'm7' ? 'minor' : 'major';

  const stemIds: BrowserStemId[] = ['vocals', 'guitar', 'bass', 'drums', 'keyboards'];
  const stems: Partial<Record<StemId, StemTrackData>> = {};

  for (const id of stemIds) {
    const buf = stemBuffers[id];
    const ch0 = buf.getChannelData(0);
    stems[id] = {
      id,
      buffer: buf,
      peaks: computeWaveformPeaks(ch0, 180),
      rmsLevel: computeRms(ch0),
    };
  }

  const cleanTitle = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
  onProgress?.({ stage: 'Ready in Studio', percent: 100 });

  return {
    id: `upload-${Date.now()}`,
    title: cleanTitle || 'Untitled Track',
    artist: `${engineLabel} · ${Math.round(sampleRate / 1000)} kHz`,
    sourceType: 'upload',
    fileFormat: detectFormatLabel(file.name),
    duration,
    bpm,
    beatOffsetSec: 0,
    timeSignature: [4, 4],
    keyRootPc: detectedRoot,
    keyMode: detectedMode,
    stems,
    keyboardMidi,
    drumHits,
    guitarNotes,
    leadNotes: [],
    bassNotes,
    vocalNotes,
    chords,
    transcriptionEngine: 'yin',
    drumEngine: 'browser',
  };
}

/**
 * Decodes an uploaded MP3/WAV/FLAC/OGG/M4A file and separates it into 5 playable stems
 * using either the user's Local GPU Demucs RTX server or the built-in Browser STFT engine,
 * then extracts MIDI, Guitar/Bass Tabs, Chords, and Sheet Music.
 */
export async function processUploadedAudioFile(
  file: File,
  audioCtx: AudioContext,
  onProgress?: (p: SeparationProgress) => void
): Promise<SongProject> {
  if (!isSupportedAudioFile(file)) {
    throw new Error(
      `Unsupported file "${file.name}". Please upload audio (MP3, WAV, FLAC, OGG, M4A, AAC) or video (MP4, MOV, MKV, WEBM).`
    );
  }

  // PATH B: Browser-local STFT + 2D Median HPSS + Wiener Masking (No setup required)
  onProgress?.({ stage: 'Decoding audio stream', percent: 8 });
  await pauseUi();

  const arrayBuffer = await file.arrayBuffer();
  let decoded: AudioBuffer;
  try {
    decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error(
      isVideoFile(file)
        ? `Your browser could not read the audio in "${file.name}". Switch to the Local GPU engine in Settings (it uses FFmpeg to read any video).`
        : `Could not decode "${file.name}". Ensure the file is a valid MP3, WAV, FLAC, OGG, or M4A recording.`
    );
  }

  const sr = decoded.sampleRate;
  const maxFrames = Math.min(decoded.length, Math.floor(sr * 360));
  const left = decoded.getChannelData(0).slice(0, maxFrames);
  const right =
    decoded.numberOfChannels > 1
      ? decoded.getChannelData(1).slice(0, maxFrames)
      : left.slice(0);

  // Soft-headroom normalize only if source peaks above 0.96 dBFS
  let srcPeak = 0;
  for (let i = 0; i < maxFrames; i++) {
    const a = Math.abs(left[i]);
    const b = Math.abs(right[i]);
    if (a > srcPeak) srcPeak = a;
    if (b > srcPeak) srcPeak = b;
  }
  if (srcPeak > 0.96) {
    const scale = 0.94 / srcPeak;
    for (let i = 0; i < maxFrames; i++) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }

  onProgress?.({ stage: 'Running STFT spectral & 2D HPSS separation', percent: 16 });
  await pauseUi();

  const separated = await runStftSeparation(left, right, sr, (fraction) => {
    const pct = Math.round(16 + fraction * 62);
    onProgress?.({
      stage:
        fraction < 0.5
          ? 'Isolating Vocals, Bass & Drums via STFT Wiener masks'
          : 'Separating Guitar & Keyboards harmonic fields',
      percent: pct,
    });
  });

  const stemIds: BrowserStemId[] = ['vocals', 'guitar', 'bass', 'drums', 'keyboards'];
  const stemBuffers = {} as Record<BrowserStemId, AudioBuffer>;
  for (const id of stemIds) {
    stemBuffers[id] = makeStereoBuffer(audioCtx, separated[id][0], separated[id][1], sr);
  }

  const mixMono = mixPairToMono(left, right, Math.min(maxFrames, Math.floor(sr * 90)));

  return buildTranscribedProject({
    file,
    stemBuffers,
    mixMono,
    sampleRate: sr,
    duration: maxFrames / sr,
    engineLabel: 'Browser STFT',
    onProgress,
  });
}
