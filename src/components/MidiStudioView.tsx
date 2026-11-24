import { useMemo, useState } from 'react';
import { Download, Volume2 } from 'lucide-react';
import type { DrumVoice, QuantizeGrid, SongProject } from '../types/music';
import {
  drumHitsToMidiEvents,
  encodeMidiFile,
  quantizeDrumHits,
  quantizeMidiNotes,
} from '../audio/midiEncoder';
import { midiToNoteName } from '../audio/notationEngine';
import { slugifyFilename, triggerBinaryDownload } from '../utils/download';

type MidiTrackTab = 'keyboards' | 'drums' | 'combined';

interface MidiStudioViewProps {
  project: SongProject;
  currentTime: number;
  transpose: number;
  quantize: QuantizeGrid;
  minVelocity: number;
  midiPreviewMode: 'off' | 'keyboards' | 'drums' | 'combined';
  onChangeQuantize: (grid: QuantizeGrid) => void;
  onChangeMinVelocity: (vel: number) => void;
  onChangeMidiPreviewMode: (mode: 'off' | 'keyboards' | 'drums' | 'combined') => void;
  onSeek: (timeSec: number) => void;
  onPreviewNote: (midi: number, durationSec?: number, isDrum?: boolean) => void;
}

const DRUM_LANES: Array<{ voice: DrumVoice; label: string; midi: number; color: string }> = [
  { voice: 'crash', label: 'Crash (49)', midi: 49, color: '#F59E0B' },
  { voice: 'openhat', label: 'Open Hat (46)', midi: 46, color: '#38BDF8' },
  { voice: 'hihat', label: 'Closed Hat (42)', midi: 42, color: '#34D399' },
  { voice: 'tom', label: 'Mid Tom (45)', midi: 45, color: '#FB7185' },
  { voice: 'snare', label: 'Snare (38)', midi: 38, color: '#A78BFA' },
  { voice: 'kick', label: 'Kick (36)', midi: 36, color: '#F43F5E' },
];

