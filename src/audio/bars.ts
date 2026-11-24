import { quarterBeatsPerMeasure, timeToBeat, type BeatGrid } from './timeline';

/**
 * Bar lines that follow the music instead of one fixed grid: the beat tracker's downbeats move a
 * section's bar lines where they consistently disagree with the grid (odd-meter bars, sections
 * that start on another beat), and the user can add or remove any bar line. Everything that draws
 * or exports bars (tabs, sheet music, MusicXML, MIDI, metronome, transport) uses barStartsFor().
 *
 * Bars are measured in quarter-note beats. Bar line edits are stored in seconds, so tempo changes
 * (½×, 2×, grid nudges) don't move them.
 */

export interface BarSettings {
  /** Follow the beat tracker's downbeats where they agree for several bars in a row. */
  auto: boolean;
  /** Times (s) where the user started a bar. */
  add: number[];
  /** Times (s) of bar lines the user removed. */
  remove: number[];
}

export const DEFAULT_BAR_SETTINGS: BarSettings = { auto: true, add: [], remove: [] };

export interface BarSource extends BeatGrid {
  timeSignature: [number, number];
  duration: number;
  downbeatTimes?: number[];
  barSettings?: BarSettings;
}

const EPS = 1e-6;
const key = (beat: number) => Math.round(beat * 2) / 2;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Bar starts where the tracker's downbeats move the bar phase: a run of at least `minRun`
 * downbeats in a row on the same beat of the bar, other than the current one, starts its bars on
 * its first downbeat. Shorter runs (tracker noise) change nothing.
 */
export function autoBarAnchors(downbeatBeats: number[], perBar: number, minRun = 3): number[] {
  if (perBar < 2 || Math.abs(perBar - Math.round(perBar)) > EPS) return [];
  const n = Math.round(perBar);
  const beats = [...new Set(downbeatBeats.map((b) => Math.round(b)))].filter((b) => b >= 0).sort((a, b) => a - b);
  const runs: Array<{ phase: number; first: number; last: number; count: number }> = [];
  for (const b of beats) {
    const phase = mod(b, n);
    const last = runs[runs.length - 1];
    if (last && last.phase === phase && b - last.last <= 4 * n) {
      last.last = b;
      last.count += 1;
    } else {
      runs.push({ phase, first: b, last: b, count: 1 });
    }
  }
  const anchors: number[] = [];
  let phase = 0;
  for (const r of runs) {
    if (r.count < minRun || r.phase === phase) continue;
    anchors.push(r.first);
    phase = r.phase;
  }
  return anchors;
}

/**
 * Bar start beats up to `total`: bars of `perBar` beats from beat 0; an anchor starts a new bar
 * (the bar before it ends there), a removed bar line joins its two bars. A bar shorter than half a
 * bar is joined to the bar before it (a phase shift of one beat reads as one 5/4 bar, not a 1/4 bar).
 */
export function computeBarStarts(total: number, perBar: number, anchors: number[], removed: number[] = []): number[] {
  const n = Math.max(0.5, perBar);
  const rem = new Set(removed.map(key));
  const A = [...new Set(anchors.map(key))].filter((a) => a > EPS && !rem.has(a)).sort((a, b) => a - b);
  const starts = [0];
  let b = 0;
  let ai = 0;
  for (let guard = 0; guard < 100000; guard++) {
    while (ai < A.length && A[ai] <= b + EPS) ai++;
    let next = b + n;
    while (rem.has(key(next)) && !(ai < A.length && A[ai] <= next + EPS)) next += n;
    if (ai < A.length && A[ai] < next - EPS) next = A[ai];
    if (next >= total - EPS) break;
    starts.push(next);
    b = next;
  }
  // join bars shorter than half a bar to the bar before them
  for (let i = starts.length - 2; i >= 1; i--) {
    if (starts[i + 1] - starts[i] < n / 2 - EPS) starts.splice(i, 1);
  }
  return starts;
}

const cache = new WeakMap<object, number[]>();

/** The song's bar starts (quarter beats), covering its whole length plus a bar. Cached per project object. */
export function barStartsFor(p: BarSource): number[] {
  const hit = cache.get(p);
  if (hit) return hit;
  const perBar = quarterBeatsPerMeasure(p.timeSignature);
  const total = Math.ceil(timeToBeat(p, p.duration)) + perBar;
  const s = p.barSettings ?? DEFAULT_BAR_SETTINGS;
  const toBeat = (t: number) => timeToBeat(p, t);
  const auto = s.auto && p.downbeatTimes?.length ? autoBarAnchors(p.downbeatTimes.map(toBeat), perBar) : [];
  const starts = computeBarStarts(total, perBar, [...auto, ...s.add.map((t) => Math.round(toBeat(t)))], s.remove.map((t) => key(toBeat(t))));
  cache.set(p, starts);
  return starts;
}

