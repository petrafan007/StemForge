import type { DrumHitEvent, MidiNoteEvent, QuantizeGrid } from '../types/music';

/**
 * Encodes an unsigned integer as a MIDI Variable-Length Quantity (VLQ).
 */
export function encodeVlq(value: number): number[] {
  const safe = Math.max(0, Math.round(value));
  const bytes: number[] = [safe & 0x7f];
  let remaining = safe >>> 7;
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return bytes;
}

function uint32Be(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function uint16Be(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function asciiBytes(str: string): number[] {
  return Array.from(str).map((c) => c.charCodeAt(0) & 0x7f);
}

/** Grid size in quarter-note beats (0 = no quantization). */
export function quantizeStepBeats(grid: QuantizeGrid): number {
  switch (grid) {
    case 'off':
      return 0;
    case '1/4':
      return 1;
    case '1/8':
      return 0.5;
    case '1/16':
      return 0.25;
    case '1/32':
      return 0.125;
    case '1/8T':
      return 1 / 3;
    case '1/16T':
      return 1 / 6;
    default:
      return 0.25;
  }
}

export function quantizeMidiNotes(
  notes: MidiNoteEvent[],
  grid: QuantizeGrid,
  minVelocity = 1
): MidiNoteEvent[] {
  const step = quantizeStepBeats(grid);
  const kept = notes.filter((n) => n.velocity >= minVelocity);
  if (step <= 0) return kept;
  return kept.map((n) => ({
    ...n,
    startBeat: Math.max(0, Math.round(n.startBeat / step) * step),
    durationBeats: Math.max(step, Math.round(n.durationBeats / step) * step),
  }));
}

export function quantizeDrumHits(
  hits: DrumHitEvent[],
  grid: QuantizeGrid,
  minVelocity = 1
): DrumHitEvent[] {
  const step = quantizeStepBeats(grid);
  const seen = new Set<string>();
  const result: DrumHitEvent[] = [];

  for (const hit of hits) {
    if (hit.velocity < minVelocity) continue;
    const quantizedBeat = step > 0 ? Math.max(0, Math.round(hit.startBeat / step) * step) : Math.max(0, hit.startBeat);
    const dedupeKey = `${hit.midi}@${quantizedBeat.toFixed(3)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push({
      ...hit,
      startBeat: quantizedBeat,
    });
  }
  return result.sort((a, b) => a.startBeat - b.startBeat);
}

interface RawMidiEvent {
  tick: number;
  order: number; // 0 = meta, 1 = noteOff, 2 = noteOn
  bytes: number[];
}

function buildTrackChunk(trackName: string, events: RawMidiEvent[], includeProgram?: { channel: number; program: number }): number[] {
  const trackBytes: number[] = [];

  // Track Name meta event (0xFF 0x03 len text)
  const nameBytes = asciiBytes(trackName);
  trackBytes.push(0x00, 0xff, 0x03, ...encodeVlq(nameBytes.length), ...nameBytes);

  if (includeProgram) {
    trackBytes.push(0x00, 0xc0 | (includeProgram.channel & 0x0f), includeProgram.program & 0x7f);
  }

  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  let lastTick = 0;

  for (const ev of sorted) {
    const delta = Math.max(0, ev.tick - lastTick);
    trackBytes.push(...encodeVlq(delta), ...ev.bytes);
    lastTick = ev.tick;
  }

  // End of Track meta event
  trackBytes.push(0x00, 0xff, 0x2f, 0x00);

  return [...asciiBytes('MTrk'), ...uint32Be(trackBytes.length), ...trackBytes];
}

export interface MidiTrackInput {
  name: string;
  notes: MidiNoteEvent[];
  program?: number; // GM Program number (0 = Acoustic Grand Piano, 4 = Electric Piano)
}

/**
 * Encodes one or more tracks into a valid Standard MIDI File (SMF Format 1) Uint8Array.
 */
export function encodeMidiFile(options: {
  bpm: number;
  timeSignature?: [number, number];
  ticksPerQuarter?: number;
  tracks: MidiTrackInput[];
  /** 1 = one track per instrument (default), 0 = everything merged into a single track. */
  format?: 0 | 1;
}): Uint8Array {
  const ppq = options.ticksPerQuarter ?? 480;
  const bpm = Math.max(30, Math.min(300, options.bpm || 120));
  const [num, den] = options.timeSignature ?? [4, 4];
  const tempoMicros = Math.round(60_000_000 / bpm);

  // Tempo & Time Signature master track (Track 0)
  const tempoEvents: RawMidiEvent[] = [
    {
      tick: 0,
      order: 0,
      bytes: [
        0xff,
        0x51,
        0x03,
        (tempoMicros >>> 16) & 0xff,
        (tempoMicros >>> 8) & 0xff,
        tempoMicros & 0xff,
      ],
    },
    {
      tick: 0,
      order: 0,
      bytes: [0xff, 0x58, 0x04, num & 0xff, Math.round(Math.log2(den)) & 0xff, 24, 8],
    },
  ];

  const chunks: number[][] = [];
  const merged: RawMidiEvent[] = [...tempoEvents];
  if (options.format !== 0) {
    chunks.push(buildTrackChunk('Tempo Map', tempoEvents));
  }

  for (const track of options.tracks) {
    const rawEvents: RawMidiEvent[] = [];
    let primaryChannel = 0;

    for (const note of track.notes) {
      const ch = Math.max(0, Math.min(15, note.channel));
      primaryChannel = ch;
      const pitch = Math.max(0, Math.min(127, Math.round(note.midi)));
      const vel = Math.max(1, Math.min(127, Math.round(note.velocity)));
      const startTick = Math.max(0, Math.round(note.startBeat * ppq));
      const endTick = Math.max(startTick + 1, Math.round((note.startBeat + note.durationBeats) * ppq));

      rawEvents.push({
        tick: startTick,
        order: 2,
        bytes: [0x90 | ch, pitch, vel],
      });
      rawEvents.push({
        tick: endTick,
        order: 1,
        bytes: [0x80 | ch, pitch, 0],
      });
    }

    const includeProgram =
      track.program !== undefined && primaryChannel !== 9
        ? { channel: primaryChannel, program: track.program }
        : undefined;

    if (options.format === 0) {
      if (includeProgram) {
        merged.push({ tick: 0, order: 0, bytes: [0xc0 | (includeProgram.channel & 0x0f), includeProgram.program & 0x7f] });
      }
      merged.push(...rawEvents);
    } else {
      chunks.push(buildTrackChunk(track.name, rawEvents, includeProgram));
    }
  }

  if (options.format === 0) {
    chunks.push(buildTrackChunk(options.tracks.map((t) => t.name).join(' + ') || 'StemForge', merged));
  }

  // MThd header: Format 1, N tracks, PPQ
  const header = [
    ...asciiBytes('MThd'),
    ...uint32Be(6),
    ...uint16Be(options.format === 0 ? 0 : 1),
    ...uint16Be(chunks.length),
    ...uint16Be(ppq),
  ];

  const totalLength = header.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  output.set(header, offset);
  offset += header.length;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function drumHitsToMidiEvents(hits: DrumHitEvent[]): MidiNoteEvent[] {
  return hits.map((h) => ({
    id: h.id,
    midi: h.midi,
    startBeat: h.startBeat,
    durationBeats: 0.25,
    velocity: h.velocity,
    channel: 9, // General MIDI Percussion Channel 10 (0-indexed 9)
    label: h.voice,
  }));
}

/**
 * Encodes stereo/mono PCM float channels into a standard 16-bit PCM WAV Uint8Array.
 */
export function encodeWavPcm(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = Math.max(1, channels.length);
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Uint8Array(buffer);
}