function isBlackKey(midi: number): boolean {
  const pc = ((midi % 12) + 12) % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
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
}: MidiStudioViewProps) {
  const [activeTab, setActiveTab] = useState<MidiTrackTab>('keyboards');
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const quantizedKeys = useMemo(
    () =>
      quantizeMidiNotes(project.keyboardMidi, quantize, minVelocity).map((n) => ({
        ...n,
        midi: Math.max(21, Math.min(108, n.midi + transpose)),
      })),
    [project.keyboardMidi, quantize, minVelocity, transpose]
  );

  const quantizedDrums = useMemo(
    () => quantizeDrumHits(project.drumHits, quantize, minVelocity),
    [project.drumHits, quantize, minVelocity]
  );

  const totalBeats = Math.max(8, Math.ceil((project.duration * project.bpm) / 60));
  const currentBeat = (currentTime * project.bpm) / 60;
  const pxPerBeat = 38;
  const gridWidth = Math.max(760, totalBeats * pxPerBeat);

  // Determine vertical pitch span for keyboard piano roll
  const { minPitch, maxPitch } = useMemo(() => {
    if (quantizedKeys.length === 0) return { minPitch: 48, maxPitch: 72 };
    let lo = 127;
    let hi = 0;
    for (const n of quantizedKeys) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    return {
      minPitch: Math.max(36, lo - 2),
      maxPitch: Math.min(96, Math.max(lo + 14, hi + 2)),
    };
  }, [quantizedKeys]);

  const pitchRows = useMemo(() => {
    const rows: number[] = [];
    for (let m = maxPitch; m >= minPitch; m--) {
      rows.push(m);
    }
    return rows;
  }, [minPitch, maxPitch]);

  const handleDownloadMidi = (scope: MidiTrackTab) => {
    const tracks = [];
    if (scope === 'keyboards' || scope === 'combined') {
      tracks.push({
        name: 'Keyboards',
        program: 4, // Electric Piano 1
        notes: quantizedKeys,
      });
    }
    if (scope === 'drums' || scope === 'combined') {
      tracks.push({
        name: 'Drums',
        notes: drumHitsToMidiEvents(quantizedDrums),
      });
    }

    const bytes = encodeMidiFile({
      bpm: project.bpm,
      timeSignature: project.timeSignature,
      tracks,
    });
    const suffix = scope === 'combined' ? 'keys_and_drums' : scope;
    const filename = `${slugifyFilename(project.title)}_${suffix}.mid`;
    triggerBinaryDownload(bytes, filename, 'audio/midi');
    setExportMessage(`Exported ${filename} (${bytes.length.toLocaleString()} bytes)`);
    window.setTimeout(() => setExportMessage(null), 4000);
  };

  const handleTimelineSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left);
    const beat = x / pxPerBeat;
    onSeek((beat * 60) / project.bpm);
  };

  const showKeys = activeTab === 'keyboards' || activeTab === 'combined';
  const showDrums = activeTab === 'drums' || activeTab === 'combined';

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      {/* Header Controls Row */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {/* Segmented Instrument Selector */}
          <div
            role="tablist"
            aria-label="MIDI track view"
            className="inline-flex items-center p-1 bg-[#13161C] border border-white/[0.08] rounded-md"
          >
            {(
              [
                { id: 'keyboards', label: `Keyboards (${quantizedKeys.length})` },
                { id: 'drums', label: `Drums (${quantizedDrums.length})` },
                { id: 'combined', label: 'Combined' },
              ] as Array<{ id: MidiTrackTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-amber-500 text-[#0B0D10] font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Quantization & Sensitivity Controls */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
            <label className="flex items-center gap-1.5">
              <span>Quantize</span>
              <select
                aria-label="MIDI quantize grid"
                value={quantize}
                onChange={(e) => onChangeQuantize(e.target.value as QuantizeGrid)}
                className="h-8 px-2.5 rounded bg-[#13161C] border border-white/[0.08] text-xs font-mono text-slate-200 cursor-pointer"
              >
                <option value="1/4" className="bg-[#13161C]">
                  1/4 Note
                </option>
                <option value="1/8" className="bg-[#13161C]">
                  1/8 Note
                </option>
                <option value="1/16" className="bg-[#13161C]">
                  1/16 Note
                </option>
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
          </div>
        </div>

        {/* Synth Preview Toggle & Export .MID */}
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() =>
              onChangeMidiPreviewMode(midiPreviewMode === activeTab ? 'off' : activeTab)
            }
            aria-pressed={midiPreviewMode === activeTab}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              midiPreviewMode === activeTab
                ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              {midiPreviewMode === activeTab ? 'MIDI Synth Preview On' : 'Preview MIDI Synth'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleDownloadMidi(activeTab)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
            <span>
              Download{' '}
              {activeTab === 'combined'
                ? 'Combined'
                : activeTab === 'keyboards'
                  ? 'Keyboards'
                  : 'Drums'}{' '}
              MIDI (.mid)
            </span>
          </button>
        </div>
      </div>

      {/* Inline Export Feedback */}
      {exportMessage && (
        <div
          role="status"
          className="text-xs font-mono text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3.5 py-2"
        >
          {exportMessage}
        </div>
      )}

      {/* Keyboards Piano Roll */}
      {showKeys && (
        <section
          aria-label="Keyboards MIDI piano roll"
          className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden"
        >
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-white">Keyboards Track · Channel 1</span>
              <span className="text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="font-mono tabular-nums text-slate-400">
                {quantizedKeys.length} MIDI notes · Range {midiToNoteName(minPitch)}–
                {midiToNoteName(maxPitch)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleDownloadMidi('keyboards')}
              className="text-xs text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 cursor-pointer"
            >
              Export Keyboards .mid
            </button>
          </div>

          {quantizedKeys.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No keyboard notes exceed velocity {minVelocity}. Lower the Min Velocity slider to reveal softer notes.
            </div>
          ) : (
            <div className="flex overflow-x-auto studio-scroll">
              {/* Piano key labels column */}
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
                      onClick={() => onPreviewNote(midi, 0.35, false)}
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

              {/* Piano roll grid */}
              <div
                className="relative select-none"
                style={{ width: `${gridWidth}px` }}
                onClick={handleTimelineSeek}
              >
                {/* Measure ruler */}
                <div className="h-6 border-b border-white/[0.08] relative bg-[#0E1015]">
                  {Array.from({ length: totalBeats }).map((_, beat) => (
                    <div
                      key={beat}
                      style={{ left: `${beat * pxPerBeat}px`, width: `${pxPerBeat}px` }}
                      className={`absolute inset-y-0 border-l text-[10px] font-mono tabular-nums pl-1 flex items-center ${
                        beat % 4 === 0
                          ? 'border-white/20 text-slate-300'
                          : 'border-white/[0.05] text-slate-600'
                      }`}
                    >
                      {beat % 4 === 0 ? `M${beat / 4 + 1}` : ''}
                    </div>
                  ))}
                </div>

                {/* Note lanes */}
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

                  {/* Vertical beat gridlines */}
                  {Array.from({ length: totalBeats }).map((_, beat) => (
                    <div
                      key={beat}
                      style={{ left: `${beat * pxPerBeat}px` }}
                      className={`absolute top-0 bottom-0 border-l pointer-events-none ${
                        beat % 4 === 0 ? 'border-white/[0.12]' : 'border-white/[0.04]'
                      }`}
                    />
                  ))}

                  {/* Rendered MIDI Note Rectangles */}
                  {quantizedKeys.map((note) => {
                    const rowIdx = maxPitch - note.midi;
                    if (rowIdx < 0 || rowIdx >= pitchRows.length) return null;
                    const left = note.startBeat * pxPerBeat;
                    const width = Math.max(10, note.durationBeats * pxPerBeat - 2);
                    const isPlayingNow =
                      currentBeat >= note.startBeat &&
                      currentBeat <= note.startBeat + note.durationBeats;

                    return (
                      <button
                        key={note.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPreviewNote(note.midi, 0.35, false);
                        }}
                        title={`${midiToNoteName(note.midi)} · Beat ${note.startBeat + 1} · Vel ${note.velocity}`}
                        aria-label={`Keyboard note ${midiToNoteName(note.midi)} at beat ${note.startBeat + 1}`}
                        style={{
                          left: `${left}px`,
                          top: `${rowIdx * 20 + 2}px`,
                          width: `${width}px`,
                        }}
                        className={`absolute h-4 rounded-[3px] text-[9px] font-mono px-1 text-left truncate transition-colors cursor-pointer ${
                          isPlayingNow
                            ? 'bg-amber-400 text-[#0B0D10] font-semibold'
                            : 'bg-emerald-500/80 hover:bg-emerald-400 text-[#0B0D10]'
                        }`}
                      >
                        {width > 24 ? midiToNoteName(note.midi) : ''}
                      </button>
                    );
                  })}

                  {/* Live Playhead */}
                  <div
                    aria-hidden="true"
                    style={{ left: `${currentBeat * pxPerBeat}px` }}
                    className="absolute top-0 bottom-0 w-0.5 bg-amber-500 pointer-events-none z-10"
                  />
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Drums General MIDI Grid */}
      {showDrums && (
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
                {quantizedDrums.length} percussion hits mapped to GM standard notes
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleDownloadMidi('drums')}
              className="text-xs text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 cursor-pointer"
            >
              Export Drums .mid
            </button>
          </div>

          <div className="flex overflow-x-auto studio-scroll">
            {/* Drum Kit Voice Column */}
            <div className="sticky left-0 z-10 w-44 shrink-0 bg-[#11141A] border-r border-white/[0.08]">
              <div className="h-6 border-b border-white/[0.08] text-[10px] font-mono text-slate-500 px-3 flex items-center">
                GM Drum Pad
              </div>
              {DRUM_LANES.map((lane) => (
                <button
                  key={lane.voice}
                  type="button"
                  onClick={() => onPreviewNote(lane.midi, 0.2, true)}
                  aria-label={`Audition ${lane.label}`}
                  className="w-full h-9 px-3 flex items-center gap-2 text-xs font-mono text-slate-300 hover:text-white hover:bg-white/[0.04] border-b border-white/[0.05] cursor-pointer"
                >
                  <span
                    aria-hidden="true"
                    className="w-2 h-2 rounded-xs shrink-0"
                    style={{ backgroundColor: lane.color }}
                  />
                  <span className="truncate">{lane.label}</span>
                </button>
              ))}
            </div>

            {/* Drum Hit Matrix */}
            <div
              className="relative select-none"
              style={{ width: `${gridWidth}px` }}
              onClick={handleTimelineSeek}
            >
              <div className="h-6 border-b border-white/[0.08] relative bg-[#0E1015]">
                {Array.from({ length: totalBeats }).map((_, beat) => (
                  <div
                    key={beat}
                    style={{ left: `${beat * pxPerBeat}px`, width: `${pxPerBeat}px` }}
                    className={`absolute inset-y-0 border-l text-[10px] font-mono tabular-nums pl-1 flex items-center ${
                      beat % 4 === 0
                        ? 'border-white/20 text-slate-300'
                        : 'border-white/[0.05] text-slate-600'
                    }`}
                  >
                    {beat % 4 === 0 ? `M${beat / 4 + 1}` : ''}
                  </div>
                ))}
              </div>

              <div className="relative" style={{ height: `${DRUM_LANES.length * 36}px` }}>
                {DRUM_LANES.map((lane, rowIdx) => (
                  <div
                    key={lane.voice}
                    style={{ top: `${rowIdx * 36}px` }}
                    className="absolute left-0 right-0 h-9 border-b border-white/[0.05] bg-[#0F1218]/60"
                  />
                ))}

                {Array.from({ length: totalBeats }).map((_, beat) => (
                  <div
                    key={beat}
                    style={{ left: `${beat * pxPerBeat}px` }}
                    className={`absolute top-0 bottom-0 border-l pointer-events-none ${
                      beat % 4 === 0 ? 'border-white/[0.12]' : 'border-white/[0.04]'
                    }`}
                  />
                ))}

                {quantizedDrums.map((hit) => {
                  const laneIdx = DRUM_LANES.findIndex((l) => l.voice === hit.voice);
                  if (laneIdx === -1) return null;
                  const lane = DRUM_LANES[laneIdx];
                  const left = hit.startBeat * pxPerBeat;
                  const isActive = Math.abs(currentBeat - hit.startBeat) < 0.25;
                  const opacity = Math.max(0.45, hit.velocity / 127);

                  return (
                    <button
                      key={hit.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onPreviewNote(hit.midi, 0.2, true);
                      }}
                      title={`${lane.label} · Beat ${hit.startBeat + 1} · Vel ${hit.velocity}`}
                      aria-label={`${lane.label} hit at beat ${hit.startBeat + 1}`}
                      style={{
                        left: `${left + 1}px`,
                        top: `${laneIdx * 36 + 7}px`,
                        backgroundColor: isActive ? '#F59E0B' : lane.color,
                        opacity: isActive ? 1 : opacity,
                      }}
                      className="absolute w-3.5 h-5 rounded-[3px] transition-transform hover:scale-110 cursor-pointer"
                    />
                  );
                })}

                <div
                  aria-hidden="true"
                  style={{ left: `${currentBeat * pxPerBeat}px` }}
                  className="absolute top-0 bottom-0 w-0.5 bg-amber-500 pointer-events-none z-10"
                />
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
