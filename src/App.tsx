import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import type {
  QuantizeGrid,
  SeparationProgress,
  SongProject,
  StemId,
  StemMixerState,
  WorkspaceView,
} from './types/music';
import { MultiStemAudioEngine } from './audio/audioEngine';
import { DEMO_SONG_LIST, buildDemoSongProject, type DemoSongBlueprint } from './audio/demoSongs';
import { FILE_INPUT_ACCEPT, processUploadedAudioFile } from './audio/stemSeparator';
import {
  loadSavedGpuConfig,
  saveGpuConfig,
  type GpuHealthStatus,
  type GpuServerConfig,
} from './audio/gpuClient';
import { quantizeDrumHits, quantizeMidiNotes } from './audio/midiEncoder';
import { Header } from './components/Header';
import { TransportBar } from './components/TransportBar';
import { MixerView } from './components/MixerView';
import { MidiStudioView } from './components/MidiStudioView';
import { NotationView } from './components/NotationView';
import { LibraryView } from './components/LibraryView';

function createDefaultMixer(): Record<StemId, StemMixerState> {
  return {
    vocals: { volume: 1, muted: false, solo: false, pan: 0 },
    guitar: { volume: 1, muted: false, solo: false, pan: -0.15 },
    bass: { volume: 1, muted: false, solo: false, pan: 0 },
    drums: { volume: 1, muted: false, solo: false, pan: 0 },
    keyboards: { volume: 1, muted: false, solo: false, pan: 0.15 },
  };
}

