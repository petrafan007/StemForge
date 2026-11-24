import { useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { MidiNoteEvent, NotationPart, QuantizeGrid, SongProject, StemId, StemMixerState } from '../types/music';
import { projectStemIds, stemLabel } from '../types/music';
import { drumHitsToMidiEvents, encodeMidiFile, quantizeDrumHits, quantizeMidiNotes, type MidiTrackInput } from '../audio/midiEncoder';
import { tempoChangesFor } from '../audio/timeline';
import { GM_PROGRAMS } from '../audio/gmPrograms';
import { encodeWav, mixStems, preventClipping } from '../audio/clientExport';
import { exportAudioOnServer } from '../audio/serverApi';
import { buildAsciiTab, buildMusicXml, partLabel, type ResolvedTunings, type ScorePartId } from '../audio/scoreExport';
import { formatTimecode } from '../utils/download';
import { pickDirectory, sanitizeFileName, saveFileAs, writeFileInDirectory, downloadBlob, type FilePickerType } from '../utils/fileSystem';
import type { AppSettings } from '../settings/appSettings';
import { Field, FieldGrid, Modal, NumberInput, Segmented, Select, StatusLine, Toggle, inputClass, primaryButtonClass, secondaryButtonClass } from './ui';

export type ExportTab = 'audio' | 'midi' | 'score';

type AudioFormat = 'wav' | 'aiff' | 'flac' | 'mp3' | 'ogg' | 'opus' | 'm4a' | 'alac';

const FORMAT_INFO: Record<AudioFormat, { label: string; ext: string; mime: string; lossless: boolean }> = {
  wav: { label: 'WAV (uncompressed)', ext: '.wav', mime: 'audio/wav', lossless: true },
  aiff: { label: 'AIFF (uncompressed)', ext: '.aiff', mime: 'audio/aiff', lossless: true },
  flac: { label: 'FLAC (lossless)', ext: '.flac', mime: 'audio/flac', lossless: true },
  alac: { label: 'Apple Lossless (ALAC .m4a)', ext: '.m4a', mime: 'audio/mp4', lossless: true },
  mp3: { label: 'MP3', ext: '.mp3', mime: 'audio/mpeg', lossless: false },
  m4a: { label: 'AAC (.m4a)', ext: '.m4a', mime: 'audio/mp4', lossless: false },
  ogg: { label: 'Ogg Vorbis', ext: '.ogg', mime: 'audio/ogg', lossless: false },
  opus: { label: 'Opus', ext: '.opus', mime: 'audio/ogg', lossless: false },
};

const SAMPLE_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
const MP3_BITRATES = [64, 96, 128, 160, 192, 224, 256, 320];

type MidiTrackId = 'keyboards' | 'guitar' | 'lead' | 'bass' | 'vocals' | 'drums';
const MIDI_DEFAULT_PROGRAMS: Record<Exclude<MidiTrackId, 'drums'>, number> = { keyboards: 0, guitar: 30, lead: 29, bass: 33, vocals: 52 };
const MIDI_CHANNELS: Record<Exclude<MidiTrackId, 'drums'>, number> = { keyboards: 0, guitar: 1, bass: 2, vocals: 3, lead: 4 };

interface ExportDialogProps {
  project: SongProject;
  mixer: Record<StemId, StemMixerState>;
  transpose: number;
  playbackRate: number;
  settings: AppSettings;
  serverUrl: string;
  tunings: ResolvedTunings;
  initialTab?: ExportTab;
  initialTracks?: StemId[];
  onRemember: (kind: 'audio' | 'midi', values: Record<string, unknown>) => void;
  onClose: () => void;
}

function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function ExportDialog(props: ExportDialogProps) {
  const [tab, setTab] = useState<ExportTab>(props.initialTab ?? 'audio');
  return (
    <Modal title="Export" onClose={props.onClose} width="max-w-4xl">
      <Segmented
        ariaLabel="Export type"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'audio', label: 'Audio' },
          { value: 'midi', label: 'MIDI' },
          { value: 'score', label: 'Sheet music & tabs' },
        ]}
      />
      {tab === 'audio' && <AudioExport {...props} />}
      {tab === 'midi' && <MidiExport {...props} />}
      {tab === 'score' && <ScoreExport {...props} />}
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------ audio

