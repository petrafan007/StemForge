/**
 * Beat-grid helpers. A grid is either
 *  - a tempo map: the real time of every beat (beatTimes, from the server's beat tracker), so bars
 *    and the playhead follow the band's actual tempo, pushes and drags included; or
 *  - a fixed grid: tempo (BPM) + the time of the first beat (beatOffsetSec).
 * Beat k of a tempo map is at beatTimes[k]; outside the map the first / last beat length continues.
 */

export interface BeatGrid {
  bpm: number;
  beatOffsetSec: number;
  beatTimes?: number[];
}

function hasMap(grid: BeatGrid): grid is BeatGrid & { beatTimes: number[] } {
  return Array.isArray(grid.beatTimes) && grid.beatTimes.length >= 2;
}

/** Index i with beatTimes[i] <= t < beatTimes[i + 1] (clamped to the map's segments). */
function segmentAt(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 2;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function timeToBeat(grid: BeatGrid, timeSec: number): number {
  if (hasMap(grid)) {
    const bt = grid.beatTimes;
    const i = segmentAt(bt, timeSec);
    return i + (timeSec - bt[i]) / Math.max(1e-6, bt[i + 1] - bt[i]);
  }
  return ((timeSec - (grid.beatOffsetSec || 0)) * grid.bpm) / 60;
}

export function beatToTime(grid: BeatGrid, beat: number): number {
  if (hasMap(grid)) {
    const bt = grid.beatTimes;
    const i = Math.max(0, Math.min(bt.length - 2, Math.floor(beat)));
    return bt[i] + (beat - i) * (bt[i + 1] - bt[i]);
  }
  return (beat * 60) / grid.bpm + (grid.beatOffsetSec || 0);
}

/** Seconds per beat at a beat position (local tempo). */
export function secondsPerBeatAt(grid: BeatGrid, beat: number): number {
  if (hasMap(grid)) {
    const bt = grid.beatTimes;
    const i = Math.max(0, Math.min(bt.length - 2, Math.floor(beat)));
    return bt[i + 1] - bt[i];
  }
  return 60 / grid.bpm;
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

/** Average tempo of a tempo map (BPM). */
export function mapBpm(beatTimes: number[]): number {
  if (beatTimes.length < 2) return 120;
  const ibis = beatTimes.slice(1).map((t, i) => t - beatTimes[i]).sort((a, b) => a - b);
  return 60 / ibis[Math.floor(ibis.length / 2)];
}

/** Tempo map at half speed (every other beat) or double speed (beats split in two). */
export function scaleBeatMap(beatTimes: number[], factor: 0.5 | 2): number[] {
  if (factor === 0.5) return beatTimes.filter((_, i) => i % 2 === 0);
  const out: number[] = [];
  for (let i = 0; i < beatTimes.length; i++) {
    out.push(beatTimes[i]);
    if (i + 1 < beatTimes.length) out.push((beatTimes[i] + beatTimes[i + 1]) / 2);
  }
  return out;
}

export function shiftBeatMap(beatTimes: number[], deltaSec: number): number[] {
  return deltaSec === 0 ? beatTimes : beatTimes.map((t) => t + deltaSec);
}

/** Tempo segments of a grid for MIDI export: [{ beat, bpm }], merged where the tempo barely changes. */
export function tempoChanges(grid: BeatGrid, maxBeats: number, toleranceBpm = 0.4): Array<{ beat: number; bpm: number }> {
  if (!hasMap(grid)) return [{ beat: 0, bpm: grid.bpm }];
  const out: Array<{ beat: number; bpm: number }> = [];
  const n = Math.min(grid.beatTimes.length - 1, Math.ceil(maxBeats) + 1);
  for (let i = 0; i < n; i++) {
    const bpm = 60 / Math.max(1e-6, grid.beatTimes[i + 1] - grid.beatTimes[i]);
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.bpm - bpm) > toleranceBpm) out.push({ beat: i, bpm });
  }
  return out.length ? out : [{ beat: 0, bpm: grid.bpm }];
}

/** MIDI tempo changes for a project/grid (one per beat where the tempo map moves, else one). */
export function tempoChangesFor(grid: BeatGrid & { duration?: number }): Array<{ beat: number; bpm: number }> {
  const beats = grid.duration ? timeToBeat(grid, grid.duration) + 1 : 100000;
  return tempoChanges(grid, beats);
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
