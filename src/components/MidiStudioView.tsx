import { timeSignatureChangesFor } from '../audio/bars';
import { useMemo, useState } from 'react';
import { Download, Volume2 } from 'lucide-react';
import type { DrumHitEvent, DrumVoice, MidiNoteEvent, QuantizeGrid, SongProject } from '../types/music';
import {
  drumHitsToMidiEvents,
  encodeMidiFile,
  quantizeDrumHits,
  quantizeMidiNotes,
  type MidiTrackInput,
} from '../audio/midiEncoder';
import { midiToNoteName } from '../audio/notationEngine';
import { beatToTime, tempoChangesFor, timeToBeat } from '../audio/timeline';
import { stemLabel } from '../types/music';
import { slugifyFilename, triggerBinaryDownload } from '../utils/download';

type MelodicTrackId = 'keyboards' | 'guitar' | 'lead' | 'bass' | 'vocals';
type MidiTrackTab = MelodicTrackId | 'drums' | 'all';
type PreviewMode = 'off' | 'keyboards' | 'drums' | 'combined';

interface MidiStudioViewProps {
  project: SongProject;
  currentTime: number;
  transpose: number;
  quantize: QuantizeGrid;
  minVelocity: number;
  midiPreviewMode: PreviewMode;
  onChangeQuantize: (grid: QuantizeGrid) => void;
  onChangeMinVelocity: (vel: number) => void;
  onChangeMidiPreviewMode: (mode: PreviewMode) => void;
  onSeek: (timeSec: number) => void;
  onPreviewNote: (midi: number, durationSec?: number, isDrum?: boolean) => void;
  onOpenExport?: () => void;
}

/** Per-track display + General MIDI export settings. Channels are distinct so a multi-track file plays correctly. */
const MELODIC_TRACKS: Record<
  MelodicTrackId,
  { label: string; program: number; channel: number; color: string; range: [number, number] }
> = {
  keyboards: { label: 'Keyboards', program: 0, channel: 0, color: '#34D399', range: [21, 108] },
  guitar: { label: 'Guitar', program: 30, channel: 1, color: '#F59E0B', range: [28, 100] },
  lead: { label: 'Lead Guitar', program: 29, channel: 4, color: '#FB923C', range: [28, 100] },
  bass: { label: 'Bass', program: 33, channel: 2, color: '#38BDF8', range: [16, 72] },
  vocals: { label: 'Vocals', program: 52, channel: 3, color: '#F43F5E', range: [36, 96] },
};

const DRUM_LANES: Array<{ voice: DrumVoice; label: string; midi: number; color: string }> = [
  { voice: 'crash', label: 'Crash (49)', midi: 49, color: '#F59E0B' },
  { voice: 'openhat', label: 'Open Hat (46)', midi: 46, color: '#38BDF8' },
  { voice: 'hihat', label: 'Closed Hat (42)', midi: 42, color: '#34D399' },
  { voice: 'tom', label: 'Mid Tom (45)', midi: 45, color: '#FB7185' },
  { voice: 'snare', label: 'Snare (38)', midi: 38, color: '#A78BFA' },
  { voice: 'kick', label: 'Kick (36)', midi: 36, color: '#F43F5E' },
];

const PX_PER_BEAT = 38;

