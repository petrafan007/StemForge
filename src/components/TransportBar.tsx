import { Pause, Play, Repeat, Square, Timer, Minus, Plus } from 'lucide-react';
import type { SongProject } from '../types/music';
import { formatKeySignature } from '../audio/notationEngine';
import { formatTimecode } from '../utils/download';

interface TransportBarProps {
  project: SongProject;
  isPlaying: boolean;
  currentTime: number;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  playbackRate: number;
  transpose: number;
  onTogglePlay: () => void;
  onStop: () => void;
  onSeek: (timeSec: number) => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onChangeRate: (rate: number) => void;
  onChangeTranspose: (semitones: number) => void;
}

const SPEED_OPTIONS = [0.75, 0.85, 1.0, 1.15, 1.25];

export function TransportBar({
  project,
  isPlaying,
  currentTime,
  loopEnabled,
  metronomeEnabled,
  playbackRate,
  transpose,
  onTogglePlay,
  onStop,
  onSeek,
  onToggleLoop,
  onToggleMetronome,
  onChangeRate,
  onChangeTranspose,
}: TransportBarProps) {
  const effectiveBpm = Math.round(project.bpm * playbackRate);
  const keyLabel = formatKeySignature(project.keyRootPc, project.keyMode, transpose);
  const currentBeat = Math.floor((currentTime / 60) * project.bpm);
  const barNumber = Math.floor(currentBeat / project.timeSignature[0]) + 1;
  const beatInBar = (currentBeat % project.timeSignature[0]) + 1;
  const progressPct = project.duration > 0 ? Math.min(100, (currentTime / project.duration) * 100) : 0;

  return (
    <section
      aria-label="Master transport controls"
      className="bg-[#13161C] border-b border-white/[0.08]"
    >
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-3.5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Track identity & unboxed studio metadata */}
          <div className="min-w-0 flex flex-col gap-0.5">
            <div className="flex items-baseline gap-3 min-w-0">
              <h1 className="font-display text-base sm:text-lg font-bold text-white truncate">
                {project.title}
              </h1>
              <span className="text-xs text-slate-400 truncate hidden sm:inline">
                {project.artist}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-mono tabular-nums text-slate-400">
              <span className="text-slate-200">{effectiveBpm} BPM</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-200">{keyLabel}</span>
              <span aria-hidden="true">·</span>
              <span>
                {project.timeSignature[0]}/{project.timeSignature[1]}
              </span>
              <span aria-hidden="true">·</span>
              <span>{project.fileFormat}</span>
            </div>
          </div>

          {/* Center playback transport */}
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop and rewind to start"
              className="w-10 h-10 inline-flex items-center justify-center rounded-md bg-[#1B1F27] text-slate-300 hover:text-white hover:bg-[#252B36] border border-white/[0.08] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500"
            >
              <Square className="w-4 h-4 fill-current" aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={isPlaying ? 'Pause playback' : 'Play stems'}
              className="h-10 px-5 inline-flex items-center justify-center gap-2 rounded-md bg-amber-500 hover:bg-amber-400 text-[#0B0D10] font-semibold text-sm transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>Pause</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                  <span>Play</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={onToggleLoop}
              aria-pressed={loopEnabled}
              aria-label="Toggle loop playback"
              className={`h-10 px-3 inline-flex items-center gap-1.5 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
                loopEnabled
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                  : 'bg-[#1B1F27] border-white/[0.08] text-slate-400 hover:text-slate-200'
              }`}
            >
              <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Loop</span>
            </button>

            <button
              type="button"
              onClick={onToggleMetronome}
              aria-pressed={metronomeEnabled}
              aria-label="Toggle metronome click"
              className={`h-10 px-3 inline-flex items-center gap-1.5 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
                metronomeEnabled
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                  : 'bg-[#1B1F27] border-white/[0.08] text-slate-400 hover:text-slate-200'
              }`}
            >
              <Timer className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Click</span>
            </button>
          </div>

          {/* Right pitch transpose, speed, and tabular timecode */}
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            {/* Pitch / Key transpose */}
            <div className="flex items-center gap-1.5" role="group" aria-label="Pitch transpose">
              <span className="text-xs text-slate-400 mr-0.5">Key</span>
              <button
                type="button"
                onClick={() => onChangeTranspose(Math.max(-6, transpose - 1))}
                disabled={transpose <= -6}
                aria-label="Transpose down one semitone"
                className="w-7 h-7 inline-flex items-center justify-center rounded bg-[#1B1F27] border border-white/[0.08] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <Minus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <span className="w-8 text-center font-mono text-xs tabular-nums text-slate-200">
                {transpose > 0 ? `+${transpose}` : transpose}
              </span>
              <button
                type="button"
                onClick={() => onChangeTranspose(Math.min(6, transpose + 1))}
                disabled={transpose >= 6}
                aria-label="Transpose up one semitone"
                className="w-7 h-7 inline-flex items-center justify-center rounded bg-[#1B1F27] border border-white/[0.08] text-slate-300 hover:text-white disabled:opacity-40 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Speed selector */}
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>Speed</span>
              <select
                aria-label="Playback speed"
                value={playbackRate}
                onChange={(e) => onChangeRate(Number(e.target.value))}
                className="h-7 px-2 rounded bg-[#1B1F27] border border-white/[0.08] text-xs font-mono tabular-nums text-slate-200 focus-visible:outline-2 focus-visible:outline-amber-500 cursor-pointer"
              >
                {SPEED_OPTIONS.map((rate) => (
                  <option key={rate} value={rate} className="bg-[#13161C] text-slate-100">
                    {rate.toFixed(2)}x
                  </option>
                ))}
              </select>
            </label>

            {/* Timecode & Bar/Beat readout */}
            <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-slate-300 bg-[#0B0D10] border border-white/[0.08] px-3 py-1.5 rounded-md">
              <span className="text-white font-medium">{formatTimecode(currentTime)}</span>
              <span className="text-slate-600">/</span>
              <span className="text-slate-400">{formatTimecode(project.duration)}</span>
              <span className="text-slate-600 hidden sm:inline">·</span>
              <span className="text-amber-400 hidden sm:inline">
                Bar {barNumber}.{beatInBar}
              </span>
            </div>
          </div>
        </div>

        {/* Master Scrubber Bar */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 h-2 bg-[#0B0D10] rounded-full overflow-hidden border border-white/[0.06]">
            <div
              className="absolute inset-y-0 left-0 bg-amber-500/80 pointer-events-none"
              style={{ width: `${progressPct}%` }}
            />
            <input
              type="range"
              min={0}
              max={project.duration || 1}
              step={0.05}
              value={currentTime}
              onChange={(e) => onSeek(Number(e.target.value))}
              aria-label="Master timeline position"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
