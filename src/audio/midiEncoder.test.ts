import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drumHitsToMidiEvents,
  encodeMidiFile,
  encodeVlq,
  encodeWavPcm,
  quantizeDrumHits,
  quantizeMidiNotes,
} from './midiEncoder';

test('encodeVlq encodes MIDI variable-length quantities per SMF specification', () => {
  assert.deepEqual(encodeVlq(0), [0x00]);
  assert.deepEqual(encodeVlq(127), [0x7f]);
  assert.deepEqual(encodeVlq(128), [0x81, 0x00]);
  assert.deepEqual(encodeVlq(480), [0x83, 0x60]);
  assert.deepEqual(encodeVlq(16384), [0x81, 0x80, 0x00]);
});

test('encodeMidiFile produces a valid Format 1 SMF header and tracks', () => {
  const bytes = encodeMidiFile({
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        name: 'Keyboards',
        program: 4,
        notes: [
          { id: 'k1', midi: 60, startBeat: 0, durationBeats: 1, velocity: 96, channel: 0 },
          { id: 'k2', midi: 64, startBeat: 1, durationBeats: 1, velocity: 92, channel: 0 },
        ],
      },
      {
        name: 'Drums',
        notes: drumHitsToMidiEvents([
          { id: 'd1', voice: 'kick', midi: 36, startBeat: 0, velocity: 118 },
          { id: 'd2', voice: 'snare', midi: 38, startBeat: 1, velocity: 112 },
        ]),
      },
    ],
  });

  // Check MThd signature
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  // Header length = 6
  assert.equal(bytes[7], 6);
  // Format 1
  assert.equal(bytes[9], 1);
  // 3 tracks total (Tempo Map + Keyboards + Drums)
  assert.equal(bytes[11], 3);
  // First track starts with MTrk at byte 14
  assert.equal(String.fromCharCode(...bytes.slice(14, 18)), 'MTrk');
  // Must contain a GM Channel 10 Note On status byte (0x99) for drums
  assert.ok(bytes.includes(0x99), 'Expected Channel 10 (0x99) drum note-on event');
  // Must contain Channel 1 Note On status byte (0x90) for keyboards
  assert.ok(bytes.includes(0x90), 'Expected Channel 1 (0x90) keyboard note-on event');
});

test('quantizeMidiNotes and quantizeDrumHits snap beats and filter by velocity', () => {
  const qNotes = quantizeMidiNotes(
    [
      { id: 'n1', midi: 60, startBeat: 0.12, durationBeats: 0.4, velocity: 90, channel: 0 },
      { id: 'n2', midi: 62, startBeat: 0.6, durationBeats: 0.4, velocity: 30, channel: 0 },
    ],
    '1/8',
    50
  );
  assert.equal(qNotes.length, 1);
  assert.equal(qNotes[0].startBeat, 0);
  assert.equal(qNotes[0].durationBeats, 0.5);

  const qDrums = quantizeDrumHits(
    [
      { id: 'd1', voice: 'kick', midi: 36, startBeat: 0.04, velocity: 100 },
      { id: 'd2', voice: 'kick', midi: 36, startBeat: 0.1, velocity: 90 }, // collides on 1/4 grid
    ],
    '1/4',
    40
  );
  assert.equal(qDrums.length, 1);
  assert.equal(qDrums[0].startBeat, 0);
});

test('encodeWavPcm produces valid 16-bit stereo RIFF/WAVE bytes', () => {
  const left = new Float32Array([0, 0.5, -0.5, 1]);
  const right = new Float32Array([0, -0.5, 0.5, -1]);
  const wav = encodeWavPcm([left, right], 44100);

  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(wav.length, 44 + 4 * 2 * 2);
});