function isBlackKey(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function rawNotesFor(project: SongProject, id: MelodicTrackId): MidiNoteEvent[] {
  switch (id) {
    case 'keyboards':
      return project.keyboardMidi;
    case 'guitar':
      return project.guitarNotes;
    case 'lead':
      return project.leadNotes;
    case 'bass':
      return project.bassNotes;
    case 'vocals':
      return project.vocalNotes ?? [];
  }
}

function BeatRuler({ totalBeats }: { totalBeats: number }) {
  return (
    <div className="h-6 border-b border-white/[0.08] relative bg-[#0E1015]">
      {Array.from({ length: totalBeats }).map((_, beat) => (
        <div
          key={beat}
          style={{ left: `${beat * PX_PER_BEAT}px`, width: `${PX_PER_BEAT}px` }}
          className={`absolute inset-y-0 border-l text-[10px] font-mono tabular-nums pl-1 flex items-center ${
            beat % 4 === 0 ? 'border-white/20 text-slate-300' : 'border-white/[0.05] text-slate-600'
          }`}
        >
          {beat % 4 === 0 ? `M${beat / 4 + 1}` : ''}
        </div>
      ))}
    </div>
  );
}

function BeatGridLines({ totalBeats }: { totalBeats: number }) {
  return (
    <>
      {Array.from({ length: totalBeats }).map((_, beat) => (
        <div
          key={beat}
          style={{ left: `${beat * PX_PER_BEAT}px` }}
          className={`absolute top-0 bottom-0 border-l pointer-events-none ${
            beat % 4 === 0 ? 'border-white/[0.12]' : 'border-white/[0.04]'
          }`}
        />
      ))}
    </>
  );
}

function PianoRoll({
  trackId,
  label,
  notes,
  totalBeats,
  currentBeat,
  minVelocity,
  onSeekBeat,
  onPreviewNote,
  onExport,
}: {
  trackId: MelodicTrackId;
  label: string;
  notes: MidiNoteEvent[];
  totalBeats: number;
  currentBeat: number;
  minVelocity: number;
  onSeekBeat: (beat: number) => void;
  onPreviewNote: (midi: number) => void;
  onExport: () => void;
}) {
  const meta = { ...MELODIC_TRACKS[trackId], label };
  const gridWidth = Math.max(760, totalBeats * PX_PER_BEAT);

  const { minPitch, maxPitch } = useMemo(() => {
    if (notes.length === 0) return { minPitch: 48, maxPitch: 72 };
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    return { minPitch: Math.max(0, lo - 2), maxPitch: Math.min(127, Math.max(lo + 14, hi + 2)) };
  }, [notes]);

  const pitchRows = useMemo(() => {
    const rows: number[] = [];
    for (let m = maxPitch; m >= minPitch; m--) rows.push(m);
    return rows;
  }, [minPitch, maxPitch]);

  return (
    <section
      aria-label={`${meta.label} MIDI piano roll`}
      className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden"
    >
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span aria-hidden="true" className="w-2 h-2 rounded-xs" style={{ backgroundColor: meta.color }} />
          <span className="font-semibold text-white">
            {meta.label} Track · Channel {meta.channel + 1}
          </span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="font-mono tabular-nums text-slate-400">
            {notes.length} MIDI notes
            {notes.length > 0 && ` · Range ${midiToNoteName(minPitch)}–${midiToNoteName(maxPitch)}`}
          </span>
        </div>
        <button
          type="button"
          onClick={onExport}
          className="text-xs text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 cursor-pointer"
        >
          Export {meta.label} .mid
        </button>
      </div>

      {notes.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-400">
          No {meta.label.toLowerCase()} notes exceed velocity {minVelocity}. Lower the Min Velocity slider to
          reveal softer notes.
        </div>
      ) : (
        <div className="flex overflow-x-auto studio-scroll max-h-[560px] overflow-y-auto">
          <div className="sticky left-0 z-10 w-16 shrink-0 bg-[#11141A] border-r border-white/[0.08]">
            <div className="h-6 border-b border-white/[0.08] text-[10px] font-mono text-slate-500 flex items-center justify-center">
              Pitch
            </div>
            {pitchRows.map((midi) => {
              const black = isBlackKey(midi);
              return (
                <button
                  key={midi}
                  type="button"
                  onClick={() => onPreviewNote(midi)}
                  aria-label={`Audition ${midiToNoteName(midi)}`}
                  className={`w-full h-5 px-2 flex items-center justify-end text-[10px] font-mono border-b border-white/[0.04] transition-colors cursor-pointer ${
                    black
                      ? 'bg-[#0B0D10] text-slate-500 hover:text-emerald-300'
                      : 'bg-[#171B22] text-slate-300 hover:text-emerald-300'
                  }`}
                >
                  {midiToNoteName(midi)}
                </button>
              );
            })}
          </div>

          <div
            className="relative select-none"
            style={{ width: `${gridWidth}px` }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeekBeat(Math.max(0, e.clientX - rect.left) / PX_PER_BEAT);
            }}
          >
            <BeatRuler totalBeats={totalBeats} />
            <div className="relative" style={{ height: `${pitchRows.length * 20}px` }}>
              {pitchRows.map((midi, idx) => (
                <div
                  key={midi}
                  style={{ top: `${idx * 20}px` }}
                  className={`absolute left-0 right-0 h-5 border-b border-white/[0.04] ${
                    isBlackKey(midi) ? 'bg-[#0B0D10]/80' : 'bg-[#11141B]/40'
                  }`}
                />
              ))}
              <BeatGridLines totalBeats={totalBeats} />

              {notes.map((note) => {
                const rowIdx = maxPitch - note.midi;
                if (rowIdx < 0 || rowIdx >= pitchRows.length) return null;
                const left = note.startBeat * PX_PER_BEAT;
                const width = Math.max(10, note.durationBeats * PX_PER_BEAT - 2);
                const isPlayingNow =
                  currentBeat >= note.startBeat && currentBeat <= note.startBeat + note.durationBeats;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPreviewNote(note.midi);
                    }}
                    title={`${midiToNoteName(note.midi)} · Beat ${note.startBeat + 1} · Vel ${note.velocity}`}
                    aria-label={`${meta.label} note ${midiToNoteName(note.midi)} at beat ${note.startBeat + 1}`}
                    style={{
                      left: `${left}px`,
                      top: `${rowIdx * 20 + 2}px`,
                      width: `${width}px`,
                      backgroundColor: isPlayingNow ? '#FBBF24' : meta.color,
                      opacity: isPlayingNow ? 1 : Math.max(0.55, note.velocity / 127),
                    }}
                    className="absolute h-4 rounded-[3px] text-[9px] font-mono px-1 text-left truncate text-[#0B0D10] cursor-pointer hover:brightness-110"
                  >
                    {width > 24 ? midiToNoteName(note.midi) : ''}
                  </button>
                );
              })}

              <div
                aria-hidden="true"
                style={{ left: `${currentBeat * PX_PER_BEAT}px` }}
                className="absolute top-0 bottom-0 w-0.5 bg-amber-500 pointer-events-none z-10"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DrumGrid({
  hits,
  totalBeats,
  currentBeat,
  onSeekBeat,
  onPreviewNote,
  onExport,
}: {
  hits: DrumHitEvent[];
  totalBeats: number;
  currentBeat: number;
  onSeekBeat: (beat: number) => void;
  onPreviewNote: (midi: number) => void;
  onExport: () => void;
}) {
  const gridWidth = Math.max(760, totalBeats * PX_PER_BEAT);
  return (
    <section
      aria-label="Drums General MIDI percussion grid"
      className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden"
    >
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-white">Drums Track · GM Channel 10</span>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="font-mono tabular-nums text-slate-400">
            {hits.length} percussion hits mapped to GM standard notes
          </span>
        </div>
        <button
          type="button"
          onClick={onExport}
          className="text-xs text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 cursor-pointer"
        >
          Export Drums .mid
        </button>
      </div>

      <div className="flex overflow-x-auto studio-scroll">
        <div className="sticky left-0 z-10 w-44 shrink-0 bg-[#11141A] border-r border-white/[0.08]">
          <div className="h-6 border-b border-white/[0.08] text-[10px] font-mono text-slate-500 px-3 flex items-center">
            GM Drum Pad
          </div>
          {DRUM_LANES.map((lane) => (
            <button
              key={lane.voice}
              type="button"
              onClick={() => onPreviewNote(lane.midi)}
              aria-label={`Audition ${lane.label}`}
              className="w-full h-9 px-3 flex items-center gap-2 text-xs font-mono text-slate-300 hover:text-white hover:bg-white/[0.04] border-b border-white/[0.05] cursor-pointer"
            >
              <span aria-hidden="true" className="w-2 h-2 rounded-xs shrink-0" style={{ backgroundColor: lane.color }} />
              <span className="truncate">{lane.label}</span>
            </button>
          ))}
        </div>

        <div
          className="relative select-none"
          style={{ width: `${gridWidth}px` }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onSeekBeat(Math.max(0, e.clientX - rect.left) / PX_PER_BEAT);
          }}
        >
          <BeatRuler totalBeats={totalBeats} />
          <div className="relative" style={{ height: `${DRUM_LANES.length * 36}px` }}>
            {DRUM_LANES.map((lane, rowIdx) => (
              <div
                key={lane.voice}
                style={{ top: `${rowIdx * 36}px` }}
                className="absolute left-0 right-0 h-9 border-b border-white/[0.05] bg-[#0F1218]/60"
              />
            ))}
            <BeatGridLines totalBeats={totalBeats} />

            {hits.map((hit) => {
              const laneIdx = DRUM_LANES.findIndex((l) => l.voice === hit.voice);
              if (laneIdx === -1) return null;
              const lane = DRUM_LANES[laneIdx];
              const isActive = Math.abs(currentBeat - hit.startBeat) < 0.25;
              return (
                <button
                  key={hit.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreviewNote(hit.midi);
                  }}
                  title={`${lane.label} · Beat ${hit.startBeat + 1} · Vel ${hit.velocity}`}
                  aria-label={`${lane.label} hit at beat ${hit.startBeat + 1}`}
                  style={{
                    left: `${hit.startBeat * PX_PER_BEAT + 1}px`,
                    top: `${laneIdx * 36 + 7}px`,
                    backgroundColor: isActive ? '#F59E0B' : lane.color,
                    opacity: isActive ? 1 : Math.max(0.45, hit.velocity / 127),
                  }}
                  className="absolute w-3.5 h-5 rounded-[3px] transition-transform hover:scale-110 cursor-pointer"
                />
              );
            })}

            <div
              aria-hidden="true"
              style={{ left: `${currentBeat * PX_PER_BEAT}px` }}
              className="absolute top-0 bottom-0 w-0.5 bg-amber-500 pointer-events-none z-10"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

