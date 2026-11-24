import type { DrumHitEvent, MidiNoteEvent, RawTranscription, SongProject, StemId, StemTrackData } from '../types/music';
import { deriveMusic } from './musicAnalysis';
import { fetchStem, getProject, type ProjectDocument, type ProjectState } from './serverApi';
import { computeRms, computeWaveformPeaks } from './stemDsp';
import { type BeatGrid, mapBpm, retimeBeat, scaleBeatMap, shiftBeatMap } from './timeline';

/**
 * Turns a server project document (+ decoded stems) into the studio's SongProject, and
 * re-derives notes when the user changes tempo, beat offset, time signature or clean-up options.
 */

export interface SongOverrides {
  bpm?: number;
  beatOffsetSec?: number;
  timeSignature?: [number, number];
  key?: { rootPc: number; mode: 'major' | 'minor' } | null;
  simplifyPowerChords?: boolean;
}

export function trackData(id: StemId, buffer: AudioBuffer): StemTrackData {
  const ch0 = buffer.getChannelData(0);
  return { id, buffer, peaks: computeWaveformPeaks(ch0, 180), rmsLevel: computeRms(ch0) };
}

export function buildProjectFromDocument(
  doc: ProjectDocument,
  buffers: Partial<Record<StemId, AudioBuffer>>,
  defaults: { simplifyPowerChords: boolean }
): SongProject {
  const state: ProjectState = doc.state ?? {};
  const map = doc.analysis?.beats && doc.analysis.beats.length >= 8 ? doc.analysis.beats : undefined;
  const fixed: BeatGrid = { bpm: state.bpm ?? doc.analysis?.bpm ?? 120, beatOffsetSec: state.beatOffsetSec ?? doc.analysis?.beatOffsetSec ?? 0 };
  const grid: BeatGrid = map ? gridWithChanges({ bpm: mapBpm(map), beatOffsetSec: map[0], beatTimes: map }, state) : fixed;
  const { bpm, beatOffsetSec } = grid;
  const timeSignature = (state.timeSignature ?? doc.analysis?.timeSignature ?? [4, 4]) as [number, number];
  const stems: Partial<Record<StemId, StemTrackData>> = {};
  let duration = doc.source?.durationSec ?? 0;
  for (const id of doc.stems) {
    const buf = buffers[id];
    if (buf) {
      stems[id] = trackData(id, buf);
      duration = Math.max(duration, buf.duration);
    }
  }
  const raw: RawTranscription = {
    notes: doc.transcription?.notes ?? {},
    drums: doc.transcription?.drums ?? [],
    ...(doc.transcription?.guitarParts ? { guitarParts: doc.transcription.guitarParts } : {}),
  };
  const simplify = state.simplifyPowerChords ?? defaults.simplifyPowerChords;
  const derived = deriveMusic(raw, grid, duration, { simplifyPowerChords: simplify, timeSignature });
  const key = state.key ?? derived.key ?? { rootPc: 0, mode: 'major' as const };
  const gain = doc.processing?.separation?.gain;
  const artistLine = [doc.artist, doc.album].filter(Boolean).join(' · ');

  return {
    id: `project-${doc.id}`,
    title: doc.title || doc.id,
    artist: artistLine || doc.source?.fileName || '',
    sourceType: 'project',
    fileFormat: doc.source?.format || 'AUDIO',
    duration,
    bpm,
    beatOffsetSec,
    beatTimes: grid.beatTimes,
    timeSignature,
    keyRootPc: key.rootPc,
    keyMode: key.mode,
    stems,
    keyboardMidi: derived.keyboardMidi,
    drumHits: derived.drumHits,
    guitarNotes: derived.guitarNotes,
    guitarParts: derived.guitarParts,
    leadNotes: derived.leadNotes,
    bassNotes: derived.bassNotes,
    vocalNotes: derived.vocalNotes,
    chords: derived.chords,
    transcriptionEngine: doc.transcription?.engine === 'basic-pitch' ? 'basic-pitch' : undefined,
    stringEngine: doc.transcription?.stringEngine ?? undefined,
    drumEngine: doc.transcription?.drumEngine ?? undefined,
    serverProjectId: doc.id,
    levelCompensation: gain && gain > 0 ? 1 / gain : 1,
    raw,
  };
}

/**
 * The grid after tempo / offset changes. A tempo map stays a map when the tempo is halved or
 * doubled (½× / 2×) or the grid is shifted; typing any other BPM switches to a fixed grid.
 */