export default function App() {
  const engineRef = useRef<MultiStemAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new MultiStemAudioEngine();
  }

  const globalFileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeView, setActiveView] = useState<WorkspaceView>('mixer');
  const [project, setProject] = useState<SongProject | null>(null);
  const [uploadedProjects, setUploadedProjects] = useState<SongProject[]>([]);
  const [mixer, setMixer] = useState<Record<StemId, StemMixerState>>(createDefaultMixer);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [transpose, setTranspose] = useState(0);

  // MIDI Studio settings shared with engine for live MIDI synth preview
  const [quantize, setQuantize] = useState<QuantizeGrid>('1/16');
  const [minVelocity, setMinVelocity] = useState(40);
  const [midiPreviewMode, setMidiPreviewMode] = useState<'off' | 'keyboards' | 'drums' | 'combined'>('off');

  // Upload, Separation & Local GPU Engine state
  const [processing, setProcessing] = useState<SeparationProgress | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);
  const [gpuConfig, setGpuConfig] = useState<GpuServerConfig>(() => loadSavedGpuConfig());
  const [gpuHealth, setGpuHealth] = useState<GpuHealthStatus | null>(null);

  const handleChangeGpuConfig = useCallback((next: GpuServerConfig) => {
    setGpuConfig(next);
    saveGpuConfig(next);
  }, []);

  const quantizedKeys = useMemo(
    () => (project ? quantizeMidiNotes(project.keyboardMidi, quantize, minVelocity) : []),
    [project, quantize, minVelocity]
  );

  const quantizedDrums = useMemo(
    () => (project ? quantizeDrumHits(project.drumHits, quantize, minVelocity) : []),
    [project, quantize, minVelocity]
  );

  // Initialize first built-in studio demo synchronously on mount
  useEffect(() => {
    const engine = engineRef.current!;
    const ctx = engine.ensureContext();
    const initial = buildDemoSongProject(DEMO_SONG_LIST[0], ctx);
    const freshMixer = createDefaultMixer();
    setProject(initial);
    setMixer(freshMixer);
    engine.loadProject(initial, freshMixer, initial.keyboardMidi, initial.drumHits);

    return () => {
      engine.dispose();
    };
  }, []);

  // Keep MIDI synth preview data synced when quantize / velocity changes
  useEffect(() => {
    engineRef.current?.updateMidiData(quantizedKeys, quantizedDrums);
  }, [quantizedKeys, quantizedDrums]);

  // Smooth playhead updater (throttled ~20fps when playing so React stays fast & responsive)
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastUpdate = 0;

    const tick = (now: number) => {
      const engine = engineRef.current;
      if (engine) {
        if (now - lastUpdate >= 45) {
          const t = engine.getCurrentTime();
          setCurrentTime(t);
          lastUpdate = now;

          if (!loopEnabled && project && t >= project.duration - 0.03) {
            engine.stop();
            setIsPlaying(false);
            setCurrentTime(0);
            return;
          }
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, loopEnabled, project]);

  const loadSongIntoEngine = useCallback((nextProject: SongProject) => {
    const engine = engineRef.current!;
    const freshMixer = createDefaultMixer();
    setProject(nextProject);
    setMixer(freshMixer);
    setIsPlaying(false);
    setCurrentTime(0);
    setTranspose(0);
    setPlaybackRate(1.0);
    setMidiPreviewMode('off');
    engine.setPlaybackRate(1.0);
    engine.setTranspose(0);
    engine.setMidiPreviewMode('off');
    engine.loadProject(nextProject, freshMixer, nextProject.keyboardMidi, nextProject.drumHits);
  }, []);

  const handleTogglePlay = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !project) return;
    if (engine.getIsPlaying()) {
      engine.pause();
      setIsPlaying(false);
    } else {
      await engine.play();
      setIsPlaying(true);
    }
  }, [project]);

  const handleStop = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.stop();
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  const handleSeek = useCallback((timeSec: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.seek(timeSec);
    setCurrentTime(timeSec);
  }, []);

  const handleUpdateStem = useCallback((id: StemId, patch: Partial<StemMixerState>) => {
    setMixer((prev) => {
      const next: Record<StemId, StemMixerState> = {
        ...prev,
        [id]: { ...prev[id], ...patch },
      };
      engineRef.current?.setMixerState(next);
      return next;
    });
  }, []);

  const handleApplyPreset = useCallback(
    (preset: 'all' | 'instrumental' | 'vocalsOnly' | 'rhythm') => {
      setMixer((prev) => {
        const next: Record<StemId, StemMixerState> = {
          vocals: { ...prev.vocals, muted: false, solo: false },
          guitar: { ...prev.guitar, muted: false, solo: false },
          bass: { ...prev.bass, muted: false, solo: false },
          drums: { ...prev.drums, muted: false, solo: false },
          keyboards: { ...prev.keyboards, muted: false, solo: false },
        };

        if (preset === 'instrumental') {
          next.vocals.muted = true;
        } else if (preset === 'vocalsOnly') {
          next.vocals.solo = true;
        } else if (preset === 'rhythm') {
          next.vocals.muted = true;
          next.guitar.muted = true;
          next.keyboards.muted = true;
        }

        engineRef.current?.setMixerState(next);
        return next;
      });
    },
    []
  );

  const handleSelectDemo = useCallback(
    (blueprint: DemoSongBlueprint) => {
      const engine = engineRef.current!;
      const ctx = engine.ensureContext();
      const built = buildDemoSongProject(blueprint, ctx);
      loadSongIntoEngine(built);
      setActiveView('mixer');
    },
    [loadSongIntoEngine]
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      setUploadError(null);
      setActiveView('library');
      setProcessing({ stage: 'Preparing audio decoder', percent: 5 });

      try {
        const engine = engineRef.current!;
        const ctx = engine.ensureContext();
        const separated = await processUploadedAudioFile(
          file,
          ctx,
          (progress) => {
            setProcessing(progress);
          },
          gpuConfig
        );
        setUploadedProjects((prev) => [separated, ...prev]);
        loadSongIntoEngine(separated);
        setProcessing(null);
        setActiveView('mixer');
      } catch (err) {
        setProcessing(null);
        setUploadError(err instanceof Error ? err.message : 'Failed to process uploaded audio.');
      }
    },
    [loadSongIntoEngine, gpuConfig]
  );

  // Studio keyboard shortcuts: Space = Play/Pause, 1-5 = Mute Stems, L = Loop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        void handleTogglePlay();
      } else if (e.key === 'l' || e.key === 'L') {
        setLoopEnabled((prev) => {
          const next = !prev;
          engineRef.current?.setLoop(next);
          return next;
        });
      } else if (e.key >= '1' && e.key <= '5') {
        const order: StemId[] = ['vocals', 'guitar', 'bass', 'drums', 'keyboards'];
        const stemId = order[Number(e.key) - 1];
        if (stemId) {
          setMixer((prev) => {
            const next = {
              ...prev,
              [stemId]: { ...prev[stemId], muted: !prev[stemId].muted },
            };
            engineRef.current?.setMixerState(next);
            return next;
          });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay]);

  return (
    <div
      className="min-h-screen bg-[#0B0D10] text-[#F3F4F6] flex flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setIsWindowDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setIsWindowDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsWindowDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) {
          void handleUploadFile(file);
        }
      }}
    >
      {/* Hidden global file input triggered by Header Import Audio CTA */}
      <input
        ref={globalFileInputRef}
        type="file"
        accept={FILE_INPUT_ACCEPT}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUploadFile(file);
          e.target.value = '';
        }}
        className="sr-only"
        aria-label="Import audio file from header"
      />

      <Header
        activeView={activeView}
        onSelectView={setActiveView}
        onImportClick={() => globalFileInputRef.current?.click()}
      />

      {project && (
        <TransportBar
          project={project}
          isPlaying={isPlaying}
          currentTime={currentTime}
          loopEnabled={loopEnabled}
          metronomeEnabled={metronomeEnabled}
          playbackRate={playbackRate}
          transpose={transpose}
          onTogglePlay={() => void handleTogglePlay()}
          onStop={handleStop}
          onSeek={handleSeek}
          onToggleLoop={() => {
            const next = !loopEnabled;
            setLoopEnabled(next);
            engineRef.current?.setLoop(next);
          }}
          onToggleMetronome={() => {
            const next = !metronomeEnabled;
            setMetronomeEnabled(next);
            engineRef.current?.setMetronome(next);
          }}
          onChangeRate={(rate) => {
            setPlaybackRate(rate);
            engineRef.current?.setPlaybackRate(rate);
          }}
          onChangeTranspose={(semitones) => {
            setTranspose(semitones);
            engineRef.current?.setTranspose(semitones);
          }}
        />
      )}

      <main className="flex-1">
        {!project ? (
          <div className="max-w-[1440px] mx-auto px-6 py-16 text-center text-sm text-slate-400">
            Initializing studio audio engine…
          </div>
        ) : activeView === 'mixer' ? (
          <MixerView
            project={project}
            mixer={mixer}
            currentTime={currentTime}
            onUpdateStem={handleUpdateStem}
            onApplyPreset={handleApplyPreset}
            onSeek={handleSeek}
            onOpenMidi={() => setActiveView('midi')}
            onOpenNotation={() => setActiveView('notation')}
          />
        ) : activeView === 'midi' ? (
          <MidiStudioView
            project={project}
            currentTime={currentTime}
            transpose={transpose}
            quantize={quantize}
            minVelocity={minVelocity}
            midiPreviewMode={midiPreviewMode}
            onChangeQuantize={setQuantize}
            onChangeMinVelocity={setMinVelocity}
            onChangeMidiPreviewMode={(mode) => {
              setMidiPreviewMode(mode);
              engineRef.current?.setMidiPreviewMode(mode);
            }}
            onSeek={handleSeek}
            onPreviewNote={(midi, dur, isDrum) =>
              engineRef.current?.triggerPreviewNote(midi, dur, isDrum)
            }
          />
        ) : activeView === 'notation' ? (
          <NotationView
            project={project}
            currentTime={currentTime}
            transpose={transpose}
            onSeek={handleSeek}
            onPreviewNote={(midi, dur) => engineRef.current?.triggerPreviewNote(midi, dur, false)}
            onPreviewChord={(midis) => engineRef.current?.triggerChordPreview(midis)}
          />
        ) : (
          <LibraryView
            currentProject={project}
            uploadedProjects={uploadedProjects}
            processing={processing}
            error={uploadError}
            gpuConfig={gpuConfig}
            gpuHealth={gpuHealth}
            onChangeGpuConfig={handleChangeGpuConfig}
            onUpdateGpuHealth={setGpuHealth}
            onSelectDemo={handleSelectDemo}
            onSelectUploaded={(proj) => {
              loadSongIntoEngine(proj);
              setActiveView('mixer');
            }}
            onUploadFile={(file) => void handleUploadFile(file)}
            onDismissError={() => setUploadError(null)}
          />
        )}
      </main>

      {/* Drag-and-drop full-window overlay */}
      {isWindowDragging && (
        <div className="fixed inset-0 z-50 bg-[#0B0D10]/90 backdrop-blur-sm flex items-center justify-center p-6 pointer-events-none">
          <div className="max-w-md w-full border-2 border-dashed border-amber-500 rounded-xl p-10 text-center bg-[#13161C]">
            <Upload className="w-8 h-8 text-amber-400 mx-auto mb-3" aria-hidden="true" />
            <p className="font-display text-lg font-bold text-white">Drop audio or video to separate stems</p>
            <p className="text-xs font-mono text-slate-400 mt-1">
              MP3 · WAV · FLAC · OGG · M4A · AAC · MP4 · MOV · MKV
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