function AudioExport({ project, mixer, transpose, playbackRate, serverUrl, settings, initialTracks, onRemember }: ExportDialogProps) {
  const remembered = settings.exportDefaults.audio as Partial<Record<string, unknown>>;
  const present = projectStemIds(project);
  const onServer = Boolean(project.serverProjectId);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(present.map((id) => [id, initialTracks ? initialTracks.includes(id) : true]))
  );
  const [useMixer, setUseMixer] = useState(!initialTracks);
  const [mode, setMode] = useState<'mix' | 'separate'>(initialTracks && initialTracks.length === 1 ? 'mix' : ((remembered.mode as 'mix' | 'separate') ?? 'mix'));
  const [format, setFormat] = useState<AudioFormat>(onServer ? ((remembered.format as AudioFormat) ?? 'wav') : 'wav');
  const [sampleRate, setSampleRate] = useState<number>((remembered.sampleRate as number) ?? 0);
  const [channels, setChannels] = useState<1 | 2>((remembered.channels as 1 | 2) ?? 2);
  const [bitDepth, setBitDepth] = useState<16 | 24 | 32>((remembered.bitDepth as 16 | 24 | 32) ?? 24);
  const [mp3Mode, setMp3Mode] = useState<'cbr' | 'vbr'>((remembered.mp3Mode as 'cbr' | 'vbr') ?? 'cbr');
  const [mp3Bitrate, setMp3Bitrate] = useState<number>((remembered.mp3Bitrate as number) ?? 320);
  const [mp3Vbr, setMp3Vbr] = useState<number>((remembered.mp3Vbr as number) ?? 0);
  const [oggQuality, setOggQuality] = useState<number>((remembered.oggQuality as number) ?? 6);
  const [opusBitrate, setOpusBitrate] = useState<number>((remembered.opusBitrate as number) ?? 160);
  const [aacBitrate, setAacBitrate] = useState<number>((remembered.aacBitrate as number) ?? 256);
  const [flacLevel, setFlacLevel] = useState<number>((remembered.flacLevel as number) ?? 5);
  const [normalize, setNormalize] = useState<'clip' | 'none' | 'peak' | 'loudness'>((remembered.normalize as 'clip') ?? 'clip');
  const [peakDb, setPeakDb] = useState<number>((remembered.peakDb as number) ?? -1);
  const [lufs, setLufs] = useState<number>((remembered.lufs as number) ?? -14);
  const [applyKey, setApplyKey] = useState(transpose !== 0);
  const [applySpeed, setApplySpeed] = useState(playbackRate !== 1);
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [meta, setMeta] = useState({ title: project.title, artist: project.artist.split(' · ')[0] ?? '', album: project.artist.split(' · ')[1] ?? '', genre: '', date: '', track: '' });
  const [baseName, setBaseName] = useState(sanitizeFileName(project.title));
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const anySolo = present.some((id) => mixer[id]?.solo);
  const audibleGain = (id: StemId) => {
    const st = mixer[id];
    if (!st || st.muted || (anySolo && !st.solo)) return 0;
    return st.volume;
  };
  const chosen = present.filter((id) => selected[id] && (!useMixer || audibleGain(id) > 0));
  const info = FORMAT_INFO[format];
  const lossyRates = format === 'mp3' ? SAMPLE_RATES.filter((r) => r <= 48000) : SAMPLE_RATES;

  const buildSpec = (ids: StemId[], fileBase: string) => ({
    tracks: ids.map((id) => ({ id, gain: useMixer ? audibleGain(id) : 1, pan: useMixer ? mixer[id].pan : 0 })),
    format,
    sampleRate: sampleRate || undefined,
    channels,
    bitDepth: format === 'flac' || format === 'alac' ? Math.min(24, bitDepth) : bitDepth,
    mp3Mode,
    bitrate: format === 'mp3' ? mp3Bitrate : format === 'opus' ? opusBitrate : aacBitrate,
    mp3Vbr,
    oggQuality,
    flacLevel,
    normalize,
    peakDb,
    lufs,
    transpose: applyKey ? transpose : 0,
    tempo: applySpeed ? playbackRate : 1,
    start: parseTime(rangeStart) ?? undefined,
    end: parseTime(rangeEnd) ?? undefined,
    fadeInMs: fadeIn,
    fadeOutMs: fadeOut,
    metadata: meta,
    fileName: fileBase,
  });

  const renderOne = async (ids: StemId[], fileBase: string): Promise<{ blob: Blob; name: string }> => {
    if (onServer) {
      const { blob } = await exportAudioOnServer(serverUrl, project.serverProjectId!, buildSpec(ids, fileBase));
      return { blob, name: `${fileBase}${info.ext}` };
    }
    const start = parseTime(rangeStart) ?? 0;
    const end = parseTime(rangeEnd) ?? undefined;
    const { left, right, sampleRate: sr } = mixStems(
      project,
      ids.map((id) => ({ id, gain: useMixer ? audibleGain(id) : 1, pan: useMixer ? mixer[id].pan : 0 })),
      start,
      end
    );
    if (normalize !== 'none') preventClipping(left, right, normalize === 'peak' ? 10 ** (peakDb / 20) : 0.999);
    const chans = channels === 1 ? [left.map((v, i) => (v + right[i]) / 2)] : [left, right];
    const bytes = encodeWav(chans, sr, bitDepth);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return { blob: new Blob([copy], { type: 'audio/wav' }), name: `${fileBase}.wav` };
  };

  const pickerTypes: FilePickerType[] = [{ description: info.label, accept: { [info.mime]: [info.ext] } }];

  const run = async () => {
    setResult(null);
    if (chosen.length === 0) {
      setResult({ kind: 'error', text: useMixer ? 'All selected tracks are muted in the mixer. Unmute them or turn off "Use mixer settings".' : 'Select at least one track.' });
      return;
    }
    try {
      if (mode === 'mix') {
        setBusy('Rendering mix…');
        const { blob, name } = await renderOne(chosen, sanitizeFileName(baseName));
        setBusy('Saving…');
        const saved = await saveFileAs(blob, name, pickerTypes, 'stemforge-audio');
        if (saved) setResult({ kind: 'ok', text: `Saved ${saved.fileName} (${(blob.size / 1048576).toFixed(1)} MB)${saved.method === 'download' ? ' to your Downloads folder' : ''}.` });
      } else {
        const dir = await pickDirectory('stemforge-audio-folder');
        const written: string[] = [];
        for (let i = 0; i < chosen.length; i++) {
          const id = chosen[i];
          setBusy(`Rendering ${i + 1}/${chosen.length}: ${stemLabel(id, project)}…`);
          const fileBase = sanitizeFileName(`${baseName} - ${stemLabel(id, project)}`);
          const { blob, name } = await renderOne([id], fileBase);
          if (dir) await writeFileInDirectory(dir, name, blob);
          else downloadBlob(blob, name);
          written.push(name);
        }
        setResult({ kind: 'ok', text: `Saved ${written.length} files${dir ? ` to "${dir.name}"` : ' to your Downloads folder'}: ${written.join(', ')}` });
      }
      onRemember('audio', { mode, format, sampleRate, channels, bitDepth, mp3Mode, mp3Bitrate, mp3Vbr, oggQuality, opusBitrate, aacBitrate, flacLevel, normalize, peakDb, lufs });
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {!onServer && (
        <StatusLine kind="info">
          This song isn't in your project library (demo or browser import), so only WAV export is available. Import it with the Local GPU engine for MP3, FLAC and other formats.
        </StatusLine>
      )}
      <Field label="Tracks">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {present.map((id) => (
            <label key={id} className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" checked={Boolean(selected[id])} onChange={(e) => setSelected({ ...selected, [id]: e.target.checked })} className="accent-amber-500" />
              {stemLabel(id, project)}
              {useMixer && audibleGain(id) === 0 && <span className="text-[10px] text-slate-500">(muted)</span>}
            </label>
          ))}
          <button type="button" className="text-[11px] text-slate-400 hover:text-white underline cursor-pointer" onClick={() => setSelected(Object.fromEntries(present.map((id) => [id, true])))}>
            All
          </button>
          <button type="button" className="text-[11px] text-slate-400 hover:text-white underline cursor-pointer" onClick={() => setSelected(Object.fromEntries(present.map((id) => [id, false])))}>
            None
          </button>
        </div>
      </Field>
      <FieldGrid>
        <Field label="Output">
          <Segmented
            ariaLabel="Mixdown or separate files"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'mix', label: 'Mix into one file' },
              { value: 'separate', label: 'One file per track' },
            ]}
          />
        </Field>
        <Toggle checked={useMixer} onChange={setUseMixer} label="Use mixer settings" hint="Apply each track's volume, pan, mute and solo — export what you hear." />
        <Field label="Format">
          <Select
            ariaLabel="Audio format"
            value={format}
            onChange={setFormat}
            options={(Object.keys(FORMAT_INFO) as AudioFormat[]).map((f) => ({ value: f, label: FORMAT_INFO[f].label, disabled: !onServer && f !== 'wav' }))}
          />
        </Field>
        <Field label="Sample rate">
          <Select
            ariaLabel="Sample rate"
            value={format === 'opus' ? 48000 : sampleRate}
            onChange={setSampleRate}
            options={[{ value: 0, label: 'Project rate (44100 Hz)' }, ...lossyRates.map((r) => ({ value: r, label: `${r} Hz`, disabled: !onServer || format === 'opus' }))]}
          />
        </Field>
        <Field label="Channels">
          <Segmented
            ariaLabel="Channels"
            value={String(channels) as '1' | '2'}
            onChange={(v) => setChannels(v === '1' ? 1 : 2)}
            options={[
              { value: '2', label: 'Stereo' },
              { value: '1', label: 'Mono' },
            ]}
          />
        </Field>
        {info.lossless ? (
          <Field label="Bit depth">
            <Select
              ariaLabel="Bit depth"
              value={format === 'flac' || format === 'alac' ? Math.min(24, bitDepth) : bitDepth}
              onChange={(v) => setBitDepth(v as 16 | 24 | 32)}
              options={[
                { value: 16, label: '16-bit PCM' },
                { value: 24, label: '24-bit PCM' },
                ...(format === 'wav' || format === 'aiff' ? [{ value: 32, label: '32-bit float' }] : []),
              ]}
            />
          </Field>
        ) : format === 'mp3' ? (
          <Field label="MP3 quality">
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                ariaLabel="MP3 bitrate mode"
                value={mp3Mode}
                onChange={setMp3Mode}
                options={[
                  { value: 'cbr', label: 'Constant' },
                  { value: 'vbr', label: 'Variable' },
                ]}
              />
              {mp3Mode === 'cbr' ? (
                <Select ariaLabel="MP3 bitrate" value={mp3Bitrate} onChange={setMp3Bitrate} options={MP3_BITRATES.map((b) => ({ value: b, label: `${b} kbps` }))} />
              ) : (
                <Select
                  ariaLabel="MP3 VBR quality"
                  value={mp3Vbr}
                  onChange={setMp3Vbr}
                  options={Array.from({ length: 10 }, (_, i) => ({ value: i, label: `V${i}${i === 0 ? ' (best, ~245 kbps)' : i === 2 ? ' (~190 kbps)' : i === 9 ? ' (smallest)' : ''}` }))}
                />
              )}
            </div>
          </Field>
        ) : format === 'ogg' ? (
          <Field label="Vorbis quality">
            <Select ariaLabel="Ogg quality" value={oggQuality} onChange={setOggQuality} options={Array.from({ length: 11 }, (_, i) => ({ value: i, label: `${i}${i === 6 ? ' (~192 kbps)' : i === 10 ? ' (best)' : ''}` }))} />
          </Field>
        ) : format === 'opus' ? (
          <Field label="Opus bitrate">
            <Select ariaLabel="Opus bitrate" value={opusBitrate} onChange={setOpusBitrate} options={[64, 96, 128, 160, 192, 256, 320, 510].map((b) => ({ value: b, label: `${b} kbps` }))} />
          </Field>
        ) : (
          <Field label="AAC bitrate">
            <Select ariaLabel="AAC bitrate" value={aacBitrate} onChange={setAacBitrate} options={[96, 128, 160, 192, 256, 320].map((b) => ({ value: b, label: `${b} kbps` }))} />
          </Field>
        )}
        {format === 'flac' && (
          <Field label="FLAC compression level">
            <Select ariaLabel="FLAC compression" value={flacLevel} onChange={setFlacLevel} options={Array.from({ length: 9 }, (_, i) => ({ value: i, label: `${i}${i === 0 ? ' (fastest)' : i === 8 ? ' (smallest)' : i === 5 ? ' (default)' : ''}` }))} />
          </Field>
        )}
        <Field label="Loudness">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              ariaLabel="Normalization"
              value={normalize}
              onChange={setNormalize}
              options={[
                { value: 'clip', label: 'Prevent clipping' },
                { value: 'none', label: 'No change' },
                { value: 'peak', label: 'Normalize peak to…', disabled: false },
                { value: 'loudness', label: 'Normalize loudness to…', disabled: !onServer },
              ]}
            />
            {normalize === 'peak' && <NumberInput ariaLabel="Peak level dB" value={peakDb} min={-30} max={0} step={0.5} onChange={setPeakDb} className="w-20" />}
            {normalize === 'peak' && <span className="text-xs text-slate-500">dBFS</span>}
            {normalize === 'loudness' && <NumberInput ariaLabel="Target loudness LUFS" value={lufs} min={-40} max={-5} step={1} onChange={setLufs} className="w-20" />}
            {normalize === 'loudness' && <span className="text-xs text-slate-500">LUFS</span>}
          </div>
        </Field>
        <Field label="Range" hint={`Leave empty for the whole song (${formatTimecode(project.duration)}). Use m:ss.`}>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <input className={`${inputClass} w-20 font-mono`} placeholder="0:00" aria-label="Start time" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
            <span>to</span>
            <input className={`${inputClass} w-20 font-mono`} placeholder="end" aria-label="End time" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          </div>
        </Field>
        {onServer && (
          <Field label="Fades (ms)">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>in</span>
              <NumberInput ariaLabel="Fade in ms" value={fadeIn} min={0} max={20000} step={50} onChange={setFadeIn} className="w-20" />
              <span>out</span>
              <NumberInput ariaLabel="Fade out ms" value={fadeOut} min={0} max={20000} step={50} onChange={setFadeOut} className="w-20" />
            </div>
          </Field>
        )}
        {onServer && transpose !== 0 && (
          <Toggle checked={applyKey} onChange={setApplyKey} label={`Apply key change (${transpose > 0 ? '+' : ''}${transpose} semitones)`} hint="High-quality pitch shift; the tempo stays the same." />
        )}
        {onServer && playbackRate !== 1 && (
          <Toggle checked={applySpeed} onChange={setApplySpeed} label={`Apply speed (${playbackRate.toFixed(2)}×)`} hint="Time-stretch without changing the pitch." />
        )}
      </FieldGrid>
      {onServer && (
        <Field label="Metadata (tags)">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {(['title', 'artist', 'album', 'genre', 'date', 'track'] as const).map((k) => (
              <input key={k} className={inputClass} aria-label={k} placeholder={k === 'date' ? 'Year' : k[0].toUpperCase() + k.slice(1)} value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
            ))}
          </div>
        </Field>
      )}
      <Field label={mode === 'mix' ? 'File name' : 'File name prefix (each file adds the track name)'}>
        <div className="flex items-center gap-2">
          <input className={`${inputClass} flex-1`} aria-label="File name" value={baseName} onChange={(e) => setBaseName(e.target.value)} />
          <span className="text-xs font-mono text-slate-500">{mode === 'mix' ? info.ext : `- <track>${info.ext}`}</span>
        </div>
      </Field>
      {result && <StatusLine kind={result.kind}>{result.text}</StatusLine>}
      <div className="flex items-center justify-end gap-2">
        {busy && (
          <span className="inline-flex items-center gap-2 text-xs text-slate-300 mr-auto">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" aria-hidden="true" />
            {busy}
          </span>
        )}
        <button type="button" className={primaryButtonClass} disabled={Boolean(busy)} onClick={() => void run()}>
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          {mode === 'mix' ? 'Export…' : 'Export to folder…'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ MIDI

function MidiExport({ project, transpose, settings, onRemember }: ExportDialogProps) {
  const remembered = settings.exportDefaults.midi as Partial<Record<string, unknown>>;
  const ids: MidiTrackId[] = (['keyboards', 'guitar', 'lead', 'bass', 'vocals', 'drums'] as MidiTrackId[]).filter((id) => id !== 'lead' || Boolean(project.stems.lead));
  const notesOf = (id: MidiTrackId): MidiNoteEvent[] =>
    id === 'keyboards' ? project.keyboardMidi : id === 'guitar' ? project.guitarNotes : id === 'lead' ? project.leadNotes : id === 'bass' ? project.bassNotes : id === 'vocals' ? project.vocalNotes : [];
  const count = (id: MidiTrackId) => (id === 'drums' ? project.drumHits.length : notesOf(id).length);
  const label = (id: MidiTrackId) => (id === 'drums' ? 'Drums' : id === 'keyboards' ? 'Keyboards' : id === 'vocals' ? 'Vocal melody' : id === 'bass' ? 'Bass' : stemLabel(id, project));

  const [selected, setSelected] = useState<Record<string, boolean>>(() => Object.fromEntries(ids.map((id) => [id, count(id) > 0])));
  const [layout, setLayout] = useState<'type1' | 'type0' | 'separate'>((remembered.layout as 'type1') ?? 'type1');
  const [quantize, setQuantize] = useState<QuantizeGrid>((remembered.quantize as QuantizeGrid) ?? settings.midi.quantize);
  const [minVelocity, setMinVelocity] = useState<number>((remembered.minVelocity as number) ?? settings.midi.minVelocity);
  const [ppq, setPpq] = useState<number>((remembered.ppq as number) ?? settings.midi.ppq);
  const [applyTranspose, setApplyTranspose] = useState(transpose !== 0);
  const [programs, setPrograms] = useState<Record<string, number>>(() => ({ ...MIDI_DEFAULT_PROGRAMS, ...((remembered.programs as Record<string, number>) ?? {}) }));
  const [baseName, setBaseName] = useState(sanitizeFileName(project.title));
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const trackFor = (id: MidiTrackId): MidiTrackInput => {
    if (id === 'drums') return { name: 'Drums', notes: drumHitsToMidiEvents(quantizeDrumHits(project.drumHits, quantize, minVelocity)) };
    const ch = MIDI_CHANNELS[id];
    const t = applyTranspose ? transpose : 0;
    return {
      name: label(id),
      program: programs[id],
      notes: quantizeMidiNotes(notesOf(id), quantize, minVelocity).map((n) => ({ ...n, midi: Math.max(0, Math.min(127, n.midi + t)), channel: ch })),
    };
  };

  const types: FilePickerType[] = [{ description: 'MIDI file', accept: { 'audio/midi': ['.mid'] } }];
  const toBlob = (bytes: Uint8Array) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type: 'audio/midi' });
  };

  const run = async () => {
    setResult(null);
    const tempoChanges = tempoChangesFor(project);
    const chosen = ids.filter((id) => selected[id]);
    if (chosen.length === 0) return setResult({ kind: 'error', text: 'Select at least one track.' });
    try {
      if (layout === 'separate') {
        const dir = await pickDirectory('stemforge-midi-folder');
        const names: string[] = [];
        for (const id of chosen) {
          const bytes = encodeMidiFile({ bpm: project.bpm, tempoChanges, timeSignature: project.timeSignature, ticksPerQuarter: ppq, tracks: [trackFor(id)] });
          const name = `${sanitizeFileName(`${baseName} - ${label(id)}`)}.mid`;
          if (dir) await writeFileInDirectory(dir, name, toBlob(bytes));
          else downloadBlob(toBlob(bytes), name);
          names.push(name);
        }
        setResult({ kind: 'ok', text: `Saved ${names.length} MIDI files${dir ? ` to "${dir.name}"` : ' to Downloads'}.` });
      } else {
        const bytes = encodeMidiFile({
          bpm: project.bpm,
          tempoChanges,
          timeSignature: project.timeSignature,
          ticksPerQuarter: ppq,
          tracks: chosen.map(trackFor),
          format: layout === 'type0' ? 0 : 1,
        });
        const saved = await saveFileAs(toBlob(bytes), `${sanitizeFileName(baseName)}.mid`, types, 'stemforge-midi');
        if (saved) setResult({ kind: 'ok', text: `Saved ${saved.fileName} (${chosen.length} track${chosen.length > 1 ? 's' : ''}).` });
      }
      onRemember('midi', { layout, quantize, minVelocity, ppq, programs });
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'MIDI export failed.' });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label="Tracks">
        <div className="flex flex-col gap-2">
          {ids.map((id) => (
            <div key={id} className="flex flex-wrap items-center gap-3">
              <label className="inline-flex items-center gap-2 text-xs text-slate-200 w-48 cursor-pointer">
                <input type="checkbox" className="accent-amber-500" checked={Boolean(selected[id])} onChange={(e) => setSelected({ ...selected, [id]: e.target.checked })} />
                {label(id)} <span className="text-slate-500 font-mono">({count(id)})</span>
              </label>
              {id !== 'drums' ? (
                <Select
                  ariaLabel={`${label(id)} instrument`}
                  value={programs[id]}
                  onChange={(v) => setPrograms({ ...programs, [id]: v })}
                  options={GM_PROGRAMS.map((name, i) => ({ value: i, label: `${i + 1}. ${name}` }))}
                  className="w-64"
                />
              ) : (
                <span className="text-xs text-slate-500">General MIDI drums (channel 10)</span>
              )}
            </div>
          ))}
        </div>
      </Field>
      <FieldGrid>
        <Field label="File layout">
          <Select
            ariaLabel="MIDI layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'type1', label: 'One file, one track per instrument (Type 1)' },
              { value: 'type0', label: 'One file, single merged track (Type 0)' },
              { value: 'separate', label: 'Separate file per instrument' },
            ]}
          />
        </Field>
        <Field label="Quantize">
          <Select
            ariaLabel="MIDI export quantize"
            value={quantize}
            onChange={setQuantize}
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
        <Field label="Minimum velocity">
          <NumberInput ariaLabel="Minimum velocity" value={minVelocity} min={1} max={127} onChange={setMinVelocity} />
        </Field>
        <Field label="Resolution (PPQ)">
          <Select ariaLabel="PPQ" value={ppq} onChange={setPpq} options={[96, 192, 480, 960].map((v) => ({ value: v, label: String(v) }))} />
        </Field>
        {transpose !== 0 && (
          <Toggle checked={applyTranspose} onChange={setApplyTranspose} label={`Apply key change (${transpose > 0 ? '+' : ''}${transpose})`} />
        )}
      </FieldGrid>
      <Field label={layout === 'separate' ? 'File name prefix' : 'File name'}>
        <div className="flex items-center gap-2">
          <input className={`${inputClass} flex-1`} aria-label="MIDI file name" value={baseName} onChange={(e) => setBaseName(e.target.value)} />
          <span className="text-xs font-mono text-slate-500">.mid</span>
        </div>
      </Field>
      <p className="text-[11px] text-slate-500">
        Tempo {project.bpm.toFixed(1)} BPM · {project.timeSignature[0]}/{project.timeSignature[1]}. Fix the tempo or beat grid in Settings → This Song if bars look shifted in your DAW.
      </p>
      {result && <StatusLine kind={result.kind}>{result.text}</StatusLine>}
      <div className="flex justify-end">
        <button type="button" className={primaryButtonClass} onClick={() => void run()}>
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          {layout === 'separate' ? 'Export to folder…' : 'Export…'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------ score

function ScoreExport({ project, transpose, settings, tunings }: ExportDialogProps) {
  const available: ScorePartId[] = (['vocals', 'guitar', 'lead', 'bass', 'keyboards'] as ScorePartId[]).filter((p) => p !== 'lead' || Boolean(project.stems.lead));
  const count = (p: ScorePartId) =>
    p === 'vocals' ? project.vocalNotes.length : p === 'keyboards' ? project.keyboardMidi.length : p === 'guitar' ? project.guitarNotes.length : p === 'lead' ? project.leadNotes.length : project.bassNotes.length;
  const label = (p: ScorePartId) => (p === 'vocals' ? 'Vocal melody' : p === 'keyboards' ? 'Keyboards (grand staff)' : partLabel(project, p as NotationPart));
  const [parts, setParts] = useState<Record<string, boolean>>(() => Object.fromEntries(available.map((p) => [p, count(p) > 0 && p !== 'vocals'])));
  const [includeTab, setIncludeTab] = useState(true);
  const [applyTranspose, setApplyTranspose] = useState(transpose !== 0);
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const t = applyTranspose ? transpose : 0;
  const tabParts = useMemo(() => (['guitar', 'lead', 'bass'] as NotationPart[]).filter((p) => p !== 'lead' || Boolean(project.stems.lead)), [project]);

  const saveText = async (text: string, name: string, desc: string, mime: string, ext: string) => {
    const saved = await saveFileAs(new Blob([text], { type: mime }), name, [{ description: desc, accept: { [mime]: [ext] } }], 'stemforge-score');
    if (saved) setResult({ kind: 'ok', text: `Saved ${saved.fileName}.` });
  };

  const exportXml = async () => {
    setResult(null);
    try {
      const xml = buildMusicXml(project, {
        parts: available.filter((p) => parts[p]),
        includeTab,
        transpose: t,
        tunings,
        maxFret: settings.notation.maxFret,
        accidentals: settings.notation.accidentals,
      });
      await saveText(xml, `${sanitizeFileName(project.title)}.musicxml`, 'MusicXML score', 'application/vnd.recordare.musicxml+xml', '.musicxml');
    } catch (err) {
      setResult({ kind: 'error', text: err instanceof Error ? err.message : 'Export failed.' });
    }
  };

  const exportTab = async (p: NotationPart) => {
    setResult(null);
    const tuning = p === 'bass' ? tunings.bass : tunings.guitar;
    const text = buildAsciiTab(project, p, tuning, t, settings.notation.maxFret);
    await saveText(text, `${sanitizeFileName(`${project.title} - ${partLabel(project, p)} tab`)}.txt`, 'Text tablature', 'text/plain', '.txt');
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label="MusicXML score (opens in MuseScore, Guitar Pro, Sibelius, Finale, Dorico)">
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {available.map((p) => (
            <label key={p} className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input type="checkbox" className="accent-amber-500" checked={Boolean(parts[p])} onChange={(e) => setParts({ ...parts, [p]: e.target.checked })} />
              {label(p)} <span className="text-slate-500 font-mono">({count(p)})</span>
            </label>
          ))}
        </div>
      </Field>
      <FieldGrid>
        <Toggle checked={includeTab} onChange={setIncludeTab} label="Add TAB staves for guitar and bass" hint={`Guitar: ${tunings.guitar.label} · Bass: ${tunings.bass.label}`} />
        {transpose !== 0 && <Toggle checked={applyTranspose} onChange={setApplyTranspose} label={`Apply key change (${transpose > 0 ? '+' : ''}${transpose})`} />}
      </FieldGrid>
      <div className="flex justify-end">
        <button type="button" className={primaryButtonClass} onClick={() => void exportXml()}>
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          Export MusicXML…
        </button>
      </div>
      <Field label="Text tablature (.txt)">
        <div className="flex flex-wrap gap-2">
          {tabParts.map((p) => (
            <button key={p} type="button" className={secondaryButtonClass} onClick={() => void exportTab(p)}>
              {partLabel(project, p)} tab…
            </button>
          ))}
        </div>
      </Field>
      {result && <StatusLine kind={result.kind}>{result.text}</StatusLine>}
    </div>
  );
}
