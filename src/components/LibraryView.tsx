import { useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Cpu,
  Download,
  FileAudio,
  Music,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { SeparationProgress, SongProject } from '../types/music';
import { DEMO_SONG_LIST, type DemoSongBlueprint } from '../audio/demoSongs';
import { formatKeySignature } from '../audio/notationEngine';
import {
  GPU_REQUIREMENTS_CONTENT,
  GPU_SERVER_PY_CONTENT,
  checkGpuServerHealth,
  type GpuHealthStatus,
  type GpuServerConfig,
} from '../audio/gpuClient';
import { triggerTextDownload } from '../utils/download';

interface LibraryViewProps {
  currentProject: SongProject;
  uploadedProjects: SongProject[];
  processing: SeparationProgress | null;
  error: string | null;
  gpuConfig: GpuServerConfig;
  gpuHealth: GpuHealthStatus | null;
  onChangeGpuConfig: (next: GpuServerConfig) => void;
  onUpdateGpuHealth: (status: GpuHealthStatus | null) => void;
  onSelectDemo: (blueprint: DemoSongBlueprint) => void;
  onSelectUploaded: (project: SongProject) => void;
  onUploadFile: (file: File) => void;
  onDismissError: () => void;
}

const SETUP_COMMANDS = `python -m venv stemforge-gpu
# Windows PowerShell: .\\stemforge-gpu\\Scripts\\Activate.ps1
# Linux / Mac:        source stemforge-gpu/bin/activate
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
uvicorn gpu_server:app --host 127.0.0.1 --port 8000`;

export function LibraryView({
  currentProject,
  uploadedProjects,
  processing,
  error,
  gpuConfig,
  gpuHealth,
  onChangeGpuConfig,
  onUpdateGpuHealth,
  onSelectDemo,
  onSelectUploaded,
  onUploadFile,
  onDismissError,
}: LibraryViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [testingGpu, setTestingGpu] = useState(false);
  const [gpuCheckError, setGpuCheckError] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [copiedCmds, setCopiedCmds] = useState(false);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onUploadFile(files[0]);
  };

  const handleTestGpu = async () => {
    setTestingGpu(true);
    setGpuCheckError(null);
    try {
      const status = await checkGpuServerHealth(gpuConfig.serverUrl);
      onUpdateGpuHealth(status);
    } catch (err) {
      onUpdateGpuHealth(null);
      setGpuCheckError(
        err instanceof Error ? err.message : 'Could not reach local GPU server.'
      );
    } finally {
      setTestingGpu(false);
    }
  };

  const handleCopyCommands = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_COMMANDS);
    } catch {
      // ignore restricted clipboard environments
    }
    setCopiedCmds(true);
    window.setTimeout(() => setCopiedCmds(false), 2500);
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-8">
      {/* Separation Engine Configuration */}
      <section
        aria-label="Separation engine settings"
        className="border border-white/[0.08] rounded-lg bg-[#13161C] p-5 flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-base font-bold text-white">Separation Engine</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Use your local NVIDIA RTX GPU running Meta htdemucs_6s for studio-grade neural
              separation, or run instantly in the browser with STFT DSP.
            </p>
          </div>

          <div
            role="group"
            aria-label="Select separation engine"
            className="inline-flex items-center p-1 bg-[#0B0D10] border border-white/[0.08] rounded-md"
          >
            <button
              type="button"
              aria-pressed={gpuConfig.mode === 'gpu'}
              onClick={() => onChangeGpuConfig({ ...gpuConfig, mode: 'gpu' })}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                gpuConfig.mode === 'gpu'
                  ? 'bg-amber-500 text-[#0B0D10] font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Local GPU (Demucs RTX)</span>
            </button>
            <button
              type="button"
              aria-pressed={gpuConfig.mode === 'browser'}
              onClick={() => onChangeGpuConfig({ ...gpuConfig, mode: 'browser' })}
              className={`px-3.5 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                gpuConfig.mode === 'browser'
                  ? 'bg-white/15 text-white font-semibold'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Browser STFT (No Setup)
            </button>
          </div>
        </div>

        {/* Local GPU Server Controls */}
        {gpuConfig.mode === 'gpu' && (
          <div className="pt-4 border-t border-white/[0.06] flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[240px] flex flex-col gap-1.5 text-xs text-slate-400">
                <span>Local GPU Server URL</span>
                <input
                  type="url"
                  value={gpuConfig.serverUrl}
                  onChange={(e) => {
                    onChangeGpuConfig({ ...gpuConfig, serverUrl: e.target.value });
                    onUpdateGpuHealth(null);
                    setGpuCheckError(null);
                  }}
                  placeholder="http://127.0.0.1:8000"
                  aria-label="Local GPU Server URL"
                  className="h-9 px-3 rounded-md bg-[#0B0D10] border border-white/[0.12] text-sm font-mono text-white placeholder:text-slate-600 focus-visible:outline-2 focus-visible:outline-amber-500"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs text-slate-400">
                <span>Keyboards Stem Mode</span>
                <select
                  aria-label="Demucs keyboards stem routing"
                  value={gpuConfig.pianoOnly ? 'piano' : 'merged'}
                  onChange={(e) =>
                    onChangeGpuConfig({ ...gpuConfig, pianoOnly: e.target.value === 'piano' })
                  }
                  className="h-9 px-3 rounded-md bg-[#0B0D10] border border-white/[0.12] text-xs font-mono text-slate-200 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500"
                >
                  <option value="merged" className="bg-[#13161C]">
                    Piano + Synths (Full Mix)
                  </option>
                  <option value="piano" className="bg-[#13161C]">
                    Piano Only (htdemucs_6s)
                  </option>
                </select>
              </label>

              <button
                type="button"
                disabled={testingGpu}
                onClick={() => void handleTestGpu()}
                className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${testingGpu ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>{testingGpu ? 'Checking GPU…' : 'Test GPU Connection'}</span>
              </button>
            </div>

            {/* Connection result feedback */}
            {gpuHealth && (
              <div
                role="status"
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3.5 py-2.5"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
                <span className="font-semibold">Connected</span>
                <span aria-hidden="true">·</span>
                <span>{gpuHealth.gpu}</span>
                {gpuHealth.vramGb && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{gpuHealth.vramGb} GB VRAM</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>{gpuHealth.model}</span>
                <span aria-hidden="true">·</span>
                <span>{gpuHealth.cuda ? 'CUDA Ready' : 'CPU Mode'}</span>
              </div>
            )}

            {gpuCheckError && (
              <div
                role="alert"
                className="flex items-start gap-2.5 text-xs text-rose-200 bg-rose-500/10 border border-rose-500/35 rounded-md px-3.5 py-2.5"
              >
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{gpuCheckError}</span>
              </div>
            )}

            {/* Download Kit & Collapsible Setup Instructions */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    triggerTextDownload(GPU_SERVER_PY_CONTENT, 'gpu_server.py', 'text/x-python;charset=utf-8')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#1B1F27] hover:bg-[#252B36] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Download gpu_server.py</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    triggerTextDownload(GPU_REQUIREMENTS_CONTENT, 'requirements.txt')
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#1B1F27] hover:bg-[#252B36] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Download requirements.txt</span>
                </button>
              </div>

              <button
                type="button"
                aria-expanded={showSetupGuide}
                onClick={() => setShowSetupGuide((prev) => !prev)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400 hover:text-amber-300 cursor-pointer whitespace-nowrap shrink-0"
              >
                <span>{showSetupGuide ? 'Hide RTX 4070 Setup Guide' : 'Show RTX 4070 Setup Guide'}</span>
                {showSetupGuide ? (
                  <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
            </div>

            {showSetupGuide && (
              <div className="bg-[#0B0D10] border border-white/[0.08] rounded-md p-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-300">
                    Place <code className="font-mono text-amber-300">gpu_server.py</code> and{' '}
                    <code className="font-mono text-amber-300">requirements.txt</code> in a folder
                    (Python 3.10/3.11 + FFmpeg installed), then run:
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopyCommands()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-200 bg-[#1B1F27] hover:bg-[#252B36] border border-white/[0.08] rounded cursor-pointer"
                  >
                    {copiedCmds ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" aria-hidden="true" />
                        <span>Copy Commands</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed p-3 rounded bg-[#13161C] border border-white/[0.06]">
                  {SETUP_COMMANDS}
                </pre>
                <p className="text-xs text-slate-400">
                  The first song downloads Meta&apos;s <span className="font-mono text-slate-300">htdemucs_6s</span>{' '}
                  weights once (~200 MB) and caches them in GPU VRAM. On an RTX 4070, each 4-minute
                  song separates in ~8–15 seconds.
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Audio Upload Dropzone */}
      <section aria-label="Import audio track">
        <div className="mb-3">
          <h2 className="font-display text-lg font-bold text-white">Import Audio Track</h2>
          <p className="text-sm text-slate-400 mt-1">
            {gpuConfig.mode === 'gpu'
              ? `Active engine: Local GPU Demucs (${gpuConfig.serverUrl}). Audio stays on your PC and separates into studio-grade Vocals, Guitar, Bass, Drums, and Keyboards.`
              : 'Active engine: Browser STFT DSP. Upload MP3, WAV, FLAC, OGG, M4A, or AAC files to separate locally with no setup.'}
          </p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          className={`rounded-lg border border-dashed p-8 sm:p-10 text-center transition-colors ${
            isDragging
              ? 'border-amber-400 bg-amber-500/10'
              : 'border-white/20 bg-[#13161C] hover:border-white/35'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.webm"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
            aria-label="Choose audio file to separate into stems"
            className="sr-only"
            id="audio-upload-input"
          />

          <div className="mx-auto w-12 h-12 rounded-md bg-[#1B1F27] border border-white/[0.08] flex items-center justify-center mb-4 text-amber-400">
            <Upload className="w-5 h-5" aria-hidden="true" />
          </div>

          <p className="text-sm font-medium text-white">
            Drag and drop an audio file here, or choose from your device
          </p>
          <p className="text-xs font-mono text-slate-400 mt-1.5">
            MP3 · WAV · FLAC · OGG · M4A · AAC · Splits into Vocals, Guitar, Bass, Drums, Keyboards
          </p>

          <div className="mt-5">
            <button
              type="button"
              disabled={Boolean(processing)}
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 text-sm font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-md transition-colors cursor-pointer"
            >
              {processing
                ? 'Separating Stems…'
                : gpuConfig.mode === 'gpu'
                  ? 'Select Audio File (Send to Local GPU)'
                  : 'Select Audio File'}
            </button>
          </div>

          {/* Live Processing Progress */}
          {processing && (
            <div
              role="status"
              aria-live="polite"
              className="mt-6 max-w-md mx-auto text-left bg-[#0B0D10] border border-white/[0.08] rounded-md p-4"
            >
              <div className="flex items-center justify-between text-xs mb-2">
                <span className="text-slate-200 font-medium">{processing.stage}</span>
                <span className="font-mono tabular-nums text-amber-400">{processing.percent}%</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 transition-all duration-200"
                  style={{ width: `${processing.percent}%` }}
                />
              </div>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div
              role="alert"
              className="mt-5 max-w-xl mx-auto flex flex-wrap items-start gap-3 text-left bg-rose-500/10 border border-rose-500/40 rounded-md px-4 py-3 text-xs text-rose-200"
            >
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-[200px]">{error}</div>
              <div className="flex items-center gap-3 shrink-0">
                {gpuConfig.mode === 'gpu' && (
                  <button
                    type="button"
                    onClick={() => {
                      onChangeGpuConfig({ ...gpuConfig, mode: 'browser' });
                      onDismissError();
                    }}
                    className="text-amber-300 hover:text-amber-200 underline cursor-pointer"
                  >
                    Use Browser STFT
                  </button>
                )}
                <button
                  type="button"
                  onClick={onDismissError}
                  className="text-rose-300 hover:text-white underline cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* User Uploaded Sessions (if any) */}
      {uploadedProjects.length > 0 && (
        <section aria-label="Your imported tracks">
          <h2 className="font-display text-base font-bold text-white mb-3">Your Imported Tracks</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {uploadedProjects.map((proj) => {
              const isCurrent = proj.id === currentProject.id;
              return (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => onSelectUploaded(proj)}
                  className={`p-4 rounded-lg border text-left transition-colors cursor-pointer ${
                    isCurrent
                      ? 'bg-amber-500/10 border-amber-500/60'
                      : 'bg-[#13161C] border-white/[0.08] hover:border-white/25'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <FileAudio className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                      <h3 className="text-sm font-semibold text-white truncate">{proj.title}</h3>
                    </div>
                    {isCurrent && (
                      <CheckCircle2
                        className="w-4 h-4 text-amber-400 shrink-0"
                        aria-label="Currently loaded"
                      />
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1 truncate">{proj.artist}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-mono tabular-nums text-slate-400">
                    <span>{proj.fileFormat}</span>
                    <span aria-hidden="true">·</span>
                    <span>{proj.bpm} BPM</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatKeySignature(proj.keyRootPc, proj.keyMode)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{Math.round(proj.duration)}s</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Built-in Studio Multi-Stem Demo Sessions */}
      <section aria-label="Built-in studio demo tracks">
        <div className="mb-3">
          <h2 className="font-display text-base font-bold text-white">Studio Demo Sessions</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Ready-to-mix 5-stem recordings synthesized locally so you can test vocal muting, MIDI
            conversion, tabs, chords, and sheet music immediately.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {DEMO_SONG_LIST.map((demo) => {
            const isCurrent = currentProject.id === demo.id;
            return (
              <button
                key={demo.id}
                type="button"
                onClick={() => onSelectDemo(demo)}
                className={`p-4 rounded-lg border text-left transition-colors cursor-pointer ${
                  isCurrent
                    ? 'bg-amber-500/10 border-amber-500/60'
                    : 'bg-[#13161C] border-white/[0.08] hover:border-white/25 hover:bg-[#171B22]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Music className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-white truncate">{demo.title}</h3>
                  </div>
                  {isCurrent && (
                    <span className="text-[11px] font-mono text-amber-400 shrink-0">Loaded</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {demo.artist} · {demo.genre}
                </p>
                <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-400">
                  <span>{demo.bpm} BPM</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatKeySignature(demo.keyRootPc, demo.keyMode)}</span>
                  <span aria-hidden="true">·</span>
                  <span>5 Stems</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
