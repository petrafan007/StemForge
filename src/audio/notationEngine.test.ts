import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASS_TUNINGS,
  GUITAR_TUNINGS,
  detectChordFromChroma,
  formatChordSymbol,
  generateAsciiTab,
  getChordVoicing,
  getStaffPosition,
  mapNotesToTab,
  midiToNoteName,
} from './notationEngine';

test('midiToNoteName and formatChordSymbol handle notes and transposition', () => {
  assert.equal(midiToNoteName(60), 'C4');
  assert.equal(midiToNoteName(69), 'A4');
  assert.equal(midiToNoteName(40), 'E2');
  assert.equal(formatChordSymbol(9, 'm7', 0), 'Am7');
  assert.equal(formatChordSymbol(9, 'm7', 2), 'Bm7');
  assert.equal(formatChordSymbol(0, 'maj7', -1), 'Bmaj7');
});

test('mapNotesToTab places guitar and bass notes on playable strings and frets', () => {
  const guitarNotes = [
    { id: '1', midi: 40, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 }, // Open low E
    { id: '2', midi: 45, startBeat: 1, durationBeats: 1, velocity: 100, channel: 0 }, // A2
    { id: '3', midi: 64, startBeat: 2, durationBeats: 1, velocity: 100, channel: 0 }, // High e
  ];

  const mappedGuitar = mapNotesToTab(guitarNotes, GUITAR_TUNINGS.standard, 0);
  assert.equal(mappedGuitar.length, 3);
  assert.equal(mappedGuitar[0].stringIndex, 5); // Low E string
  assert.equal(mappedGuitar[0].fret, 0);

  // Drop D allows low D2 (MIDI 38) open on string 5
  const dropD = mapNotesToTab(
    [{ id: 'd', midi: 38, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 }],
    GUITAR_TUNINGS.dropD,
    0
  );
  assert.equal(dropD[0].stringIndex, 5);
  assert.equal(dropD[0].fret, 0);

  // Bass 4-string maps E1 (MIDI 28) to open E string (index 3)
  const mappedBass = mapNotesToTab(
    [{ id: 'b', midi: 28, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 }],
    BASS_TUNINGS.standard4,
    0
  );
  assert.equal(mappedBass[0].stringIndex, 3);
  assert.equal(mappedBass[0].fret, 0);
});

test('detectChordFromChroma identifies A minor and C major triads', () => {
  const cMajChroma = [1, 0, 0, 0, 0.9, 0, 0, 0.85, 0, 0, 0, 0];
  const resC = detectChordFromChroma(cMajChroma);
  assert.equal(resC.rootPc, 0);
  assert.equal(resC.quality, 'maj');

  const aMinChroma = [0.85, 0, 0, 0, 0.8, 0, 0, 0, 0, 1, 0, 0];
  const resA = detectChordFromChroma(aMinChroma);
  assert.equal(resA.rootPc, 9);
  assert.equal(resA.quality, 'min');
});

test('getChordVoicing returns 6-string guitar shapes and 4-string bass boxes', () => {
  const amGuitar = getChordVoicing(9, 'min', 'guitar', 0);
  assert.equal(amGuitar.symbol, 'Am');
  assert.equal(amGuitar.frets.length, 6);
  assert.deepEqual(amGuitar.frets, [-1, 0, 2, 2, 1, 0]);

  const amBass = getChordVoicing(9, 'min', 'bass', 0);
  assert.equal(amBass.symbol, 'Am');
  assert.equal(amBass.frets.length, 4);
});

test('generateAsciiTab renders readable 6-string header and barlines', () => {
  const tab = mapNotesToTab(
    [{ id: '1', midi: 57, startBeat: 0, durationBeats: 1, velocity: 100, channel: 0 }],
    GUITAR_TUNINGS.standard
  );
  const ascii = generateAsciiTab(tab, GUITAR_TUNINGS.standard, 'Test Song', 120);
  assert.ok(ascii.includes('Test Song'));
  assert.ok(ascii.includes('e |'));
  assert.ok(ascii.includes('E |'));
});

test('getStaffPosition computes accurate Treble and Bass clef line offsets', () => {
  // E4 (MIDI 64) is the bottom line (offset 0) of Treble clef
  const e4 = getStaffPosition(64, 'treble');
  assert.equal(e4.lineOffsetFromBottom, 0);
  assert.equal(e4.accidental, null);

  // F#4 (MIDI 66) has sharp accidental on F space (offset 0.5)
  const fs4 = getStaffPosition(66, 'treble');
  assert.equal(fs4.lineOffsetFromBottom, 0.5);
  assert.equal(fs4.accidental, '#');

  // G2 (MIDI 43) is the bottom line (offset 0) of Bass clef
  const g2 = getStaffPosition(43, 'bass');
  assert.equal(g2.lineOffsetFromBottom, 0);
});

test('mapNotesToTab fingers power chords as shapes and repeats a riff the same way', () => {
  const ev = (id: string, midi: number, startBeat: number) => ({ id, midi, startBeat, durationBeats: 0.25, velocity: 100, channel: 0 });
  const riff: ReturnType<typeof ev>[] = [];
  let k = 0;
  for (let bar = 0; bar < 4; bar++) {
    const b = bar * 4;
    // E5 chug, G5, A5 power chords, then a fast single-note run that could sit in two positions
    for (const [t, ms] of [[0, [40, 47]], [0.5, [43, 50]], [1, [45, 52]], [2, [57]], [2.25, [55]], [2.5, [53]], [2.75, [52]]] as Array<[number, number[]]>) {
      for (const m of ms) riff.push(ev(`n${k++}`, m, b + t));
    }
  }
  const tab = mapNotesToTab(riff, GUITAR_TUNINGS.standard, 0, 22);
  const at = (beat: number) => tab.filter((t) => Math.abs(t.startBeat - beat) < 1e-6).map((t) => `${t.stringIndex}:${t.fret}`).sort().join(' ');
  // E5 = open low E + 2nd fret A string; G5 = 3rd fret E + 5th fret A
  assert.equal(at(0), '4:2 5:0');
  assert.equal(at(0.5), '4:5 5:3');
  // every repeat of the riff is fingered identically
  for (const t of [0, 0.5, 1, 2, 2.25, 2.5, 2.75]) {
    assert.equal(at(4 + t), at(t));
    assert.equal(at(12 + t), at(t));
  }
  // the fast run stays in one position (no frets far apart)
  const run = [2, 2.25, 2.5, 2.75].map((t) => tab.find((x) => Math.abs(x.startBeat - t) < 1e-6)!.fret);
  assert.ok(Math.max(...run) - Math.min(...run) <= 4, run.join(','));
});