/** Index of the bar that contains `beat` (beats before 0 are in bar 0). */
export function barIndexAt(starts: number[], beat: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= beat + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Start and length (beats) of bar i; bars after the last listed one continue at `perBar`. */
export function barAt(starts: number[], i: number, perBar: number): { start: number; length: number } {
  if (i < starts.length - 1) return { start: starts[i], length: starts[i + 1] - starts[i] };
  const last = starts[starts.length - 1] ?? 0;
  return { start: last + (i - (starts.length - 1)) * perBar, length: perBar };
}

/** Number of bars that start before `endBeat` (the bars needed to reach it). */
export function barCountTo(starts: number[], endBeat: number, perBar: number): number {
  const last = starts[starts.length - 1] ?? 0;
  const listed = starts.filter((s) => s < endBeat - EPS).length;
  return Math.max(1, listed + Math.max(0, Math.ceil((endBeat - last - perBar) / perBar - EPS)));
}

/** Time signature of a bar of `lengthBeats` quarter beats, in the song's denominator when possible. */
export function barTimeSignature(lengthBeats: number, songDen: number): [number, number] {
  for (const den of [songDen, 4, 8, 16]) {
    const num = (lengthBeats * den) / 4;
    if (Math.abs(num - Math.round(num)) < EPS && num >= 1) return [Math.round(num), den];
  }
  return [Math.max(1, Math.round(lengthBeats * 4)), 16];
}

/** Index, start and length of the bar containing `beat` (also beyond the listed bars). */
export function barPosition(starts: number[], beat: number, perBar: number): { index: number; start: number; length: number } {
  const last = starts.length - 1;
  const i = barIndexAt(starts, beat);
  if (i === last && beat >= starts[last] + perBar - EPS) {
    const extra = Math.floor((beat - starts[last]) / perBar + EPS);
    return { index: last + extra, start: starts[last] + extra * perBar, length: perBar };
  }
  return { index: i, ...barAt(starts, i, perBar) };
}

/** MIDI / MusicXML time signature changes: one at beat 0 and one wherever the bar length changes. */
export function timeSignatureChanges(starts: number[], perBar: number, songDen: number): Array<{ beat: number; num: number; den: number }> {
  const out: Array<{ beat: number; num: number; den: number }> = [];
  let prev = -1;
  for (let i = 0; i < starts.length; i++) {
    const { start, length } = barAt(starts, i, perBar);
    if (Math.abs(length - prev) < EPS) continue;
    const [num, den] = barTimeSignature(length, songDen);
    out.push({ beat: start, num, den });
    prev = length;
  }
  return out;
}

export function timeSignatureChangesFor(p: BarSource): Array<{ beat: number; num: number; den: number }> {
  return timeSignatureChanges(barStartsFor(p), quarterBeatsPerMeasure(p.timeSignature), p.timeSignature[1] || 4);
}

/** Is `beat` the first beat of a bar? */
export function isBarStart(starts: number[], beat: number, perBar: number): boolean {
  const i = barIndexAt(starts, beat);
  const { start, length } = barAt(starts, i, perBar);
  if (Math.abs(beat - start) < 1e-3) return true;
  // beyond the listed bars: regular bars
  return i === starts.length - 1 && beat > start && Math.abs(mod(beat - start, length)) < 1e-3;
}

/** Toggles a bar line at `beat` (a whole beat): removes it if a bar starts there, adds one otherwise. */
export function toggleBarLine(settings: BarSettings, starts: number[], beat: number, time: number, timeOf: (beat: number) => number): BarSettings {
  const near = (list: number[]) => list.findIndex((t) => Math.abs(t - time) < 0.02);
  const isLine = starts.some((s) => Math.abs(s - beat) < 1e-3);
  if (isLine) {
    const i = near(settings.add);
    if (i >= 0) return { ...settings, add: settings.add.filter((_, k) => k !== i) };
    return { ...settings, remove: [...settings.remove, round(timeOf(beat))] };
  }
  const i = near(settings.remove);
  if (i >= 0) return { ...settings, remove: settings.remove.filter((_, k) => k !== i) };
  return { ...settings, add: [...settings.add, round(timeOf(beat))] };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

/** Validates stored bar settings. */
export function parseBarSettings(raw: unknown): BarSettings {
  const r = (raw ?? {}) as Partial<BarSettings>;
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : []);
  return { auto: typeof r.auto === 'boolean' ? r.auto : true, add: nums(r.add), remove: nums(r.remove) };
}
