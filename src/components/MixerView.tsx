import { useEffect, useRef } from 'react';
import { Download, MicOff, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { STEM_LIST, type SongProject, type StemId, type StemMixerState } from '../types/music';
import { encodeWavPcm } from '../audio/midiEncoder';
import { slugifyFilename, triggerBinaryDownload } from '../utils/download';

interface MixerViewProps {
  project: SongProject;
  mixer: Record<StemId, StemMixerState>;
  currentTime: number;
  onUpdateStem: (id: StemId, patch: Partial<StemMixerState>) => void;
  onApplyPreset: (preset: 'all' | 'instrumental' | 'vocalsOnly' | 'rhythm') => void;
  onSeek: (timeSec: number) => void;
  onOpenMidi: () => void;
  onOpenNotation: () => void;
}

interface WaveformCanvasProps {
  peaks: number[];
  color: string;
  dimColor: string;
  active: boolean;
  progress: number;
  duration: number;
  label: string;
  onSeek: (timeSec: number) => void;
}

function WaveformCanvas({
  peaks,
  color,
  dimColor,
  active,
  progress,
  duration,
  label,
  onSeek,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 64;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Subtle center baseline
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Draw mirrored waveform bars
    const count = peaks.length || 1;
    const step = width / count;
    const barWidth = Math.max(1.5, step - 1.2);
    const playheadX = progress * width;

    for (let i = 0; i < count; i++) {
      const amp = Math.max(0.04, peaks[i]);
      const barH = amp * (height * 0.82);
      const x = i * step;
      const isPlayed = x <= playheadX;

      if (!active) {
        ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
      } else {
        ctx.fillStyle = isPlayed ? color : dimColor;
      }

      ctx.fillRect(x, midY - barH / 2, barWidth, barH);
    }

    // Playhead vertical line
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();

    ctx.restore();
  }, [peaks, color, dimColor, active, progress]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    onSeek(ratio * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      onClick={handleClick}
      data-testid={`waveform-${label.toLowerCase()}`}
      aria-label={`${label} audio waveform, click to seek`}
      className="w-full h-16 block cursor-pointer rounded bg-[#0B0D10]"
    />
  );
}

export function MixerView({
  project,
  mixer,
  currentTime,
  onUpdateStem,
  onApplyPreset,
  onSeek,
  onOpenMidi,
  onOpenNotation,
}: MixerViewProps) {
  const anySolo = (Object.values(mixer) as StemMixerState[]).some((s) => s.solo);
  const isInstrumental =
    mixer.vocals.muted &&
    !mixer.guitar.muted &&
    !mixer.bass.muted &&
    !mixer.drums.muted &&
    !mixer.keyboards.muted &&
    !anySolo;
  const isVocalsOnly = mixer.vocals.solo && !mixer.guitar.solo && !mixer.bass.solo;
  const isRhythm =
    !mixer.bass.muted &&
    !mixer.drums.muted &&
    mixer.vocals.muted &&
    mixer.guitar.muted &&
    mixer.keyboards.muted;
  const isAllActive = !anySolo && (Object.values(mixer) as StemMixerState[]).every((s) => !s.muted);

  const progress = project.duration > 0 ? Math.min(1, currentTime / project.duration) : 0;

  const handleExportStemWav = (id: StemId) => {
    const buffer = project.stems[id].buffer;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }
    const wavBytes = encodeWavPcm(channels, buffer.sampleRate);
    triggerBinaryDownload(wavBytes, `${slugifyFilename(project.title)}_${id}.wav`, 'audio/wav');
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      {/* Toolbar: Quick Isolation Presets & Cross-Workspace Jump Links */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Mix presets">
          <span className="text-xs font-medium text-slate-400 mr-1">Quick Mix</span>
          <button
            type="button"
            onClick={() => onApplyPreset('all')}
            aria-pressed={isAllActive}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isAllActive
                ? 'bg-white/10 border-white/25 text-white'
                : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
            }`}
          >
            All 5 Tracks
          </button>
          <button
            type="button"
            onClick={() => onApplyPreset('instrumental')}
            aria-pressed={isInstrumental}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isInstrumental
                ? 'bg-rose-500/20 border-rose-500/50 text-rose-200'
                : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
            }`}
          >
            <MicOff className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Instrumental (Mute Vocals)</span>
          </button>
          <button
            type="button"
            onClick={() => onApplyPreset('vocalsOnly')}
            aria-pressed={isVocalsOnly}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isVocalsOnly
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
            }`}
          >
            Vocals Only
          </button>
          <button
            type="button"
            onClick={() => onApplyPreset('rhythm')}
            aria-pressed={isRhythm}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              isRhythm
                ? 'bg-violet-500/20 border-violet-500/50 text-violet-200'
                : 'bg-[#13161C] border-white/[0.08] text-slate-300 hover:text-white hover:bg-[#1B1F27]'
            }`}
          >
            Bass & Drums
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <button
            type="button"
            onClick={onOpenMidi}
            className="text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 hover:decoration-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Convert Keys & Drums to MIDI
          </button>
          <span className="text-slate-600" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={onOpenNotation}
            className="text-slate-300 hover:text-amber-400 underline underline-offset-4 decoration-white/20 hover:decoration-amber-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Guitar & Bass Tabs / Chords / Sheet
          </button>
        </div>
      </div>

      {/* 5 Separated Stem Tracks */}
      <div
        className="border border-white/[0.08] rounded-lg overflow-hidden bg-[#13161C] divide-y divide-white/[0.06]"
        data-testid="stem-mixer-tracks"
      >
        {STEM_LIST.map((stemMeta) => {
          const state = mixer[stemMeta.id];
          const trackData = project.stems[stemMeta.id];
          const isAudible = !state.muted && (!anySolo || state.solo);
          const volumePct = Math.round(state.volume * 100);

          return (
            <div
              key={stemMeta.id}
              data-stem-id={stemMeta.id}
              data-audible={isAudible ? 'true' : 'false'}
              className={`grid grid-cols-1 lg:grid-cols-[290px_1fr_auto] items-center gap-4 px-4 py-3.5 transition-colors ${
                isAudible ? 'bg-[#13161C]' : 'bg-[#0E1015]'
              }`}
            >
              {/* Left channel strip: Identity, M/S, Volume fader */}
              <div className="flex flex-col gap-2.5 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      aria-hidden="true"
                      className="w-2 h-6 rounded-sm shrink-0"
                      style={{ backgroundColor: isAudible ? stemMeta.color : 'rgba(148,163,184,0.25)' }}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2
                          className={`text-sm font-semibold truncate ${
                            isAudible ? 'text-white' : 'text-slate-500'
                          }`}
                        >
                          {stemMeta.label}
                        </h2>
                        <span className="text-[11px] font-mono text-slate-500 hidden sm:inline">
                          {stemMeta.role}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Mute & Solo controls */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onUpdateStem(stemMeta.id, { muted: !state.muted })}
                      aria-pressed={state.muted}
                      aria-label={`Mute ${stemMeta.label}`}
                      title={`Mute ${stemMeta.label} (Key ${stemMeta.shortcut})`}
                      className={`w-8 h-8 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
                        state.muted
                          ? 'bg-rose-500/25 border-rose-500 text-rose-200'
                          : 'bg-[#1B1F27] border-white/[0.08] text-slate-300 hover:text-white hover:border-white/20'
                      }`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => onUpdateStem(stemMeta.id, { solo: !state.solo })}
                      aria-pressed={state.solo}
                      aria-label={`Solo ${stemMeta.label}`}
                      title={`Solo ${stemMeta.label}`}
                      className={`w-8 h-8 rounded text-xs font-mono font-semibold border transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
                        state.solo
                          ? 'bg-amber-500/25 border-amber-500 text-amber-200'
                          : 'bg-[#1B1F27] border-white/[0.08] text-slate-300 hover:text-white hover:border-white/20'
                      }`}
                    >
                      S
                    </button>
                  </div>
                </div>

                {/* Volume Fader */}
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => onUpdateStem(stemMeta.id, { muted: !state.muted })}
                    aria-label={state.muted ? `Unmute ${stemMeta.label}` : `Silence ${stemMeta.label}`}
                    className="text-slate-400 hover:text-slate-200 shrink-0 cursor-pointer"
                  >
                    {isAudible && state.volume > 0 ? (
                      <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                      <VolumeX className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                    )}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1.25}
                    step={0.01}
                    value={state.volume}
                    onChange={(e) =>
                      onUpdateStem(stemMeta.id, {
                        volume: Number(e.target.value),
                        muted: false,
                      })
                    }
                    aria-label={`${stemMeta.label} volume`}
                    className="studio-fader flex-1"
                  />
                  <span className="w-10 text-right font-mono text-xs tabular-nums text-slate-400">
                    {isAudible ? `${volumePct}%` : 'Mute'}
                  </span>
                </div>
              </div>

              {/* Center Interactive Waveform */}
              <div className="min-w-0">
                <WaveformCanvas
                  peaks={trackData.peaks}
                  color={stemMeta.color}
                  dimColor={stemMeta.dimColor}
                  active={isAudible}
                  progress={progress}
                  duration={project.duration}
                  label={stemMeta.label}
                  onSeek={onSeek}
                />
              </div>

              {/* Right Stem Actions: Export WAV */}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleExportStemWav(stemMeta.id)}
                  aria-label={`Download ${stemMeta.label} stem as WAV`}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-[#1B1F27] hover:bg-[#252B36] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>WAV</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Subtle footer helper line */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Click any waveform to seek</span>
          <span aria-hidden="true">·</span>
          <span>Press Space to play or pause</span>
          <span aria-hidden="true">·</span>
          <span>Keys 1–5 mute individual tracks</span>
        </div>
        <button
          type="button"
          onClick={() => onApplyPreset('all')}
          className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Reset Mix</span>
        </button>
      </div>
    </div>
  );
}
