import { useState } from 'react';
import { Cpu, FolderOpen, Loader2, RefreshCw, RotateCcw, Wand2 } from 'lucide-react';
import type { BassTuningId, GuitarTuningId, QuantizeGrid, SongProject } from '../types/music';
import { BASS_TUNINGS, GUITAR_TUNINGS, formatKeySignature } from '../audio/notationEngine';
import type { GpuHealthStatus, ProjectDocument } from '../audio/serverApi';
import type { ResolvedTunings } from '../audio/scoreExport';
import { TIME_SIGNATURES } from '../audio/timeline';
import {
  GENRE_PRESETS,
  applyGenrePreset,
  presetById,
  type AppSettings,
  type GenrePresetId,
  type SensitivityTarget,
  type TranscribeTarget,
} from '../settings/appSettings';
import { Field, FieldGrid, NumberInput, Section, Segmented, Select, Slider, StatusLine, Toggle, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';
import type { SongOverrides } from '../audio/projectModel';

interface SongEditing {
  project: SongProject;
  doc: ProjectDocument | null;
  overrides: SongOverrides;
  detected: { bpm: number; beatOffsetSec: number; key: { rootPc: number; mode: 'major' | 'minor' } | null; candidates: number[] };
  guitarTuning: GuitarTuningId | 'auto';
  bassTuning: BassTuningId | 'auto';
  resolvedTunings: ResolvedTunings;
  onChange: (patch: SongOverrides) => void;
  onReset: (field: keyof SongOverrides) => void;
  onChangeGuitarTuning: (t: GuitarTuningId | 'auto') => void;
  onChangeBassTuning: (t: BassTuningId | 'auto') => void;
  onRename: (meta: { title?: string; artist?: string; album?: string }) => void;
  onReanalyze?: (mode: 'transcribe' | 'full') => void;
  reanalyzing?: { stage: string; percent: number } | null;
}

interface SettingsViewProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  song: SongEditing | null;
  health: GpuHealthStatus | null;
  healthError: string | null;
  onTestEngine: () => void;
  onUnloadGpu: () => void;
  onPickProjectsFolder: () => void;
  onRevealProjects: () => void;
  projectsDir: string | null;
  defaultProjectsDir: string | null;
}

const KEY_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const rootPc = i % 12;
  const mode: 'major' | 'minor' = i < 12 ? 'major' : 'minor';
  return { value: `${rootPc}:${mode}`, label: formatKeySignature(rootPc, mode) };
});

const SENSITIVITY_LABELS: Record<SensitivityTarget, string> = {
  guitar: 'Guitar',
  bass: 'Bass',
  keyboards: 'Keyboards',
  vocals: 'Vocals (melody)',
  drums: 'Drums',
};

