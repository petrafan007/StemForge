import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import type {
  BassTuningId,
  GuitarTuningId,
  NotationPart,
  QuantizeGrid,
  SeparationProgress,
  SongProject,
  StemId,
  StemMixerState,
  WorkspaceView,
} from './types/music';
import { ALL_STEM_IDS, GUITAR_STEM_IDS, projectStemIds } from './types/music';
import { MultiStemAudioEngine } from './audio/audioEngine';
import { DEMO_SONG_LIST, buildDemoSongProject, type DemoSongBlueprint } from './audio/demoSongs';
import { FILE_INPUT_ACCEPT, processUploadedAudioFile } from './audio/stemSeparator';
import {
  cancelProject,
  checkGpuServerHealth,
  createProject,
  deleteProject,
  downloadSfg,
  fetchStem,
  getServerSettings,
  importSfg,
  listProjects,
  normalizeServerUrl,
  pickFolder,
  putServerSettings,
  reprocessProject,
  revealFolder,
  saveProjectState,
  saveProjectStateOnUnload,
  unloadGpuModel,
  waitForProject,
  type GpuHealthStatus,
  type ProjectDocument,
  type ProjectState,
  type ProjectSummary,
} from './audio/serverApi';
import { applySongOverrides, buildProjectFromDocument, loadServerProject, type SongOverrides } from './audio/projectModel';
import { detectKey } from './audio/musicAnalysis';
import { resolveTunings } from './audio/scoreExport';
import { applyTabEdits, parseTabEdits, type PartEdit, type TabEdits } from './audio/tabEdits';
import { DEFAULT_BAR_SETTINGS, parseBarSettings, type BarSettings } from './audio/bars';
import { quantizeDrumHits, quantizeMidiNotes } from './audio/midiEncoder';
import { loadLocalSettings, mergeSettings, processingPayload, saveLocalSettings, type AppSettings, type ChordTranscriberId, type SeparatorId } from './settings/appSettings';
import { SFG_TYPES, openFile, saveFileAs, writeToHandle, type FileHandleLike } from './utils/fileSystem';
import { Header, type SaveStatus } from './components/Header';
import { TransportBar } from './components/TransportBar';
import { MixerView, type MixPreset } from './components/MixerView';
import { MidiStudioView } from './components/MidiStudioView';
import { NotationView } from './components/NotationView';
import { LibraryView } from './components/LibraryView';
import { SettingsView } from './components/SettingsView';
import { ExportDialog, type ExportTab } from './components/ExportDialog';

const LAST_PROJECT_KEY = 'stemforge_last_project_v1';

function createDefaultMixer(): Record<StemId, StemMixerState> {
  return {
    vocals: { volume: 1, muted: false, solo: false, pan: 0 },
    guitar: { volume: 1, muted: false, solo: false, pan: -0.15 },
    guitar1: { volume: 1, muted: false, solo: false, pan: 0 },
    guitar2: { volume: 1, muted: false, solo: false, pan: 0 },
    lead: { volume: 1, muted: false, solo: false, pan: 0.1 },
    bass: { volume: 1, muted: false, solo: false, pan: 0 },
    drums: { volume: 1, muted: false, solo: false, pan: 0 },
    keyboards: { volume: 1, muted: false, solo: false, pan: 0.15 },
  };
}

function mixerFromState(saved: ProjectState['mixer']): Record<StemId, StemMixerState> {
  const base = createDefaultMixer();
  if (!saved) return base;
  for (const id of ALL_STEM_IDS) {
    const s = saved[id];
    if (s && typeof s.volume === 'number') base[id] = { volume: s.volume, muted: Boolean(s.muted), solo: Boolean(s.solo), pan: Number(s.pan) || 0 };
  }
  // a song re-analyzed into two guitar tracks keeps the old guitar track's level, mute and solo
  const g = saved.guitar;
  if (g && typeof g.volume === 'number') {
    for (const id of ['guitar1', 'guitar2'] as const) {
      if (!saved[id]) base[id] = { volume: g.volume, muted: Boolean(g.muted), solo: Boolean(g.solo), pan: 0 };
    }
  }
  return base;
}

function overridesFromState(state: ProjectState | undefined): SongOverrides {
  if (!state) return {};
  const o: SongOverrides = {};
  if (typeof state.bpm === 'number') o.bpm = state.bpm;
  if (typeof state.beatOffsetSec === 'number') o.beatOffsetSec = state.beatOffsetSec;
  if (Array.isArray(state.timeSignature)) o.timeSignature = state.timeSignature;
  if (state.key) o.key = state.key;
  if (typeof state.simplifyPowerChords === 'boolean') o.simplifyPowerChords = state.simplifyPowerChords;
  return o;
}