export function MidiStudioView({
  project,
  currentTime,
  transpose,
  quantize,
  minVelocity,
  midiPreviewMode,
  onChangeQuantize,
  onChangeMinVelocity,
  onChangeMidiPreviewMode,
  onSeek,
  onPreviewNote,
  onOpenExport,
}: MidiStudioViewProps) {
  const [activeTab, setActiveTab] = useState<MidiTrackTab>('keyboards');
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const hasLead = Boolean(project.stems.lead);
  const melodicIds: MelodicTrackId[] = hasLead
    ? ['keyboards', 'guitar', 'lead', 'bass', 'vocals']
    : ['keyboards', 'guitar', 'bass', 'vocals'];
  const labelOf = (id: MelodicTrackId) => (id === 'guitar' || id === 'lead' ? stemLabel(id, project) : MELODIC_TRACKS[id].label);

  const melodic = useMemo(() => {
    const out = {} as Record<MelodicTrackId, MidiNoteEvent[]>;
    (Object.keys(MELODIC_TRACKS) as MelodicTrackId[]).forEach((id) => {
      const [lo, hi] = MELODIC_TRACKS[id].range;
      out[id] = quantizeMidiNotes(rawNotesFor(project, id), quantize, minVelocity).map((n) => ({
        ...n,
        midi: Math.max(lo, Math.min(hi, n.midi + transpose)),
        channel: MELODIC_TRACKS[id].channel,
      }));
    });
    return out;
  }, [project, quantize, minVelocity, transpose]);

  const quantizedDrums = useMemo(
    () => quantizeDrumHits(project.drumHits, quantize, minVelocity),
    [project.drumHits, quantize, minVelocity]
  );

  const totalBeats = Math.max(8, Math.ceil(timeToBeat(project, project.duration)));
  const currentBeat = timeToBeat(project, currentTime);
  const seekBeat = (beat: number) => onSeek(Math.max(0, beatToTime(project, beat)));

  const buildTracks = (scope: MidiTrackTab): MidiTrackInput[] => {
    const ids: MelodicTrackId[] = scope === 'all' ? melodicIds : scope === 'drums' ? [] : [scope];
    const tracks: MidiTrackInput[] = ids
      .filter((id) => melodic[id].length > 0 || scope !== 'all')
      .map((id) => ({ name: labelOf(id), program: MELODIC_TRACKS[id].program, notes: melodic[id] }));
    if (scope === 'drums' || scope === 'all') {
      tracks.push({ name: 'Drums', notes: drumHitsToMidiEvents(quantizedDrums) });
    }
    return tracks;
  };

  const handleDownloadMidi = (scope: MidiTrackTab) => {
    const bytes = encodeMidiFile({
      bpm: project.bpm,
      tempoChanges: tempoChangesFor(project),
      timeSignature: project.timeSignature,
      timeSignatureChanges: timeSignatureChangesFor(project),
      tracks: buildTracks(scope),
    });
    const suffix = scope === 'all' ? 'all_stems' : scope;
    const filename = `${slugifyFilename(project.title)}_${suffix}.mid`;
    triggerBinaryDownload(bytes, filename, 'audio/midi');
    setExportMessage(`Exported ${filename} (${bytes.length.toLocaleString()} bytes)`);
    window.setTimeout(() => setExportMessage(null), 4000);
  };

  const previewTarget: PreviewMode | null =
    activeTab === 'keyboards' ? 'keyboards' : activeTab === 'drums' ? 'drums' : activeTab === 'all' ? 'combined' : null;

  const tabLabel = (id: MidiTrackTab) =>
    id === 'all' ? 'All Stems' : id === 'drums' ? 'Drums' : labelOf(id);

  const tabs: Array<{ id: MidiTrackTab; label: string }> = [
    ...melodicIds.map((id) => ({
      id,
      label: `${labelOf(id)} (${melodic[id].length})`,
    })),
    { id: 'drums', label: `Drums (${quantizedDrums.length})` },
    { id: 'all', label: 'All Stems' },
  ];

  const visibleMelodic: MelodicTrackId[] =
    activeTab === 'all' ? melodicIds : activeTab === 'drums' ? [] : activeTab === 'lead' && !hasLead ? [] : [activeTab];

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <div
            role="tablist"
            aria-label="MIDI track view"
            className="inline-flex flex-wrap items-center p-1 bg-[#13161C] border border-white/[0.08] rounded-md"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tab.id ? 'bg-amber-500 text-[#0B0D10] font-semibold' : 'text-slate-300 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              <span>Quantize</span>
              <select
                aria-label="MIDI quantize grid"
                value={quantize}
                onChange={(e) => onChangeQuantize(e.target.value as QuantizeGrid)}
                className="h-8 px-2.5 rounded bg-[#13161C] border border-white/[0.08] text-xs font-mono text-slate-200 cursor-pointer"
              >
                {(
                  [
                    ['off', 'Off (as played)'],
                    ['1/4', '1/4 Note'],
                    ['1/8', '1/8 Note'],
                    ['1/16', '1/16 Note'],
                    ['1/32', '1/32 Note'],
                    ['1/8T', '1/8 Triplet'],
                    ['1/16T', '1/16 Triplet'],
                  ] as Array<[QuantizeGrid, string]>
                ).map(([v, l]) => (
                  <option key={v} value={v} className="bg-[#13161C]">
                    {l}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2">
              <span>Min Velocity</span>
              <input
                type="range"
                min={1}
                max={105}
                step={2}
                value={minVelocity}
                onChange={(e) => onChangeMinVelocity(Number(e.target.value))}
                aria-label="Minimum MIDI note velocity filter"
                className="studio-fader w-24"
              />
              <span className="font-mono tabular-nums text-slate-300 w-7">{minVelocity}</span>
            </label>

            <span
              className="font-mono text-[11px] px-2 py-1 rounded border border-white/[0.08] text-slate-400"
              title={
                project.transcriptionEngine === 'basic-pitch'
                  ? 'Notes transcribed by Spotify Basic Pitch on the GPU server (chords supported)'
                  : project.transcriptionEngine === 'yin'
                    ? 'Notes transcribed in the browser (single notes only). Use the Local GPU engine for chords.'
                    : 'Built-in demo song'
              }
            >
              {project.transcriptionEngine === 'basic-pitch'
                ? 'Polyphonic · Basic Pitch'
                : project.transcriptionEngine === 'yin'
                  ? 'Monophonic · Browser'
                  : 'Demo MIDI'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {previewTarget && (
            <button
              type="button"
              onClick={() => onChangeMidiPreviewMode(midiPreviewMode === previewTarget ? 'off' : previewTarget)}
              aria-pressed={midiPreviewMode === previewTarget}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                midiPreviewMode === previewTarget
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                  : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
              }`}
            >
              <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{midiPreviewMode === previewTarget ? 'MIDI Synth Preview On' : 'Preview MIDI Synth'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => handleDownloadMidi(activeTab)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Download {tabLabel(activeTab)} MIDI (.mid)</span>
          </button>
          {onOpenExport && (
            <button
              type="button"
              onClick={onOpenExport}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md whitespace-nowrap shrink-0 cursor-pointer"
            >
              More MIDI export options…
            </button>
          )}
        </div>
      </div>

      {exportMessage && (
        <div
          role="status"
          className="text-xs font-mono text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3.5 py-2"
        >
          {exportMessage}
        </div>
      )}

      {visibleMelodic.map((id) => (
        <PianoRoll
          key={id}
          trackId={id}
          label={labelOf(id)}
          notes={melodic[id]}
          totalBeats={totalBeats}
          currentBeat={currentBeat}
          minVelocity={minVelocity}
          onSeekBeat={seekBeat}
          onPreviewNote={(midi) => onPreviewNote(midi, 0.35, false)}
          onExport={() => handleDownloadMidi(id)}
        />
      ))}

      {(activeTab === 'drums' || activeTab === 'all') && (
        <DrumGrid
          hits={quantizedDrums}
          totalBeats={totalBeats}
          currentBeat={currentBeat}
          onSeekBeat={seekBeat}
          onPreviewNote={(midi) => onPreviewNote(midi, 0.2, true)}
          onExport={() => handleDownloadMidi('drums')}
        />
      )}
    </div>
  );
}
