import { useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, FileAudio, FolderOpen, Loader2, Music, RefreshCw, Save, Settings, Trash2, Upload } from 'lucide-react';
import type { SeparationProgress, SongProject } from '../types/music';
import { DEMO_SONG_LIST, type DemoSongBlueprint } from '../audio/demoSongs';
import { formatKeySignature } from '../audio/notationEngine';
import type { GpuHealthStatus, ProjectSummary } from '../audio/serverApi';
import { FILE_INPUT_ACCEPT } from '../audio/stemSeparator';
import { formatTimecode } from '../utils/download';
import { dangerButtonClass, secondaryButtonClass } from './ui';

interface LibraryViewProps {
  currentProject: SongProject;
  uploadedProjects: SongProject[];
  processing: (SeparationProgress & { projectId?: string }) | null;
  error: string | null;
  engineMode: 'gpu' | 'browser';
  health: GpuHealthStatus | null;
  projects: ProjectSummary[] | null;
  projectsDir: string | null;
  onRefreshProjects: () => void;
  onOpenProject: (id: string) => void;
  onSaveProjectSfg: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onOpenSfg: () => void;
  onRevealProjects: () => void;
  onCancelProcessing: () => void;
  onSelectDemo: (blueprint: DemoSongBlueprint) => void;
  onSelectUploaded: (project: SongProject) => void;
  onUploadFile: (file: File) => void;
  onDismissError: () => void;
  onOpenSettings: () => void;
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function LibraryView({
  currentProject,
  uploadedProjects,
  processing,
  error,
  engineMode,
  health,
  projects,
  projectsDir,
  onRefreshProjects,
  onOpenProject,
  onSaveProjectSfg,
  onDeleteProject,
  onOpenSfg,
  onRevealProjects,
  onCancelProcessing,
  onSelectDemo,
  onSelectUploaded,
  onUploadFile,
  onDismissError,
  onOpenSettings,
}: LibraryViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const gpu = engineMode === 'gpu';

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-8">
      {/* Engine status */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 text-slate-400">
          {gpu && health ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>
                Local GPU engine: <span className="text-slate-200">{health.gpu}</span> · notes {health.transcriber ? 'Basic Pitch' : 'unavailable'} · drums{' '}
                {health.drumTranscriber === 'adtof' ? 'ADTOF' : 'onset detector'}
              </span>
            </>
          ) : gpu ? (
            <>
              <AlertCircle className="w-4 h-4 text-amber-400" aria-hidden="true" />
              <span>Local GPU engine not connected — start StemForge from the desktop shortcut.</span>
            </>
          ) : (
            <span>Browser engine (no setup, lower quality, songs are not saved).</span>
          )}
        </div>
        <button type="button" onClick={onOpenSettings} className={secondaryButtonClass}>
          <Settings className="w-3.5 h-3.5" aria-hidden="true" />
          Engine & genre settings
        </button>
      </div>

      {/* Import */}
      <section aria-label="Import audio or video">
        <div className="mb-3">
          <h2 className="font-display text-lg font-bold text-white">Import a Song</h2>
          <p className="text-sm text-slate-400 mt-1">
            {gpu
              ? 'Splits into vocals, guitar(s), bass, drums and keyboards on your GPU, transcribes every part, and saves it to your projects automatically.'
              : 'Browser mode: separation runs on the CPU in this window and is not saved.'}
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
            const f = e.dataTransfer.files?.[0];
            if (f) onUploadFile(f);
          }}
          className={`rounded-lg border border-dashed p-8 sm:p-10 text-center transition-colors ${
            isDragging ? 'border-amber-400 bg-amber-500/10' : 'border-white/20 bg-[#13161C] hover:border-white/35'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_INPUT_ACCEPT}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadFile(f);
              e.target.value = '';
            }}
            aria-label="Choose an audio or video file"
            className="sr-only"
            id="audio-upload-input"
          />
          <div className="mx-auto w-12 h-12 rounded-md bg-[#1B1F27] border border-white/[0.08] flex items-center justify-center mb-4 text-amber-400">
            <Upload className="w-5 h-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-white">Drag and drop an audio or video file here, or choose one</p>
          <p className="text-xs font-mono text-slate-400 mt-1.5">MP3 · WAV · FLAC · OGG · M4A · AAC · AIFF · MP4 · MOV · MKV · WEBM</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={Boolean(processing)}
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 text-sm font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-md transition-colors cursor-pointer"
            >
              {processing ? 'Processing…' : 'Choose a file'}
            </button>
            <button type="button" onClick={onOpenSfg} className={`${secondaryButtonClass} py-2.5`}>
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              Open project (.sfg)
            </button>
          </div>

          {processing && (
            <div role="status" aria-live="polite" className="mt-6 max-w-md mx-auto text-left bg-[#0B0D10] border border-white/[0.08] rounded-md p-4">
              <div className="flex items-center justify-between text-xs mb-2 gap-3">
                <span className="text-slate-200 font-medium">{processing.stage}</span>
                <span className="font-mono tabular-nums text-amber-400">{Math.round(processing.percent)}%</span>
              </div>
              <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div className="h-full bg-amber-500 transition-all duration-300" style={{ width: `${processing.percent}%` }} />
              </div>
              {processing.projectId && (
                <div className="mt-3 flex justify-end">
                  <button type="button" onClick={onCancelProcessing} className="text-xs text-slate-400 hover:text-white underline cursor-pointer">
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div role="alert" className="mt-5 max-w-xl mx-auto flex flex-wrap items-start gap-3 text-left bg-rose-500/10 border border-rose-500/40 rounded-md px-4 py-3 text-xs text-rose-200">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="flex-1 min-w-[200px]">{error}</div>
              <button type="button" onClick={onDismissError} className="text-rose-300 hover:text-white underline cursor-pointer">
                Dismiss
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Projects */}
      {gpu && (
        <section aria-label="Your projects">
          <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
            <div>
              <h2 className="font-display text-base font-bold text-white">Your Projects</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Saved automatically{projectsDir ? ` in ${projectsDir}` : ''}. Deleted projects go to the .trash folder there.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={onRefreshProjects} className={secondaryButtonClass}>
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Refresh
              </button>
              <button type="button" onClick={onRevealProjects} className={secondaryButtonClass}>
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                Open folder
              </button>
            </div>
          </div>
          {projects === null ? (
            <p className="text-xs text-slate-500">Connecting to the GPU engine…</p>
          ) : projects.length === 0 ? (
            <p className="text-xs text-slate-500">No projects yet — import a song above.</p>
          ) : (
            <div className="border border-white/[0.08] rounded-lg overflow-hidden divide-y divide-white/[0.06] bg-[#13161C]">
              {projects.map((p) => {
                const isCurrent = currentProject.serverProjectId === p.id;
                return (
                  <div key={p.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${isCurrent ? 'bg-amber-500/[0.07]' : ''}`}>
                    <FileAudio className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    <div className="min-w-[220px] flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white truncate">{p.title}</span>
                        {isCurrent && <span className="text-[10px] font-mono text-amber-400">OPEN</span>}
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        {[p.artist, p.album].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    <div className="text-xs font-mono tabular-nums text-slate-400 flex flex-wrap gap-x-3">
                      {p.durationSec ? <span>{formatTimecode(p.durationSec).slice(0, 5)}</span> : null}
                      {p.bpm ? <span>{Math.round(p.bpm)} BPM</span> : null}
                      <span>{p.stems.length} stems</span>
                      {p.sizeMB ? <span>{p.sizeMB} MB</span> : null}
                      <span className="hidden md:inline">{formatDate(p.updatedAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 ml-auto">
                      {p.status === 'processing' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" aria-hidden="true" />
                          {p.stage ?? 'Processing'} {p.percent !== undefined ? `${Math.round(p.percent)}%` : ''}
                        </span>
                      ) : p.status === 'error' ? (
                        <span className="text-xs text-rose-300" title={p.error ?? ''}>
                          Failed
                        </span>
                      ) : (
                        <>
                          <button type="button" className={secondaryButtonClass} onClick={() => onOpenProject(p.id)}>
                            Open
                          </button>
                          <button type="button" className={secondaryButtonClass} onClick={() => onSaveProjectSfg(p.id)} title="Save a single-file copy (.sfg)">
                            <Save className="w-3.5 h-3.5" aria-hidden="true" />
                            .sfg
                          </button>
                        </>
                      )}
                      {confirmDelete === p.id ? (
                        <>
                          <button
                            type="button"
                            className={dangerButtonClass}
                            onClick={() => {
                              setConfirmDelete(null);
                              onDeleteProject(p.id);
                            }}
                          >
                            Move to trash
                          </button>
                          <button type="button" className={secondaryButtonClass} onClick={() => setConfirmDelete(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className={secondaryButtonClass}
                          disabled={p.status === 'processing'}
                          onClick={() => setConfirmDelete(p.id)}
                          aria-label={`Delete ${p.title}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {uploadedProjects.length > 0 && (
        <section aria-label="Temporary songs">
          <h2 className="font-display text-base font-bold text-white mb-1">Temporary Songs (this session)</h2>
          <p className="text-xs text-slate-400 mb-3">Browser-engine imports are not saved. Re-import them with the Local GPU engine to keep them.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {uploadedProjects.map((proj) => {
              const isCurrent = proj.id === currentProject.id;
              return (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => onSelectUploaded(proj)}
                  className={`p-4 rounded-lg border text-left transition-colors cursor-pointer ${
                    isCurrent ? 'bg-amber-500/10 border-amber-500/60' : 'bg-[#13161C] border-white/[0.08] hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <FileAudio className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-white truncate">{proj.title}</h3>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-400">
                    <span>{proj.fileFormat}</span>
                    <span aria-hidden="true">·</span>
                    <span>{Math.round(proj.bpm)} BPM</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatKeySignature(proj.keyRootPc, proj.keyMode)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section aria-label="Built-in demo songs">
        <div className="mb-3">
          <h2 className="font-display text-base font-bold text-white">Studio Demo Sessions</h2>
          <p className="text-xs text-slate-400 mt-0.5">Synthesized multi-stem demos for trying the mixer, MIDI, tabs and sheet music.</p>
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
                  isCurrent ? 'bg-amber-500/10 border-amber-500/60' : 'bg-[#13161C] border-white/[0.08] hover:border-white/25 hover:bg-[#171B22]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Music className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
                    <h3 className="text-sm font-semibold text-white truncate">{demo.title}</h3>
                  </div>
                  {isCurrent && <span className="text-[11px] font-mono text-amber-400 shrink-0">Loaded</span>}
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {demo.artist} · {demo.genre}
                </p>
                <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-wrap items-center gap-x-2 text-xs font-mono tabular-nums text-slate-400">
                  <span>{demo.bpm} BPM</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatKeySignature(demo.keyRootPc, demo.keyMode)}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