export default function App() {
  const engineRef = useRef<MultiStemAudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new MultiStemAudioEngine();
  const globalFileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------------------------------------------------------------- settings
  const [settings, setSettingsState] = useState<AppSettings>(() => loadLocalSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const serverUrl = normalizeServerUrl(settings.engine.serverUrl);
  const gpuMode = settings.engine.mode === 'gpu';
  const serverSettingsTimer = useRef<number | null>(null);

  // ---------------------------------------------------------------- project & transport
  const [activeView, setActiveView] = useState<WorkspaceView>('mixer');
  const [project, setProject] = useState<SongProject | null>(null);
  const baseProjectRef = useRef<SongProject | null>(null); // as analysed (no user overrides)
  const [doc, setDoc] = useState<ProjectDocument | null>(null);
  const [overrides, setOverrides] = useState<SongOverrides>({});
  const [uploadedProjects, setUploadedProjects] = useState<SongProject[]>([]);
  const [mixer, setMixer] = useState<Record<StemId, StemMixerState>>(createDefaultMixer);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [loopEnabled, setLoopEnabled] = useState(true);
  const [metronomeEnabled, setMetronomeEnabled] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [transpose, setTranspose] = useState(0);
  const [transposePending, setTransposePending] = useState(false);
  const transposeRequest = useRef(0);
  const transposedCache = useRef(new Map<string, Partial<Record<StemId, AudioBuffer>>>());

  const [guitarTuning, setGuitarTuning] = useState<GuitarTuningId | 'auto'>(settings.notation.guitarTuning);
  const [bassTuning, setBassTuning] = useState<BassTuningId | 'auto'>(settings.notation.bassTuning);
  const [notationPart, setNotationPart] = useState<NotationPart>('guitar');
  const [tabEdits, setTabEdits] = useState<TabEdits>({});
  const [barSettings, setBarSettings] = useState<BarSettings>(DEFAULT_BAR_SETTINGS);
  const [quantize, setQuantize] = useState<QuantizeGrid>(settings.midi.quantize);
  const [minVelocity, setMinVelocity] = useState(settings.midi.minVelocity);
  const [midiPreviewMode, setMidiPreviewMode] = useState<'off' | 'keyboards' | 'drums' | 'combined'>('off');

  // ---------------------------------------------------------------- engine / library / status
  const [health, setHealth] = useState<GpuHealthStatus | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsDir, setProjectsDir] = useState<string | null>(null);
  const [defaultProjectsDir, setDefaultProjectsDir] = useState<string | null>(null);
  const [processing, setProcessing] = useState<(SeparationProgress & { projectId?: string }) | null>(null);
  const [reanalyzing, setReanalyzing] = useState<{ stage: string; percent: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('none');
  const [saveMessage, setSaveMessage] = useState<string | undefined>(undefined);
  const lastSavedJson = useRef<string>('');
  const sfgHandles = useRef(new Map<string, FileHandleLike>());
  const [exportState, setExportState] = useState<{ tab: ExportTab; tracks?: StemId[] } | null>(null);
  const [isWindowDragging, setIsWindowDragging] = useState(false);

  const showToast = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), kind === 'error' ? 8000 : 4500);
  }, []);

  const changeSettings = useCallback((next: AppSettings) => {
    setSettingsState(next);
    saveLocalSettings(next);
    if (serverSettingsTimer.current) window.clearTimeout(serverSettingsTimer.current);
    serverSettingsTimer.current = window.setTimeout(() => {
      putServerSettings(normalizeServerUrl(next.engine.serverUrl), next)
        .then((r) => setProjectsDir(r.projectsDir))
        .catch(() => {
          /* engine offline: settings stay in the browser */
        });
    }, 600);
  }, []);

  // ---------------------------------------------------------------- derived data
  const quantizedKeys = useMemo(() => (project ? quantizeMidiNotes(project.keyboardMidi, quantize, minVelocity) : []), [project, quantize, minVelocity]);
  const quantizedDrums = useMemo(() => (project ? quantizeDrumHits(project.drumHits, quantize, minVelocity) : []), [project, quantize, minVelocity]);
  const tuningOptions = useMemo(
    () => ({ allowExtendedRangeGuitar: settings.notation.allowExtendedRangeGuitar, allowFiveStringBass: settings.notation.allowFiveStringBass }),
    [settings.notation.allowExtendedRangeGuitar, settings.notation.allowFiveStringBass]
  );
  const resolvedTunings = useMemo(
    () => (project ? resolveTunings(project, { guitar: guitarTuning, bass: bassTuning }, tuningOptions, transpose) : null),
    [project, guitarTuning, bassTuning, tuningOptions, transpose]
  );
  const detectedKey = useMemo(() => {
    const base = baseProjectRef.current;
    if (!base) return null;
    return detectKey([base.guitarNotes, base.leadNotes, base.keyboardMidi, base.bassNotes, base.vocalNotes]) ?? { rootPc: base.keyRootPc, mode: base.keyMode };
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engineRef.current?.updateMidiData(quantizedKeys, quantizedDrums);
  }, [quantizedKeys, quantizedDrums]);

  // ---------------------------------------------------------------- engine load helpers
  const loadSongIntoEngine = useCallback(
    (nextProject: SongProject, nextMixer: Record<StemId, StemMixerState> = createDefaultMixer()) => {
      const engine = engineRef.current!;
      setProject(nextProject);
      setMixer(nextMixer);
      setIsPlaying(false);
      setCurrentTime(0);
      setTranspose(0);
      setTransposePending(false);
      transposeRequest.current += 1;
      setPlaybackRate(1.0);
      setMidiPreviewMode('off');
      engine.loadProject(nextProject, nextMixer, nextProject.keyboardMidi, nextProject.drumHits);
      engine.setPlaybackRate(1.0);
      engine.setTranspose(0);
      engine.setMidiPreviewMode('off');
      engine.setLoop(loopEnabled);
      engine.setMetronome(metronomeEnabled);
    },
    [loopEnabled, metronomeEnabled]
  );

  const loadTemporarySong = useCallback(
    (p: SongProject) => {
      baseProjectRef.current = p;
      setDoc(null);
      setOverrides({});
      setTabEdits({});
      setBarSettings(DEFAULT_BAR_SETTINGS);
      setSaveStatus(p.sourceType === 'demo' ? 'none' : 'not-saved');
      setSaveMessage(p.sourceType === 'demo' ? undefined : 'Browser imports are not saved. Re-import with the Local GPU engine to keep this song.');
      setGuitarTuning(settingsRef.current.notation.guitarTuning);
      setBassTuning(settingsRef.current.notation.bassTuning);
      lastSavedJson.current = '';
      loadSongIntoEngine(p);
    },
    [loadSongIntoEngine]
  );

  // ---------------------------------------------------------------- key change (pitch-shift)
  const applyTranspose = useCallback(
    async (semitones: number, target: SongProject | null = project) => {
      const engine = engineRef.current!;
      setTranspose(semitones);
      engine.setTranspose(semitones);
      if (!target?.serverProjectId) return;
      const req = ++transposeRequest.current;
      if (semitones === 0) {
        engine.setBufferOverrides({});
        setTransposePending(false);
        return;
      }
      const key = `${target.serverProjectId}:${semitones}`;
      const cached = transposedCache.current.get(key);
      if (cached) {
        engine.setBufferOverrides(cached);
        setTransposePending(false);
        return;
      }
      setTransposePending(true);
      try {
        const ctx = engine.ensureContext();
        const ids = projectStemIds(target).filter((id) => id !== 'drums');
        const decoded = await Promise.all(
          ids.map(async (id) => [id, await ctx.decodeAudioData(await fetchStem(serverUrl, target.serverProjectId!, id, fetch, semitones))] as const)
        );
        const map = Object.fromEntries(decoded) as Partial<Record<StemId, AudioBuffer>>;
        transposedCache.current.set(key, map);
        if (req === transposeRequest.current) engine.setBufferOverrides(map);
      } catch (err) {
        if (req === transposeRequest.current) {
          showToast('error', err instanceof Error ? err.message : 'Key change failed.');
          setTranspose(0);
          engine.setTranspose(0);
          engine.setBufferOverrides({});
        }
      } finally {
        if (req === transposeRequest.current) setTransposePending(false);
      }
    },
    [project, serverUrl, showToast]
  );

  // ---------------------------------------------------------------- server: health, settings, projects
  const refreshProjects = useCallback(async () => {
    try {
      const r = await listProjects(serverUrl);
      setProjects(r.projects);
      setProjectsDir(r.projectsDir);
    } catch {
      setProjects(null);
    }
  }, [serverUrl]);

  const testEngine = useCallback(async (): Promise<GpuHealthStatus | null> => {
    try {
      const h = await checkGpuServerHealth(serverUrl);
      setHealth(h);
      setHealthError(null);
      if (h.projectsDir) setProjectsDir(h.projectsDir);
      return h;
    } catch (err) {
      setHealth(null);
      setHealthError(err instanceof Error ? err.message : 'GPU engine not reachable.');
      return null;
    }
  }, [serverUrl]);

  const openServerProject = useCallback(
    async (id: string, opts: { switchView?: boolean } = {}) => {
      const engine = engineRef.current!;
      setBusyMessage('Opening project…');
      try {
        const ctx = engine.ensureContext();
        const simplify = settingsRef.current.transcription.simplifyPowerChords;
        const { doc: d, project: loaded } = await loadServerProject(serverUrl, id, ctx, { simplifyPowerChords: simplify }, (stage, pct) =>
          setBusyMessage(`${stage} (${Math.round(pct)}%)`)
        );
        const state = d.state ?? {};
        const bufferMap = Object.fromEntries(projectStemIds(loaded).map((sid) => [sid, loaded.stems[sid]!.buffer])) as Partial<Record<StemId, AudioBuffer>>;
        const base = buildProjectFromDocument({ ...d, state: {} }, bufferMap, { simplifyPowerChords: simplify });
        baseProjectRef.current = base;
        const ov = overridesFromState(state);
        const current = Object.keys(ov).length ? applySongOverrides(base, ov, simplify) : base;
        setDoc(d);
        setOverrides(ov);
        setGuitarTuning((state.guitarTuning as GuitarTuningId | 'auto') ?? settingsRef.current.notation.guitarTuning);
        setBassTuning((state.bassTuning as BassTuningId | 'auto') ?? settingsRef.current.notation.bassTuning);
        if (['guitar', 'guitar1', 'guitar2', 'lead', 'bass'].includes(state.notationPart ?? '')) setNotationPart(state.notationPart as NotationPart);
        setTabEdits(parseTabEdits(state.tabEdits));
        setBarSettings(parseBarSettings(state.barLines));
        if (state.quantize) setQuantize(state.quantize as QuantizeGrid);
        if (typeof state.minVelocity === 'number') setMinVelocity(state.minVelocity);
        const loop = state.loop ?? loopEnabled;
        const metro = state.metronome ?? false;
        loadSongIntoEngine(current, mixerFromState(state.mixer));
        setLoopEnabled(loop);
        engine.setLoop(loop);
        setMetronomeEnabled(metro);
        engine.setMetronome(metro);
        if (state.playbackRate && state.playbackRate !== 1) {
          setPlaybackRate(state.playbackRate);
          engine.setPlaybackRate(state.playbackRate);
        }
        lastSavedJson.current = '';
        setSaveStatus('saved');
        setSaveMessage(undefined);
        try {
          window.localStorage.setItem(LAST_PROJECT_KEY, id);
        } catch {
          // ignore
        }
        if (state.transpose) void applyTranspose(state.transpose, current);
        if (opts.switchView !== false) setActiveView('mixer');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not open the project.');
      } finally {
        setBusyMessage(null);
      }
    },
    [serverUrl, loadSongIntoEngine, applyTranspose, showToast, loopEnabled]
  );

  // Startup: demo first (instant), then connect to the engine, sync settings and reopen the last song.
  useEffect(() => {
    const engine = engineRef.current!;
    const ctx = engine.ensureContext();
    loadTemporarySong(buildDemoSongProject(DEMO_SONG_LIST[0], ctx));

    let cancelled = false;
    (async () => {
      if (settingsRef.current.engine.mode !== 'gpu') return;
      const h = await testEngine();
      if (!h || cancelled) return;
      try {
        const s = await getServerSettings(serverUrl);
        setDefaultProjectsDir(s.defaultProjectsDir);
        setProjectsDir(s.projectsDir);
        if (s.settings && Object.keys(s.settings).length) {
          const merged = mergeSettings(settingsRef.current, s.settings);
          setSettingsState(merged);
          saveLocalSettings(merged);
        } else {
          void putServerSettings(serverUrl, settingsRef.current);
        }
      } catch {
        // ignore
      }
      await refreshProjects();
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get('open');
      let last: string | null = null;
      try {
        last = window.localStorage.getItem(LAST_PROJECT_KEY);
      } catch {
        // ignore
      }
      const target = fromUrl || (settingsRef.current.projects.reopenLastProject ? last : null);
      if (target && !cancelled) {
        if (fromUrl) window.history.replaceState(null, '', window.location.pathname);
        await openServerProject(target);
      }
    })();
    return () => {
      cancelled = true;
      engine.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- autosave
  const stateSnapshot: ProjectState = useMemo(
    () => ({
      ...(overrides.bpm !== undefined ? { bpm: overrides.bpm } : {}),
      ...(overrides.beatOffsetSec !== undefined ? { beatOffsetSec: overrides.beatOffsetSec } : {}),
      ...(overrides.timeSignature ? { timeSignature: overrides.timeSignature } : {}),
      ...(overrides.key ? { key: overrides.key } : {}),
      ...(overrides.simplifyPowerChords !== undefined ? { simplifyPowerChords: overrides.simplifyPowerChords } : {}),
      mixer,
      transpose,
      playbackRate,
      loop: loopEnabled,
      metronome: metronomeEnabled,
      guitarTuning,
      bassTuning,
      quantize,
      minVelocity,
      notationPart,
      ...(Object.keys(tabEdits).length ? { tabEdits } : {}),
      barLines: barSettings,
    }),
    [overrides, mixer, transpose, playbackRate, loopEnabled, metronomeEnabled, guitarTuning, bassTuning, quantize, minVelocity, notationPart, tabEdits, barSettings]
  );
  const snapshotRef = useRef(stateSnapshot);
  snapshotRef.current = stateSnapshot;

  // tab corrections replace the automatic notes of their parts in tabs, sheet music, MIDI and exports
  // the song with its bar lines (beat tracker + the user's bar line edits) ...
  const songProject = useMemo(() => (project ? { ...project, barSettings } : null), [project, barSettings]);
  useEffect(() => {
    if (songProject) engineRef.current?.updateProject(songProject); // metronome accents follow the bars
  }, [songProject]);
  // ... and with the tab corrections replacing their parts' notes
  const editedProject = useMemo(() => (songProject ? applyTabEdits(songProject, tabEdits) : null), [songProject, tabEdits]);
  const handleTabEdit = useCallback((part: NotationPart, edit: PartEdit | undefined) => {
    setTabEdits((prev) => {
      const next = { ...prev };
      if (edit) next[part] = edit;
      else delete next[part];
      return next;
    });
  }, []);

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (!doc) return false;
    const json = JSON.stringify(snapshotRef.current);
    if (json === lastSavedJson.current) return true;
    setSaveStatus('saving');
    try {
      await saveProjectState(serverUrl, doc.id, snapshotRef.current);
      lastSavedJson.current = json;
      setSaveStatus('saved');
      setSaveMessage(undefined);
      return true;
    } catch (err) {
      setSaveStatus('error');
      setSaveMessage(err instanceof Error ? err.message : 'Could not save.');
      return false;
    }
  }, [doc, serverUrl]);

  useEffect(() => {
    if (!doc) return;
    const json = JSON.stringify(stateSnapshot);
    if (!lastSavedJson.current) {
      lastSavedJson.current = json; // first snapshot after opening = what's on disk
      return;
    }
    if (json === lastSavedJson.current) {
      setSaveStatus((st) => (st === 'pending' ? 'saved' : st)); // changed back to what's saved
      return;
    }
    setSaveStatus('pending');
    if (!settings.projects.autosave) return;
    const t = window.setTimeout(() => void flushSave(), 1200);
    return () => window.clearTimeout(t);
  }, [stateSnapshot, doc, settings.projects.autosave, flushSave]);

  useEffect(() => {
    const onUnload = () => {
      if (doc && JSON.stringify(snapshotRef.current) !== lastSavedJson.current) {
        saveProjectStateOnUnload(serverUrl, doc.id, snapshotRef.current);
      }
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [doc, serverUrl]);

  // ---------------------------------------------------------------- playhead
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      const engine = engineRef.current;
      if (engine && now - lastUpdate >= 30) {
        // what is being heard now (output latency compensated) minus the user's extra delay
        const t = Math.max(0, engine.getAudibleTime() - settingsRef.current.playback.avSyncMs / 1000);
        setCurrentTime(t);
        lastUpdate = now;
        if (!loopEnabled && project && t >= project.duration - 0.03) {
          engine.stop();
          setIsPlaying(false);
          setCurrentTime(0);
          return;
        }
      }
      rafId = window.requestAnimationFrame(tick);
    };
    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [isPlaying, loopEnabled, project]);

  // ---------------------------------------------------------------- transport handlers
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
    engineRef.current?.stop();
    setIsPlaying(false);
    setCurrentTime(0);
  }, []);

  const handleSeek = useCallback((timeSec: number) => {
    engineRef.current?.seek(timeSec);
    setCurrentTime(timeSec);
  }, []);

  const handleUpdateStem = useCallback((id: StemId, patch: Partial<StemMixerState>) => {
    setMixer((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...patch } };
      engineRef.current?.setMixerState(next);
      return next;
    });
  }, []);

  const handleApplyPreset = useCallback((preset: MixPreset) => {
    setMixer((prev) => {
      const next = { ...prev };
      for (const id of ALL_STEM_IDS) next[id] = { ...prev[id], muted: false, solo: false };
      if (preset === 'instrumental') next.vocals.muted = true;
      else if (preset === 'vocalsOnly') next.vocals.solo = true;
      else if (preset === 'rhythm') {
        for (const id of ALL_STEM_IDS) if (id !== 'bass' && id !== 'drums') next[id].muted = true;
      } else if (preset === 'guitars') {
        for (const id of ALL_STEM_IDS) if (!GUITAR_STEM_IDS.includes(id)) next[id].muted = true;
      }
      engineRef.current?.setMixerState(next);
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- song overrides (tempo, grid, key...)
  const applyOverrides = useCallback(
    (next: SongOverrides) => {
      const base = baseProjectRef.current;
      if (!base || !project) return;
      setOverrides(next);
      let updated = applySongOverrides(base, next, settingsRef.current.transcription.simplifyPowerChords);
      if (!next.key && !base.raw && detectedKey) updated = { ...updated, keyRootPc: detectedKey.rootPc, keyMode: detectedKey.mode };
      updated = { ...updated, id: project.id };
      setProject(updated);
      engineRef.current?.updateProject(updated);
    },
    [project, detectedKey]
  );

  // ---------------------------------------------------------------- import / open / save
  const handleUploadFile = useCallback(
    async (file: File) => {
      setUploadError(null);
      setActiveView('library');
      const s = settingsRef.current;
      if (s.engine.mode === 'gpu') {
        const h = health ?? (await testEngine());
        if (!h?.supportsProjects) {
          setUploadError(
            'The Local GPU engine is not running, so the song cannot be separated on your GPU. Start StemForge from the desktop shortcut, or switch to the Browser engine in Settings.'
          );
          return;
        }
        setProcessing({ stage: 'Uploading', percent: 1 });
        try {
          const created = await createProject(serverUrl, file, processingPayload(s));
          setProcessing({ stage: 'Queued', percent: 2, projectId: created.id });
          void refreshProjects();
          const final = await waitForProject(serverUrl, created.id, (st) =>
            setProcessing({ stage: st.stage ?? 'Processing', percent: st.percent, projectId: created.id })
          );
          setProcessing(null);
          void refreshProjects();
          if (final.status === 'ready') await openServerProject(created.id);
          else if (final.status === 'error') setUploadError(final.error || 'Processing failed.');
        } catch (err) {
          setProcessing(null);
          setUploadError(err instanceof Error ? err.message : 'Import failed.');
        }
        return;
      }
      // Browser STFT engine (not saved)
      setProcessing({ stage: 'Preparing audio decoder', percent: 5 });
      try {
        const ctx = engineRef.current!.ensureContext();
        const separated = await processUploadedAudioFile(file, ctx, (p) => setProcessing(p));
        setUploadedProjects((prev) => [separated, ...prev]);
        loadTemporarySong(separated);
        setProcessing(null);
        setActiveView('mixer');
      } catch (err) {
        setProcessing(null);
        setUploadError(err instanceof Error ? err.message : 'Failed to process the audio.');
      }
    },
    [health, testEngine, serverUrl, refreshProjects, openServerProject, loadTemporarySong]
  );

  const importSfgFile = useCallback(
    async (file: File) => {
      if (!(health ?? (await testEngine()))) {
        showToast('error', 'Opening .sfg projects needs the Local GPU engine. Start StemForge from the desktop shortcut.');
        return;
      }
      setBusyMessage(`Opening ${file.name}…`);
      try {
        const id = await importSfg(serverUrl, file, file.name);
        await refreshProjects();
        await openServerProject(id);
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not open the project file.');
      } finally {
        setBusyMessage(null);
      }
    },
    [health, testEngine, serverUrl, refreshProjects, openServerProject, showToast]
  );

  const handleOpenSfg = useCallback(async () => {
    const file = await openFile(SFG_TYPES, '.sfg', 'stemforge-sfg');
    if (file) await importSfgFile(file);
  }, [importSfgFile]);

  const handleSaveSfg = useCallback(
    async (projectId: string | undefined, saveAs: boolean) => {
      if (!projectId) {
        showToast('error', 'Only songs imported with the Local GPU engine can be saved as .sfg files (demos and browser imports are temporary).');
        return;
      }
      if (projectId === doc?.id) await flushSave();
      setBusyMessage('Packing project…');
      try {
        const { blob, fileName } = await downloadSfg(serverUrl, projectId, settingsRef.current.projects.includeOriginalInSfg);
        const existing = sfgHandles.current.get(projectId);
        if (existing && !saveAs) {
          await writeToHandle(existing, blob);
          showToast('ok', `Saved ${existing.name}`);
        } else {
          setBusyMessage(null);
          const saved = await saveFileAs(blob, fileName, SFG_TYPES, 'stemforge-sfg');
          if (saved?.handle) sfgHandles.current.set(projectId, saved.handle);
          if (saved) showToast('ok', `Saved ${saved.fileName} (${(blob.size / 1048576).toFixed(0)} MB)${saved.method === 'download' ? ' to Downloads' : ''}`);
        }
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not save the project.');
      } finally {
        setBusyMessage(null);
      }
    },
    [doc, flushSave, serverUrl, showToast]
  );

  const handleReanalyze = useCallback(
    async (mode: 'transcribe' | 'full', choice?: { separator?: SeparatorId; chordTranscriber?: ChordTranscriberId }) => {
      if (!doc) return;
      await flushSave();
      setReanalyzing({ stage: 'Starting', percent: 0 });
      try {
        const extra: Record<string, unknown> = { separate: mode === 'full' };
        if (choice?.separator) extra.separator = choice.separator;
        if (choice?.chordTranscriber) extra.chordTranscriber = choice.chordTranscriber;
        await reprocessProject(serverUrl, doc.id, processingPayload(settingsRef.current, extra));
        const final = await waitForProject(serverUrl, doc.id, (st) => setReanalyzing({ stage: st.stage ?? 'Processing', percent: st.percent }));
        if (final.status === 'ready') {
          transposedCache.current.clear();
          await openServerProject(doc.id, { switchView: false });
          showToast('ok', 'Song re-analyzed with the current settings.');
        } else if (final.status === 'error') {
          showToast('error', final.error || 'Re-analysis failed.');
        }
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Re-analysis failed.');
      } finally {
        setReanalyzing(null);
      }
    },
    [doc, flushSave, serverUrl, openServerProject, showToast]
  );

  const handleDeleteProject = useCallback(
    async (id: string) => {
      try {
        await deleteProject(serverUrl, id);
        showToast('ok', 'Moved to the .trash folder in your projects folder.');
        if (doc?.id === id) loadTemporarySong(buildDemoSongProject(DEMO_SONG_LIST[0], engineRef.current!.ensureContext()));
        await refreshProjects();
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not delete the project.');
      }
    },
    [serverUrl, doc, loadTemporarySong, refreshProjects, showToast]
  );

  const handleRename = useCallback(
    async (meta: { title?: string; artist?: string; album?: string }) => {
      if (!doc) return;
      try {
        const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
        await saveProjectState(serverUrl, doc.id, snapshotRef.current, clean);
        lastSavedJson.current = JSON.stringify(snapshotRef.current);
        const nextDoc = { ...doc, ...clean };
        setDoc(nextDoc);
        if (project) {
          const artistLine = [nextDoc.artist, nextDoc.album].filter(Boolean).join(' · ');
          setProject({ ...project, title: nextDoc.title, artist: artistLine || project.artist });
        }
        void refreshProjects();
        showToast('ok', 'Saved.');
      } catch (err) {
        showToast('error', err instanceof Error ? err.message : 'Could not rename.');
      }
    },
    [doc, project, serverUrl, refreshProjects, showToast]
  );

  const handlePickProjectsFolder = useCallback(async () => {
    try {
      const path = await pickFolder(serverUrl, projectsDir ?? undefined);
      if (!path) return;
      const next = { ...settingsRef.current, projects: { ...settingsRef.current.projects, folder: path } };
      setSettingsState(next);
      saveLocalSettings(next);
      const r = await putServerSettings(serverUrl, next);
      setProjectsDir(r.projectsDir);
      await refreshProjects();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not change the folder.');
    }
  }, [serverUrl, projectsDir, refreshProjects, showToast]);

  const handleReveal = useCallback(async () => {
    try {
      await revealFolder(serverUrl);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Could not open the folder.');
    }
  }, [serverUrl, showToast]);

  // ---------------------------------------------------------------- keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        void handleSaveSfg(project?.serverProjectId, e.shiftKey);
        return;
      }
      if (ctrl && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        void handleOpenSfg();
        return;
      }
      if (ctrl && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setExportState({ tab: 'audio' });
        return;
      }
      if (e.defaultPrevented) return; // handled by the tab editor
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if (exportState) return;
      if (e.code === 'Space') {
        e.preventDefault();
        void handleTogglePlay();
      } else if (e.key === 'l' || e.key === 'L') {
        setLoopEnabled((prev) => {
          engineRef.current?.setLoop(!prev);
          return !prev;
        });
      } else if (project && e.key >= '1' && e.key <= '9') {
        const stemId = projectStemIds(project)[Number(e.key) - 1];
        if (stemId) {
          setMixer((prev) => {
            const next = { ...prev, [stemId]: { ...prev[stemId], muted: !prev[stemId].muted } };
            engineRef.current?.setMixerState(next);
            return next;
          });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleTogglePlay, handleSaveSfg, handleOpenSfg, project, exportState]);

  // ---------------------------------------------------------------- render
  const songEditing =
    project && baseProjectRef.current && resolvedTunings
      ? {
          project,
          doc,
          overrides,
          detected: {
            bpm: baseProjectRef.current.bpm,
            beatOffsetSec: baseProjectRef.current.beatOffsetSec,
            key: detectedKey,
            candidates: doc?.analysis?.bpmCandidates ?? [],
          },
          guitarTuning,
          bassTuning,
          resolvedTunings,
          onChange: (patch: SongOverrides) => applyOverrides({ ...overrides, ...patch }),
          onReset: (field: keyof SongOverrides) => {
            const next = { ...overrides };
            delete next[field];
            applyOverrides(next);
          },
          onChangeGuitarTuning: setGuitarTuning,
          onChangeBassTuning: setBassTuning,
          onRename: (m: { title?: string; artist?: string; album?: string }) => void handleRename(m),
          onReanalyze: doc
            ? (mode: 'transcribe' | 'full', choice?: { separator?: SeparatorId; chordTranscriber?: ChordTranscriberId }) => void handleReanalyze(mode, choice)
            : undefined,
          separatorChoices: health?.separatorChoices,
          defaultSeparator: settings.processing.separator,
          chordTranscriberChoices: health?.chordTranscriberChoices,
          defaultChordTranscriber: settings.processing.chordTranscriber,
          reanalyzing,
        }
      : null;

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
        if (e.currentTarget === e.target) setIsWindowDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsWindowDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        if (file.name.toLowerCase().endsWith('.sfg')) void importSfgFile(file);
        else void handleUploadFile(file);
      }}
    >
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
        aria-label="Import audio or video file"
      />

      <Header
        activeView={activeView}
        onSelectView={setActiveView}
        onImportClick={() => globalFileInputRef.current?.click()}
        saveStatus={saveStatus}
        saveMessage={saveMessage}
        canSaveProject={Boolean(project?.serverProjectId)}
        onOpenProject={() => void handleOpenSfg()}
        onSaveProject={() => void handleSaveSfg(project?.serverProjectId, false)}
        onSaveProjectAs={() => void handleSaveSfg(project?.serverProjectId, true)}
        onExport={() => setExportState({ tab: 'audio' })}
        onRevealProjects={health ? () => void handleReveal() : undefined}
      />

      {busyMessage && (
        <div role="status" className="bg-amber-500/10 border-b border-amber-500/30 text-amber-200 text-xs">
          <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-2 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            {busyMessage}
          </div>
        </div>
      )}

      {project && (
        <TransportBar
          project={songProject ?? project}
          isPlaying={isPlaying}
          currentTime={currentTime}
          loopEnabled={loopEnabled}
          metronomeEnabled={metronomeEnabled}
          playbackRate={playbackRate}
          transpose={transpose}
          transposePending={transposePending}
          pitchMode={project.serverProjectId ? 'buffers' : 'varispeed'}
          onEditSong={() => setActiveView('settings')}
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
          onChangeTranspose={(semitones) => void applyTranspose(semitones)}
        />
      )}

      <main className="flex-1">
        {!project ? (
          <div className="max-w-[1440px] mx-auto px-6 py-16 text-center text-sm text-slate-400">Initializing studio audio engine…</div>
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
            onExportStem={(id) => setExportState({ tab: 'audio', tracks: [id] })}
          />
        ) : activeView === 'midi' ? (
          <MidiStudioView
            project={editedProject ?? project}
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
            onPreviewNote={(midi, dur, isDrum) => engineRef.current?.triggerPreviewNote(midi, dur, isDrum)}
            onOpenExport={() => setExportState({ tab: 'midi' })}
          />
        ) : activeView === 'notation' ? (
          <NotationView
            project={editedProject ?? project}
            autoProject={songProject ?? project}
            tabEdits={tabEdits}
            onTabEdit={handleTabEdit}
            barSettings={barSettings}
            onBarSettings={setBarSettings}
            currentTime={currentTime}
            transpose={transpose}
            onSeek={handleSeek}
            onPreviewNote={(midi, dur) => engineRef.current?.triggerPreviewNote(midi, dur, false)}
            onPreviewChord={(midis) => engineRef.current?.triggerChordPreview(midis)}
            part={notationPart}
            onChangePart={setNotationPart}
            guitarTuning={guitarTuning}
            bassTuning={bassTuning}
            onChangeGuitarTuning={setGuitarTuning}
            onChangeBassTuning={setBassTuning}
            tuningOptions={tuningOptions}
            maxFret={settings.notation.maxFret}
            accidentals={settings.notation.accidentals}
            onOpenExport={() => setExportState({ tab: 'score' })}
          />
        ) : activeView === 'settings' ? (
          <SettingsView
            settings={settings}
            onChange={changeSettings}
            song={songEditing}
            health={health}
            healthError={healthError}
            onTestEngine={() => void testEngine()}
            onUnloadGpu={() =>
              void unloadGpuModel(serverUrl)
                .then((u) => showToast('ok', u ? 'StemForge released its GPU memory.' : 'GPU memory was already free.'))
                .then(() => testEngine())
                .catch((err) => showToast('error', err instanceof Error ? err.message : 'GPU engine not reachable.'))
            }
            onPickProjectsFolder={() => void handlePickProjectsFolder()}
            onRevealProjects={() => void handleReveal()}
            projectsDir={projectsDir}
            defaultProjectsDir={defaultProjectsDir}
          />
        ) : (
          <LibraryView
            currentProject={project}
            uploadedProjects={uploadedProjects}
            processing={processing}
            error={uploadError}
            engineMode={settings.engine.mode}
            health={health}
            projects={gpuMode ? projects : null}
            projectsDir={projectsDir}
            onRefreshProjects={() => {
              void testEngine();
              void refreshProjects();
            }}
            onOpenProject={(id) => void openServerProject(id)}
            onSaveProjectSfg={(id) => void handleSaveSfg(id, true)}
            onDeleteProject={(id) => void handleDeleteProject(id)}
            onOpenSfg={() => void handleOpenSfg()}
            onRevealProjects={() => void handleReveal()}
            onCancelProcessing={() => {
              if (processing?.projectId) void cancelProject(serverUrl, processing.projectId);
            }}
            onSelectDemo={(bp: DemoSongBlueprint) => {
              loadTemporarySong(buildDemoSongProject(bp, engineRef.current!.ensureContext()));
              setActiveView('mixer');
            }}
            onSelectUploaded={(proj) => {
              loadTemporarySong(proj);
              setActiveView('mixer');
            }}
            onUploadFile={(file) => void handleUploadFile(file)}
            onDismissError={() => setUploadError(null)}
            onOpenSettings={() => setActiveView('settings')}
          />
        )}
      </main>

      {exportState && project && resolvedTunings && (
        <ExportDialog
          project={editedProject ?? project}
          mixer={mixer}
          transpose={transpose}
          playbackRate={playbackRate}
          settings={settings}
          serverUrl={serverUrl}
          tunings={resolvedTunings}
          initialTab={exportState.tab}
          initialTracks={exportState.tracks}
          onRemember={(kind, values) => changeSettings({ ...settingsRef.current, exportDefaults: { ...settingsRef.current.exportDefaults, [kind]: values } })}
          onClose={() => setExportState(null)}
        />
      )}

      {toast && (
        <div
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={`fixed bottom-4 right-4 z-[60] max-w-md text-xs rounded-md border px-4 py-3 shadow-xl ${
            toast.kind === 'error' ? 'bg-[#2A1418] border-rose-500/50 text-rose-100' : 'bg-[#10221A] border-emerald-500/40 text-emerald-100'
          }`}
        >
          {toast.text}
        </div>
      )}

      {isWindowDragging && (
        <div className="fixed inset-0 z-50 bg-[#0B0D10]/90 backdrop-blur-sm flex items-center justify-center p-6 pointer-events-none">
          <div className="max-w-md w-full border-2 border-dashed border-amber-500 rounded-xl p-10 text-center bg-[#13161C]">
            <Upload className="w-8 h-8 text-amber-400 mx-auto mb-3" aria-hidden="true" />
            <p className="font-display text-lg font-bold text-white">Drop a song, video or .sfg project</p>
            <p className="text-xs font-mono text-slate-400 mt-1">MP3 · WAV · FLAC · M4A · MP4 · MKV · .sfg</p>
          </div>
        </div>
      )}
    </div>
  );
}
