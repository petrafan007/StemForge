import type { DrumHitEvent, MidiNoteEvent, SongProject, StemId, StemTrackData } from '../types/music';
import { deriveMusic } from './musicAnalysis';
import { fetchStem, getProject, type ProjectDocument, type ProjectState } from './serverApi';
import { computeRms, computeWaveformPeaks } from './stemDsp';
import { type BeatGrid, retimeBeat } from './timeline';

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
  const bpm = state.bpm ?? doc.analysis?.bpm ?? 120;
  const beatOffsetSec = state.beatOffsetSec ?? doc.analysis?.beatOffsetSec ?? 0;
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
  const raw = {
    notes: doc.transcription?.notes ?? {},
    drums: doc.transcription?.drums ?? [],
  };
  const simplify = state.simplifyPowerChords ?? defaults.simplifyPowerChords;
  const derived = deriveMusic(raw, { bpm, beatOffsetSec }, duration, { simplifyPowerChords: simplify, timeSignature });
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
    timeSignature,
    keyRootPc: key.rootPc,
    keyMode: key.mode,
    stems,
    keyboardMidi: derived.keyboardMidi,
    drumHits: derived.drumHits,
    guitarNotes: derived.guitarNotes,
    leadNotes: derived.leadNotes,
    bassNotes: derived.bassNotes,
    vocalNotes: derived.vocalNotes,
    chords: derived.chords,
    transcriptionEngine: doc.transcription?.engine === 'basic-pitch' ? 'basic-pitch' : undefined,
    drumEngine: doc.transcription?.drumEngine ?? undefined,
    serverProjectId: doc.id,
    levelCompensation: gain && gain > 0 ? 1 / gain : 1,
    raw,
  };
}

/** Applies tempo / grid / key / clean-up changes to any project (server, demo or browser import). */
export function applySongOverrides(project: SongProject, changes: SongOverrides, defaultSimplify: boolean): SongProject {
  const grid: BeatGrid = {
    bpm: changes.bpm ?? project.bpm,
    beatOffsetSec: changes.beatOffsetSec ?? project.beatOffsetSec,
  };
  const timeSignature = changes.timeSignature ?? project.timeSignature;
  let next: SongProject = { ...project, bpm: grid.bpm, beatOffsetSec: grid.beatOffsetSec, timeSignature };

  if (project.raw) {
    const derived = deriveMusic(project.raw, grid, project.duration, {
      simplifyPowerChords: changes.simplifyPowerChords ?? defaultSimplify,
      timeSignature,
    });
    next = {
      ...next,
      keyboardMidi: derived.keyboardMidi,
      guitarNotes: derived.guitarNotes,
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
    const from: BeatGrid = { bpm: project.bpm, beatOffsetSec: project.beatOffsetSec };
    const rt = (b: number) => Math.max(0, retimeBeat(b, from, grid));
    const scale = grid.bpm / project.bpm;
    const notes = (list: MidiNoteEvent[]) =>
      list.map((n) => ({ ...n, startBeat: rt(n.startBeat), durationBeats: n.durationBeats * scale }));
    const hits = (list: DrumHitEvent[]) => list.map((h) => ({ ...h, startBeat: rt(h.startBeat) }));
    next = {
      ...next,
      keyboardMidi: notes(project.keyboardMidi),
      guitarNotes: notes(project.guitarNotes),
      leadNotes: notes(project.leadNotes),
      bassNotes: notes(project.bassNotes),
      vocalNotes: notes(project.vocalNotes),
      drumHits: hits(project.drumHits),
      chords: project.chords.map((c) => ({ ...c, startBeat: rt(c.startBeat), durationBeats: c.durationBeats * scale })),
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
