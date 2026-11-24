import type { SongProject, StemId } from '../types/music';

/**
 * Browser-side audio export, used for songs that are not in the server project library
 * (built-in demos and browser-STFT imports). WAV only: other formats need the GPU engine (FFmpeg).
 */

export interface ClientMixTrack {
  id: StemId;
  gain: number;
  pan: number;
}

/** Web Audio StereoPannerNode algorithm for stereo input. */
function panGains(pan: number): [number, number, boolean] {
  const p = Math.max(-1, Math.min(1, pan));
  const x = p <= 0 ? p + 1 : p;
  return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2), p <= 0];
}

export function mixStems(
  project: SongProject,
  tracks: ClientMixTrack[],
  startSec = 0,
  endSec?: number
): { left: Float32Array; right: Float32Array; sampleRate: number } {
  const firstBuffer = tracks.map((t) => project.stems[t.id]?.buffer).find(Boolean);
  if (!firstBuffer) throw new Error('Select at least one track to export.');
  const sr = firstBuffer.sampleRate;
  const a = Math.max(0, Math.floor(startSec * sr));
  const b = Math.min(firstBuffer.length, endSec ? Math.floor(endSec * sr) : firstBuffer.length);
  const n = Math.max(0, b - a);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const comp = project.levelCompensation ?? 1;
  for (const t of tracks) {
    const buf = project.stems[t.id]?.buffer;
    if (!buf) continue;
    const l = buf.getChannelData(0);
    const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    const g = t.gain * comp;
    const [gl, gr, leftSide] = panGains(t.pan);
    for (let i = 0; i < n && a + i < buf.length; i++) {
      const L = l[a + i] * g;
      const R = r[a + i] * g;
      if (leftSide) {
        left[i] += L + R * gl;
        right[i] += R * gr;
      } else {
        left[i] += L * gl;
        right[i] += R + L * gr;
      }
    }
  }
  return { left, right, sampleRate: sr };
}

/** Encodes PCM to a WAV file: 16-bit, 24-bit integer or 32-bit float. */
export function encodeWav(channels: Float32Array[], sampleRate: number, bitDepth: 16 | 24 | 32 = 16): Uint8Array {
  const numChannels = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const bytes = bitDepth / 8;
  const isFloat = bitDepth === 32;
  const blockAlign = numChannels * bytes;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const v = channels[ch][i] ?? 0;
      if (isFloat) {
        view.setFloat32(o, v, true);
      } else {
        const c = Math.max(-1, Math.min(1, v));
        if (bitDepth === 16) {
          view.setInt16(o, c < 0 ? c * 0x8000 : c * 0x7fff, true);
        } else {
          const s = Math.round(c < 0 ? c * 0x800000 : c * 0x7fffff);
          view.setUint8(o, s & 0xff);
          view.setUint8(o + 1, (s >> 8) & 0xff);
          view.setUint8(o + 2, (s >> 16) & 0xff);
        }
      }
      o += bytes;
    }
  }
  return new Uint8Array(buffer);
}

export function preventClipping(left: Float32Array, right: Float32Array, targetPeak = 0.999): void {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peak > targetPeak) {
    const g = targetPeak / peak;
    for (let i = 0; i < left.length; i++) {
      left[i] *= g;
      right[i] *= g;
    }
  }
}