export function gridWithChanges(grid: BeatGrid, changes: { bpm?: number; beatOffsetSec?: number }): BeatGrid {
  let times = grid.beatTimes && grid.beatTimes.length >= 2 ? grid.beatTimes : undefined;
  if (times && changes.bpm !== undefined && Math.abs(changes.bpm - grid.bpm) > 1e-6) {
    const r = changes.bpm / grid.bpm;
    const near = (x: number) => Math.abs(r / x - 1) < 0.03;
    if (near(0.5)) times = scaleBeatMap(times, 0.5);
    else if (near(0.25)) times = scaleBeatMap(scaleBeatMap(times, 0.5), 0.5);
    else if (near(2)) times = scaleBeatMap(times, 2);
    else if (near(4)) times = scaleBeatMap(scaleBeatMap(times, 2), 2);
    else times = undefined;
  }
  if (times) {
    if (changes.beatOffsetSec !== undefined) times = shiftBeatMap(times, changes.beatOffsetSec - times[0]);
    return { bpm: mapBpm(times), beatOffsetSec: times[0], beatTimes: times };
  }
  return { bpm: changes.bpm ?? grid.bpm, beatOffsetSec: changes.beatOffsetSec ?? grid.beatOffsetSec };
}

/** Applies tempo / grid / key / clean-up changes to any project (server, demo or browser import). */
export function applySongOverrides(project: SongProject, changes: SongOverrides, defaultSimplify: boolean): SongProject {
  const grid = gridWithChanges(project, changes);
  const timeSignature = changes.timeSignature ?? project.timeSignature;
  let next: SongProject = { ...project, bpm: grid.bpm, beatOffsetSec: grid.beatOffsetSec, beatTimes: grid.beatTimes, timeSignature };

  if (project.raw) {
    const derived = deriveMusic(project.raw, grid, project.duration, {
      simplifyPowerChords: changes.simplifyPowerChords ?? defaultSimplify,
      timeSignature,
    });
    next = {
      ...next,
      keyboardMidi: derived.keyboardMidi,
      guitarNotes: derived.guitarNotes,
      guitarParts: derived.guitarParts,
      leadNotes: derived.leadNotes,
      bassNotes: derived.bassNotes,
      vocalNotes: derived.vocalNotes,
      drumHits: derived.drumHits,
      chords: derived.chords,
    };
    const key = changes.key ?? derived.key;
    if (key) next = { ...next, keyRootPc: key.rootPc, keyMode: key.mode };
    else if (changes.key === null && derived.key) next = { ...next, keyRootPc: derived.key.rootPc, keyMode: derived.key.mode };
  } else {
    const from: BeatGrid = project;
    const rt = (b: number) => Math.max(0, retimeBeat(b, from, grid));
    const rd = (b: number, d: number) => Math.max(0.0625, retimeBeat(b + d, from, grid) - retimeBeat(b, from, grid));
    const notes = (list: MidiNoteEvent[]) =>
      list.map((n) => ({ ...n, startBeat: rt(n.startBeat), durationBeats: rd(n.startBeat, n.durationBeats) }));
    const hits = (list: DrumHitEvent[]) => list.map((h) => ({ ...h, startBeat: rt(h.startBeat) }));
    next = {
      ...next,
      keyboardMidi: notes(project.keyboardMidi),
      guitarNotes: notes(project.guitarNotes),
      guitarParts: project.guitarParts && { left: notes(project.guitarParts.left), right: notes(project.guitarParts.right) },
      leadNotes: notes(project.leadNotes),
      bassNotes: notes(project.bassNotes),
      vocalNotes: notes(project.vocalNotes),
      drumHits: hits(project.drumHits),
      chords: project.chords.map((c) => ({ ...c, startBeat: rt(c.startBeat), durationBeats: rd(c.startBeat, c.durationBeats) })),
    };
    if (changes.key) next = { ...next, keyRootPc: changes.key.rootPc, keyMode: changes.key.mode };
  }
  return next;
}

/** Downloads a project and its stems from the server and decodes the audio. */
export async function loadServerProject(
  baseUrl: string,
  projectId: string,
  ctx: BaseAudioContext,
  defaults: { simplifyPowerChords: boolean },
  onProgress?: (stage: string, percent: number) => void
): Promise<{ doc: ProjectDocument; project: SongProject }> {
  onProgress?.('Loading project', 5);
  const doc = await getProject(baseUrl, projectId);
  if (doc.status === 'processing') throw new Error('This song is still being processed.');
  if (doc.status === 'error') throw new Error(doc.error || 'Processing this song failed.');
  const buffers: Partial<Record<StemId, AudioBuffer>> = {};
  let done = 0;
  await Promise.all(
    doc.stems.map(async (id) => {
      const bytes = await fetchStem(baseUrl, projectId, id);
      buffers[id] = await ctx.decodeAudioData(bytes);
      done += 1;
      onProgress?.(`Loading stems (${done}/${doc.stems.length})`, 10 + (85 * done) / Math.max(1, doc.stems.length));
    })
  );
  onProgress?.('Building notes, tabs and chords', 97);
  return { doc, project: buildProjectFromDocument(doc, buffers, defaults) };
}
