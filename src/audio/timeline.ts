/**
 * Beat-grid helpers. The grid is defined by tempo (BPM) and the time of the first beat
 * (beatOffsetSec), so notes line up with the song's real beats instead of time zero.
 */

export interface BeatGrid {
  bpm: number;
  beatOffsetSec: number;
}

export function timeToBeat(grid: BeatGrid, timeSec: number): number {
  return ((timeSec - (grid.beatOffsetSec || 0)) * grid.bpm) / 60;
}

export function beatToTime(grid: BeatGrid, beat: number): number {
  return (beat * 60) / grid.bpm + (grid.beatOffsetSec || 0);
}

/** Quarter-note beats per measure for a time signature (6/8 = 3 quarter beats). */
export function quarterBeatsPerMeasure(timeSignature: [number, number]): number {
  const [num, den] = timeSignature;
  return Math.max(0.5, (num * 4) / (den || 4));
}

export function totalBeats(grid: BeatGrid, durationSec: number): number {
  return Math.max(1, Math.ceil(timeToBeat(grid, durationSec)));
}

/** Re-times beat-based events after a tempo / offset change (keeps their real time). */
export function retimeBeat(beat: number, from: BeatGrid, to: BeatGrid): number {
  return timeToBeat(to, beatToTime(from, beat));
}

export const TIME_SIGNATURES: Array<[number, number]> = [
  [4, 4],
  [3, 4],
  [2, 4],
  [5, 4],
  [6, 4],
  [7, 4],
  [6, 8],
  [7, 8],
  [9, 8],
  [12, 8],
];