const TRANSCRIBE_LABELS: Record<TranscribeTarget, string> = {
  guitar: 'Guitar (rhythm)',
  lead: 'Lead guitar',
  bass: 'Bass',
  keyboards: 'Keyboards',
  vocals: 'Vocal melody',
  drums: 'Drums',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function SettingsView({
  settings,
  onChange,
  song,
  health,
  healthError,
  onTestEngine,
  onUnloadGpu,
  onPickProjectsFolder,
  onRevealProjects,
  projectsDir,
  defaultProjectsDir,
}: SettingsViewProps) {
  const [titleDraft, setTitleDraft] = useState<{ title: string; artist: string; album: string } | null>(null);

  const set = (patch: (s: AppSettings) => AppSettings) => onChange(patch(structuredClone(settings)));
  const setTranscription = (fn: (t: AppSettings['transcription']) => void) =>
    set((s) => {
      fn(s.transcription);
      s.genre = 'custom';
      return s;
    });
  const preset = presetById(settings.genre);

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
      {song && <SongSection song={song} titleDraft={titleDraft} setTitleDraft={setTitleDraft} />}

      <Section
        title="Engine & Processing"
        description="How new songs are separated. Changes apply to the next import (or use Re-analyze above for the current song)."
        actions={
          <>
            <button type="button" onClick={onTestEngine} className={secondaryButtonClass}>
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Test connection
            </button>
            <button type="button" onClick={onUnloadGpu} className={secondaryButtonClass} title="Release StemForge's models from VRAM so ComfyUI or games can use it">
              <Cpu className="w-3.5 h-3.5" aria-hidden="true" />
              Free GPU memory
            </button>
          </>
        }
      >
        {health && (
          <StatusLine kind="ok">
            Connected · {health.gpu}
            {health.vramGb !== undefined && ` · ${health.vramFreeGb ?? '?'} / ${health.vramGb} GB VRAM free`} · Notes:{' '}
            {health.transcriber ? 'Basic Pitch (polyphonic)' : 'not installed'} · Drums:{' '}
            {health.drumTranscriber === 'adtof' ? 'ADTOF neural model' : 'onset detector (ADTOF not installed)'} · FFmpeg:{' '}
            {health.ffmpeg ? 'yes' : 'missing'}
            {health.version && ` · v${health.version}`}
          </StatusLine>
        )}
        {healthError && <StatusLine kind="error">{healthError}</StatusLine>}
        <FieldGrid>
          <Field label="Separation engine" hint="Local GPU = Demucs on your NVIDIA card + saved projects. Browser = no setup, lower quality, not saved.">
            <Segmented
              ariaLabel="Separation engine"
              value={settings.engine.mode}
              onChange={(v) => set((s) => ({ ...s, engine: { ...s.engine, mode: v } }))}
              options={[
                { value: 'gpu', label: 'Local GPU (Demucs)' },
                { value: 'browser', label: 'Browser STFT' },
              ]}
            />
          </Field>
          <Field label="GPU engine address" hint="Default http://127.0.0.1:8000">
            <input
              className={inputClass}
              value={settings.engine.serverUrl}
              aria-label="GPU engine address"
              onChange={(e) => set((s) => ({ ...s, engine: { ...s.engine, serverUrl: e.target.value } }))}
            />
          </Field>
          <Field
            label="Separation quality"
            hint="Fast ≈ 10 s, Balanced ≈ 25 s, High ≈ 60–90 s per 4-minute song on an RTX 4070. High adds Demucs' fine-tuned model for cleaner drums, bass and vocals."
          >
            <Segmented
              ariaLabel="Separation quality"
              value={settings.processing.quality}
              onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, quality: v } }))}
              options={[
                { value: 'fast', label: 'Fast' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'high', label: 'High' },
              ]}
            />
          </Field>
          <Field label="Keyboards track contains">
            <Select
              ariaLabel="Keyboards track contents"
              value={settings.processing.keyboardsMode}
              onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, keyboardsMode: v } }))}
              options={[
                { value: 'merged', label: 'Piano + synths + everything else' },
                { value: 'piano', label: 'Piano only' },
              ]}
            />
          </Field>
          <Toggle
            checked={settings.processing.splitGuitars}
            onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, splitGuitars: v } }))}
            label="Split lead and rhythm guitars"
            hint="Separates center-panned guitar (leads, solos) from hard-panned double-tracked rhythm guitars — common in rock and metal mixes."
          />
          <Toggle
            checked={settings.processing.splitRhythmGuitars}
            onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, splitRhythmGuitars: v } }))}
            label="Give each rhythm guitar its own track"
            hint="Double-tracked guitars panned left and right become Guitar 1 – Left and Guitar 2 – Right in the mixer, each with its own tab. Where the two play the same note at once they can't be told apart by position, so some of the other guitar stays audible there."
          />
          <Toggle
            checked={settings.processing.freeVramAfter}
            onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, freeVramAfter: v } }))}
            label="Free GPU memory after each song"
            hint="Slower next import, but leaves VRAM free for ComfyUI or games."
          />
        </FieldGrid>
        <Field label="Transcribe these tracks to notes / MIDI">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {(Object.keys(TRANSCRIBE_LABELS) as TranscribeTarget[]).map((k) => (
              <Toggle
                key={k}
                checked={settings.processing.transcribe[k]}
                onChange={(v) => set((s) => ({ ...s, processing: { ...s.processing, transcribe: { ...s.processing.transcribe, [k]: v } } }))}
                label={TRANSCRIBE_LABELS[k]}
              />
            ))}
          </div>
        </Field>
      </Section>

      <Section
        title="Genre & Transcription"
        description="Pick the style you import most. Presets tune note detection, tempo range and power-chord clean-up; adjusting any slider switches to Custom."
      >
        <Field label="Genre preset" hint={preset ? preset.description : 'Custom settings.'}>
          <Segmented
            ariaLabel="Genre preset"
            value={settings.genre}
            onChange={(v: GenrePresetId) => onChange(v === 'custom' ? { ...settings, genre: 'custom' } : applyGenrePreset(settings, v))}
            options={[...GENRE_PRESETS.map((p) => ({ value: p.id as GenrePresetId, label: p.label })), { value: 'custom' as GenrePresetId, label: 'Custom' }]}
          />
        </Field>
        <FieldGrid>
          {(Object.keys(SENSITIVITY_LABELS) as SensitivityTarget[]).map((k) => (
            <Field key={k} label={`${SENSITIVITY_LABELS[k]} sensitivity`} hint={k === 'guitar' ? 'Lower = fewer ghost notes from distortion.' : undefined}>
              <Slider
                ariaLabel={`${SENSITIVITY_LABELS[k]} sensitivity`}
                min={0}
                max={1}
                step={0.05}
                value={settings.transcription.sensitivity[k]}
                format={pct}
                onChange={(v) => setTranscription((t) => (t.sensitivity[k] = v))}
              />
            </Field>
          ))}
          <Field label="Shortest note" hint="Lower catches fast tremolo picking and 32nd notes; higher removes blips.">
            <Slider
              ariaLabel="Shortest note in milliseconds"
              min={20}
              max={200}
              step={5}
              value={settings.transcription.minNoteMs}
              format={(v) => `${v} ms`}
              onChange={(v) => setTranscription((t) => (t.minNoteMs = v))}
            />
          </Field>
          <Field label="Tempo range (BPM)" hint="Detection only considers tempos in this range; the center is the most likely tempo.">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <NumberInput ariaLabel="Minimum tempo" value={settings.transcription.tempoMin} min={30} max={300} onChange={(v) => setTranscription((t) => (t.tempoMin = v))} className="w-20" />
              <span>to</span>
              <NumberInput ariaLabel="Maximum tempo" value={settings.transcription.tempoMax} min={40} max={400} onChange={(v) => setTranscription((t) => (t.tempoMax = v))} className="w-20" />
              <span>center</span>
              <NumberInput ariaLabel="Most likely tempo" value={settings.transcription.tempoPrior} min={40} max={300} onChange={(v) => setTranscription((t) => (t.tempoPrior = v))} className="w-20" />
            </div>
          </Field>
          <Field label="Silence gate" hint="Tracks quieter than this are treated as empty (no phantom notes from bleed).">
            <Slider
              ariaLabel="Silence gate in dB"
              min={-70}
              max={-20}
              step={1}
              value={settings.transcription.silenceGateDb}
              format={(v) => `${v} dB`}
              onChange={(v) => setTranscription((t) => (t.silenceGateDb = v))}
            />
          </Field>
          <Toggle
            checked={settings.transcription.simplifyPowerChords}
            onChange={(v) => setTranscription((t) => (t.simplifyPowerChords = v))}
            label="Clean up distorted power chords"
            hint="Removes overtones that distortion adds, so riffs read as root + fifth (+ octave)."
          />
        </FieldGrid>
      </Section>

      <Section title="Tabs & Notation" description="Defaults for new songs. Each song remembers its own choices.">
        <FieldGrid>
          <Field label="Default guitar tuning">
            <Select
              ariaLabel="Default guitar tuning"
              value={settings.notation.guitarTuning}
              onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, guitarTuning: v } }))}
              options={[{ value: 'auto' as GuitarTuningId | 'auto', label: 'Auto-detect from the notes' }, ...Object.values(GUITAR_TUNINGS).map((t) => ({ value: t.id as GuitarTuningId, label: t.label }))]}
            />
          </Field>
          <Field label="Default bass tuning">
            <Select
              ariaLabel="Default bass tuning"
              value={settings.notation.bassTuning}
              onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, bassTuning: v } }))}
              options={[{ value: 'auto' as BassTuningId | 'auto', label: 'Auto-detect from the notes' }, ...Object.values(BASS_TUNINGS).map((t) => ({ value: t.id as BassTuningId, label: t.label }))]}
            />
          </Field>
          <Field label="Highest fret used in tabs">
            <Slider ariaLabel="Highest fret" min={12} max={27} step={1} value={settings.notation.maxFret} onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, maxFret: v } }))} />
          </Field>
          <Toggle
            checked={settings.notation.allowExtendedRangeGuitar}
            onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, allowExtendedRangeGuitar: v } }))}
            label="Consider 7- and 8-string guitars in auto-detect"
          />
          <Toggle
            checked={settings.notation.allowFiveStringBass}
            onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, allowFiveStringBass: v } }))}
            label="Consider 5-string bass in auto-detect"
          />
          <Field label="Accidentals in sheet music">
            <Segmented
              ariaLabel="Accidentals"
              value={settings.notation.accidentals}
              onChange={(v) => set((s) => ({ ...s, notation: { ...s.notation, accidentals: v } }))}
              options={[
                { value: 'auto', label: 'By key' },
                { value: 'sharps', label: 'Sharps ♯' },
                { value: 'flats', label: 'Flats ♭' },
              ]}
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section title="MIDI" description="Defaults for the MIDI Studio and MIDI exports.">
        <FieldGrid>
          <Field label="Quantize grid">
            <Select
              ariaLabel="Default quantize grid"
              value={settings.midi.quantize}
              onChange={(v: QuantizeGrid) => set((s) => ({ ...s, midi: { ...s.midi, quantize: v } }))}
              options={[
                { value: 'off', label: 'Off (as played)' },
                { value: '1/4', label: '1/4 note' },
                { value: '1/8', label: '1/8 note' },
                { value: '1/16', label: '1/16 note' },
                { value: '1/32', label: '1/32 note' },
                { value: '1/8T', label: '1/8 triplet' },
                { value: '1/16T', label: '1/16 triplet' },
              ]}
            />
          </Field>
          <Field label="Minimum velocity" hint="Notes softer than this are hidden and not exported.">
            <Slider ariaLabel="Minimum velocity" min={1} max={105} step={2} value={settings.midi.minVelocity} onChange={(v) => set((s) => ({ ...s, midi: { ...s.midi, minVelocity: v } }))} />
          </Field>
          <Field label="MIDI resolution (PPQ)">
            <Segmented
              ariaLabel="MIDI resolution"
              value={String(settings.midi.ppq) as '480' | '960'}
              onChange={(v) => set((s) => ({ ...s, midi: { ...s.midi, ppq: v === '960' ? 960 : 480 } }))}
              options={[
                { value: '480', label: '480' },
                { value: '960', label: '960' },
              ]}
            />
          </Field>
        </FieldGrid>
      </Section>

      <Section
        title="Projects & Files"
        description="Every song you import is kept as a draft in the projects folder, so nothing is lost when you close StemForge. Use File → Save project (.sfg) to keep a single-file copy anywhere."
        actions={
          <button type="button" onClick={onRevealProjects} className={secondaryButtonClass}>
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
            Open projects folder
          </button>
        }
      >
        <FieldGrid>
          <Field label="Projects folder" hint={`Currently: ${projectsDir ?? 'GPU engine not connected'}`} wide>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} flex-1 min-w-[260px] font-mono`}
                aria-label="Projects folder"
                placeholder={defaultProjectsDir ?? 'Documents\\StemForge\\Projects'}
                value={settings.projects.folder}
                onChange={(e) => set((s) => ({ ...s, projects: { ...s.projects, folder: e.target.value } }))}
              />
              <button type="button" onClick={onPickProjectsFolder} className={secondaryButtonClass}>
                Browse…
              </button>
              <button
                type="button"
                onClick={() => set((s) => ({ ...s, projects: { ...s.projects, folder: '' } }))}
                className={secondaryButtonClass}
                disabled={!settings.projects.folder}
              >
                Use default
              </button>
            </div>
          </Field>
          <Toggle
            checked={settings.projects.autosave}
            onChange={(v) => set((s) => ({ ...s, projects: { ...s.projects, autosave: v } }))}
            label="Autosave changes"
            hint="Mixer, tempo, key, tunings and MIDI settings are saved to the draft as you work."
          />
          <Toggle
            checked={settings.projects.reopenLastProject}
            onChange={(v) => set((s) => ({ ...s, projects: { ...s.projects, reopenLastProject: v } }))}
            label="Reopen the last song on startup"
          />
          <Toggle
            checked={settings.projects.includeOriginalInSfg}
            onChange={(v) => set((s) => ({ ...s, projects: { ...s.projects, includeOriginalInSfg: v } }))}
            label="Include the original audio in .sfg files"
            hint="Needed to re-analyze the song later; makes the file larger."
          />
        </FieldGrid>
      </Section>

      <Section title="Playback Sync" description="Keeps the moving playhead and the highlighted tab notes in step with what you hear.">
        <FieldGrid>
          <Field
            label="Highlight delay (ms)"
            hint="The delay of your audio device is measured and compensated automatically. If notes still light up before you hear them (Bluetooth headphones add 100–300 ms), raise this; if they light up late, lower it."
          >
            <div className="flex items-center gap-2">
              <NumberInput
                ariaLabel="Highlight delay in milliseconds"
                value={settings.playback.avSyncMs}
                min={-300}
                max={600}
                step={5}
                onChange={(v) => set((s) => ({ ...s, playback: { ...s.playback, avSyncMs: Math.round(v) } }))}
                className="w-24"
              />
              <button type="button" className={secondaryButtonClass} onClick={() => set((s) => ({ ...s, playback: { ...s.playback, avSyncMs: 0 } }))}>
                Reset
              </button>
            </div>
          </Field>
        </FieldGrid>
      </Section>

      <Section title="Desktop App" description="Applies to StemForge.exe (the desktop shortcut). Takes effect the next time you open StemForge.">
        <FieldGrid>
          <Toggle
            checked={settings.desktop.keepEngineRunning}
            onChange={(v) => set((s) => ({ ...s, desktop: { ...s.desktop, keepEngineRunning: v } }))}
            label="Keep the GPU engine running after closing the window"
            hint="Reopens faster, but keeps the engine process running in the background."
          />
        </FieldGrid>
      </Section>
    </div>
  );
}

function SongSection({
  song,
  titleDraft,
  setTitleDraft,
}: {
  song: SongEditing;
  titleDraft: { title: string; artist: string; album: string } | null;
  setTitleDraft: (v: { title: string; artist: string; album: string } | null) => void;
}) {
  const { project, doc, overrides, detected } = song;
  const isServer = Boolean(doc);
  const draft = titleDraft ?? { title: doc?.title ?? project.title, artist: doc?.artist ?? '', album: doc?.album ?? '' };
  const keyValue = overrides.key ? `${overrides.key.rootPc}:${overrides.key.mode}` : 'auto';
  const sep = doc?.processing?.separation;
  const tr = doc?.transcription;

  return (
    <Section
      title={`This Song — ${project.title}`}
      description="Fix anything the analysis got wrong. Notes, tabs, chords, sheet music and MIDI update instantly and are saved with the song."
    >
      {isServer && (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Title">
            <input className={`${inputClass} w-64`} aria-label="Song title" value={draft.title} onChange={(e) => setTitleDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="Artist">
            <input className={`${inputClass} w-48`} aria-label="Artist" value={draft.artist} onChange={(e) => setTitleDraft({ ...draft, artist: e.target.value })} />
          </Field>
          <Field label="Album">
            <input className={`${inputClass} w-48`} aria-label="Album" value={draft.album} onChange={(e) => setTitleDraft({ ...draft, album: e.target.value })} />
          </Field>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={!titleDraft}
            onClick={() => {
              song.onRename(draft);
              setTitleDraft(null);
            }}
          >
            Save names
          </button>
        </div>
      )}

      <FieldGrid>
        <Field
          label="Tempo (BPM)"
          hint={
            <>
              Detected {detected.bpm.toFixed(1)}. Fast songs are often detected at half or double speed — use ½× / 2× or pick another candidate.
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <NumberInput ariaLabel="Tempo" value={Math.round(project.bpm * 100) / 100} min={30} max={400} step={0.1} onChange={(v) => song.onChange({ bpm: v })} className="w-24" />
            <button type="button" className={secondaryButtonClass} onClick={() => song.onChange({ bpm: project.bpm / 2 })}>
              ½×
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => song.onChange({ bpm: project.bpm * 2 })}>
              2×
            </button>
            {overrides.bpm !== undefined && (
              <button type="button" className={secondaryButtonClass} onClick={() => song.onReset('bpm')} title="Back to the detected tempo">
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          {detected.candidates.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {detected.candidates.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => song.onChange({ bpm: c })}
                  className={`px-2 py-0.5 rounded border text-[11px] font-mono cursor-pointer ${
                    Math.abs(c - project.bpm) < 0.6 ? 'border-amber-500 text-amber-300' : 'border-white/[0.12] text-slate-400 hover:text-white'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Beat grid offset" hint="Time of the first beat. Turn on the Click and nudge until it lands on the drums.">
          <div className="flex flex-wrap items-center gap-2">
            <NumberInput ariaLabel="Beat offset in milliseconds" value={Math.round(project.beatOffsetSec * 1000)} step={5} onChange={(v) => song.onChange({ beatOffsetSec: v / 1000 })} className="w-24" />
            <span className="text-xs text-slate-500">ms</span>
            <button type="button" className={secondaryButtonClass} onClick={() => song.onChange({ beatOffsetSec: project.beatOffsetSec - 0.01 })}>
              −10 ms
            </button>
            <button type="button" className={secondaryButtonClass} onClick={() => song.onChange({ beatOffsetSec: project.beatOffsetSec + 0.01 })}>
              +10 ms
            </button>
            {overrides.beatOffsetSec !== undefined && (
              <button type="button" className={secondaryButtonClass} onClick={() => song.onReset('beatOffsetSec')} title="Back to the detected offset">
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </Field>
        <Field label="Time signature">
          <Select
            ariaLabel="Time signature"
            value={`${project.timeSignature[0]}/${project.timeSignature[1]}`}
            onChange={(v: string) => {
              const [n, d] = v.split('/').map(Number);
              song.onChange({ timeSignature: [n, d] });
            }}
            options={TIME_SIGNATURES.map(([n, d]) => ({ value: `${n}/${d}`, label: `${n}/${d}` }))}
          />
        </Field>
        <Field label="Key" hint={detected.key ? `Detected ${formatKeySignature(detected.key.rootPc, detected.key.mode)}` : undefined}>
          <Select
            ariaLabel="Key"
            value={keyValue}
            onChange={(v: string) => {
              if (v === 'auto') song.onReset('key');
              else {
                const [pc, mode] = v.split(':');
                song.onChange({ key: { rootPc: Number(pc), mode: mode as 'major' | 'minor' } });
              }
            }}
            options={[{ value: 'auto', label: 'Auto (detected)' }, ...KEY_OPTIONS]}
          />
        </Field>
        <Field label="Guitar tuning">
          <Select
            ariaLabel="Guitar tuning for this song"
            value={song.guitarTuning}
            onChange={song.onChangeGuitarTuning}
            options={[
              { value: 'auto' as GuitarTuningId | 'auto', label: `Auto — ${song.resolvedTunings.detectedGuitar.label}` },
              ...Object.values(GUITAR_TUNINGS).map((t) => ({ value: t.id as GuitarTuningId, label: t.label })),
            ]}
          />
        </Field>
        <Field label="Bass tuning">
          <Select
            ariaLabel="Bass tuning for this song"
            value={song.bassTuning}
            onChange={song.onChangeBassTuning}
            options={[
              { value: 'auto' as BassTuningId | 'auto', label: `Auto — ${song.resolvedTunings.detectedBass.label}` },
              ...Object.values(BASS_TUNINGS).map((t) => ({ value: t.id as BassTuningId, label: t.label })),
            ]}
          />
        </Field>
        {project.raw && (
          <Toggle
            checked={overrides.simplifyPowerChords ?? true}
            onChange={(v) => song.onChange({ simplifyPowerChords: v })}
            label="Clean up distorted power chords"
          />
        )}
      </FieldGrid>

      {doc && (
        <div className="text-xs text-slate-400 leading-relaxed border-t border-white/[0.06] pt-3 flex flex-col gap-1">
          <span>
            Separated with {(sep?.models ?? ['htdemucs_6s']).join(' + ')} ({doc.processing?.quality ?? 'balanced'}
            {sep?.shifts ? `, ${sep.shifts} passes` : ''}) on {doc.processing?.gpu ?? 'GPU'}
            {sep?.seconds ? ` in ${sep.seconds}s` : ''}.
            {sep?.guitarSplit ? ' Lead and rhythm guitars split.' : sep?.guitarSplitNote ? ` ${sep.guitarSplitNote}` : ''}
          </span>
          <span>
            Notes: {tr?.engine === 'basic-pitch' ? 'Basic Pitch (polyphonic)' : 'browser'} · Drums:{' '}
            {tr?.drumEngine === 'adtof' ? 'ADTOF neural model' : 'onset detector'}
            {tr?.silentStems?.length ? ` · Treated as silent: ${tr.silentStems.join(', ')}` : ''}
          </span>
        </div>
      )}

      {song.onReanalyze && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={secondaryButtonClass} disabled={Boolean(song.reanalyzing)} onClick={() => song.onReanalyze?.('transcribe')}>
            <Wand2 className="w-3.5 h-3.5" aria-hidden="true" />
            Re-transcribe with current settings
          </button>
          <button type="button" className={secondaryButtonClass} disabled={Boolean(song.reanalyzing)} onClick={() => song.onReanalyze?.('full')}>
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            Re-separate &amp; re-transcribe
          </button>
          {song.reanalyzing && (
            <span className="inline-flex items-center gap-2 text-xs text-slate-300">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" aria-hidden="true" />
              {song.reanalyzing.stage} ({Math.round(song.reanalyzing.percent)}%)
            </span>
          )}
          <span className="text-[11px] text-slate-500">Uses the Engine and Genre settings below. Your mixer and edits are kept.</span>
        </div>
      )}
    </Section>
  );
}
