import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileMusic, Minus, Plus, Printer } from 'lucide-react';
import type {
  BassTuningId,
  ChordEvent,
  GuitarTuningId,
  MidiNoteEvent,
  NotationMode,
  SongProject,
  StringInstrument,
  TabNoteEvent,
} from '../types/music';
import {
  BASS_TUNINGS,
  GUITAR_TUNINGS,
  formatChordSymbol,
  generateAsciiTab,
  getChordVoicing,
  mapNotesToTab,
  midiToNoteName,
  type ChordVoicing,
} from '../audio/notationEngine';
import { buildMusicXml, notationParts, partLabel, partNotes, resolveTunings, type TuningOptions } from '../audio/scoreExport';
import { beatToTime, quarterBeatsPerMeasure, timeToBeat } from '../audio/timeline';
import type { NotationPart } from '../types/music';
import { slugifyFilename, triggerTextDownload } from '../utils/download';
import { layoutTab, type TabLayoutNote } from '../audio/tabLayout';
import { keyToFifths } from '../audio/musicXml';
import { TabStaff } from './TabStaff';
import { ScoreView, printScore } from './ScoreView';

type TabDetail = '1/8' | '1/16' | '1/32' | '1/8T' | '1/16T';
const DETAIL_GRID: Record<TabDetail, number> = { '1/8': 0.5, '1/16': 0.25, '1/32': 0.125, '1/8T': 1 / 3, '1/16T': 1 / 6 };
const PREFS_KEY = 'stemforge_notation_view_v1';

interface ViewPrefs {
  detail: TabDetail;
  colWidth: number;
  follow: boolean;
  sustain: boolean;
  minVelocity: number;
  sheetZoom: number;
  sheetTab: boolean;
}

const DEFAULT_PREFS: ViewPrefs = { detail: '1/16', colWidth: 22, follow: true, sustain: true, minVelocity: 0, sheetZoom: 0.9, sheetTab: true };

function loadPrefs(): ViewPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

interface NotationViewProps {
  project: SongProject;
  currentTime: number;
  transpose: number;
  onSeek: (timeSec: number) => void;
  onPreviewNote: (midi: number, durationSec?: number) => void;
  onPreviewChord: (midis: number[]) => void;
  part: NotationPart;
  onChangePart: (part: NotationPart) => void;
  guitarTuning: GuitarTuningId | 'auto';
  bassTuning: BassTuningId | 'auto';
  onChangeGuitarTuning: (t: GuitarTuningId | 'auto') => void;
  onChangeBassTuning: (t: BassTuningId | 'auto') => void;
  tuningOptions: TuningOptions;
  maxFret: number;
  accidentals: 'auto' | 'sharps' | 'flats';
  onOpenExport?: () => void;
}

function ChordFretboardDiagram({
  voicing,
  instrument,
  active,
  onClick,
}: {
  voicing: ChordVoicing;
  instrument: StringInstrument;
  active: boolean;
  onClick: () => void;
}) {
  const numStrings = instrument === 'guitar' ? 6 : 4;
  const fretsToShow = 4;
  const width = 128;
  const height = 148;
  const padX = 24;
  const padTop = 34;
  const gridW = width - padX * 2;
  const gridH = 88;
  const stringSpacing = gridW / (numStrings - 1);
  const fretSpacing = gridH / fretsToShow;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Audition ${voicing.symbol} ${instrument} diagram`}
      className={`p-3 rounded-lg border text-left transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 ${
        active
          ? 'bg-amber-500/12 border-amber-500/60'
          : 'bg-[#13161C] border-white/[0.08] hover:border-white/25 hover:bg-[#181C24]'
      }`}
    >
      <div className="flex items-baseline justify-between mb-1">
        <span className={`font-display text-sm font-bold ${active ? 'text-amber-300' : 'text-white'}`}>
          {voicing.symbol}
        </span>
        {voicing.baseFret > 1 && (
          <span className="font-mono text-[10px] text-slate-400">{voicing.baseFret}fr</span>
        )}
      </div>

      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block mx-auto">
        {/* Nut or top fret line */}
        <line
          x1={padX}
          y1={padTop}
          x2={padX + gridW}
          y2={padTop}
          stroke={voicing.baseFret === 1 ? '#E2E8F0' : 'rgba(255,255,255,0.28)'}
          strokeWidth={voicing.baseFret === 1 ? 3.5 : 1.2}
        />

        {/* Horizontal frets */}
        {Array.from({ length: fretsToShow }).map((_, i) => {
          const y = padTop + (i + 1) * fretSpacing;
          return (
            <line
              key={i}
              x1={padX}
              y1={y}
              x2={padX + gridW}
              y2={y}
              stroke="rgba(255,255,255,0.16)"
              strokeWidth={1}
            />
          );
        })}

        {/* Vertical strings */}
        {Array.from({ length: numStrings }).map((_, s) => {
          const x = padX + s * stringSpacing;
          const fret = voicing.frets[s] ?? -1;
          const relFret = fret > 0 ? fret - voicing.baseFret + 1 : fret;

          return (
            <g key={s}>
              <line
                x1={x}
                y1={padTop}
                x2={x}
                y2={padTop + gridH}
                stroke="rgba(255,255,255,0.28)"
                strokeWidth={1 + (numStrings - 1 - s) * 0.18}
              />

              {/* Muted X or Open O indicator above nut */}
              {fret === -1 && (
                <text
                  x={x}
                  y={padTop - 10}
                  textAnchor="middle"
                  fill="#64748B"
                  fontSize={10}
                  fontFamily="JetBrains Mono, monospace"
                >
                  x
                </text>
              )}
              {fret === 0 && (
                <circle
                  cx={x}
                  cy={padTop - 13}
                  r={3.5}
                  fill="none"
                  stroke="#94A3B8"
                  strokeWidth={1.3}
                />
              )}

              {/* Finger dot */}
              {relFret >= 1 && relFret <= fretsToShow && (
                <circle
                  cx={x}
                  cy={padTop + (relFret - 0.5) * fretSpacing}
                  r={5.5}
                  fill={active ? '#F59E0B' : instrument === 'guitar' ? '#F59E0B' : '#38BDF8'}
                />
              )}
            </g>
          );
        })}

        {/* String labels at bottom */}
        {(instrument === 'guitar' ? ['E', 'A', 'D', 'G', 'B', 'e'] : ['E', 'A', 'D', 'G']).map(
          (name, idx) => (
            <text
              key={name + idx}
              x={padX + idx * stringSpacing}
              y={padTop + gridH + 16}
              textAnchor="middle"
              fill="#64748B"
              fontSize={9}
              fontFamily="JetBrains Mono, monospace"
            >
              {name}
            </text>
          )
        )}
      </svg>
    </button>
  );
}

export function NotationView({
  project,
  currentTime,
  transpose,
  onSeek,
  onPreviewNote,
  onPreviewChord,
  part: requestedPart,
  onChangePart,
  guitarTuning,
  bassTuning,
  onChangeGuitarTuning,
  onChangeBassTuning,
  tuningOptions,
  maxFret,
  accidentals,
  onOpenExport,
}: NotationViewProps) {
  const availableParts = notationParts(project);
  const part: NotationPart = availableParts.includes(requestedPart) ? requestedPart : 'guitar';
  const instrument: StringInstrument = part === 'bass' ? 'bass' : 'guitar';
  const [mode, setMode] = useState<NotationMode>('tabs');
  const [copiedTab, setCopiedTab] = useState(false);
  const [prefs, setPrefsState] = useState<ViewPrefs>(loadPrefs);
  const setPrefs = (patch: Partial<ViewPrefs>) =>
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  const scoreApi = useRef<{ svgMarkup: () => string | null } | null>(null);
  const tabWrapRef = useRef<HTMLDivElement | null>(null);
  const [tabWidth, setTabWidth] = useState(1100);

  useEffect(() => {
    const el = tabWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setTabWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  const resolved = useMemo(
    () => resolveTunings(project, { guitar: guitarTuning, bass: bassTuning }, tuningOptions, transpose),
    [project, guitarTuning, bassTuning, tuningOptions, transpose]
  );
  const tuning = instrument === 'bass' ? resolved.bass : resolved.guitar;
  const partName = partLabel(project, part);

  const rawNotes = partNotes(project, part);

  const tabNotes: TabNoteEvent[] = useMemo(
    () => mapNotesToTab(rawNotes, tuning, transpose, maxFret),
    [rawNotes, tuning, transpose, maxFret]
  );

  // Spell chord names like the key signature (flat keys -> Db, Eb...), or as chosen in Settings
  const useFlats =
    accidentals === 'flats' || (accidentals === 'auto' && keyToFifths((((project.keyRootPc + transpose) % 12) + 12) % 12, project.keyMode) < 0);
  const transposedChords = useMemo(
    () =>
      project.chords.map((c) => ({
        ...c,
        displaySymbol: formatChordSymbol(c.rootPc, c.quality, transpose, useFlats),
      })),
    [project.chords, transpose, useFlats]
  );

  const uniqueChordVoicings = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ chord: ChordEvent & { displaySymbol: string }; voicing: ChordVoicing }> = [];
    for (const c of transposedChords) {
      if (seen.has(c.displaySymbol)) continue;
      seen.add(c.displaySymbol);
      list.push({
        chord: c,
        voicing: { ...getChordVoicing(c.rootPc, c.quality, instrument, transpose), symbol: c.displaySymbol },
      });
    }
    return list;
  }, [transposedChords, instrument, transpose]);

  const currentBeat = timeToBeat(project, currentTime);
  const beatsPerMeasure = quarterBeatsPerMeasure(project.timeSignature);
  const totalBeats = Math.max(beatsPerMeasure * 2, Math.ceil(timeToBeat(project, project.duration)));
  const totalMeasures = Math.ceil(totalBeats / beatsPerMeasure);

  const activeChord = transposedChords.find(
    (c) => currentBeat >= c.startBeat && currentBeat < c.startBeat + c.durationBeats
  );

  const handleCopyAsciiTab = async () => {
    const ascii = generateAsciiTab(tabNotes, tuning, `${project.title} (${partName})`, project.bpm, Math.round(beatsPerMeasure));
    try {
      await navigator.clipboard.writeText(ascii);
    } catch {
      // Fallback ignored in restricted clipboard environments
    }
    setCopiedTab(true);
    window.setTimeout(() => setCopiedTab(false), 2500);
  };

  const handleDownloadTab = () => {
    const ascii = generateAsciiTab(tabNotes, tuning, `${project.title} (${partName})`, project.bpm, Math.round(beatsPerMeasure));
    triggerTextDownload(ascii, `${slugifyFilename(project.title)}_${part}_tab.txt`);
  };

  const handleDownloadSheetSvg = () => {
    const markup = scoreApi.current?.svgMarkup();
    if (!markup) return;
    triggerTextDownload(markup, `${slugifyFilename(project.title)}_${part}_sheet.svg`, 'image/svg+xml;charset=utf-8');
  };

  const sheetXml = useMemo(
    () =>
      mode === 'sheet'
        ? buildMusicXml(project, { parts: [part], includeTab: prefs.sheetTab, transpose, tunings: resolved, maxFret, accidentals })
        : '',
    [mode, project, part, prefs.sheetTab, transpose, resolved, maxFret, accidentals]
  );

  const tabLayout = useMemo(
    () =>
      layoutTab(tabNotes, {
        grid: DETAIL_GRID[prefs.detail],
        colWidth: prefs.colWidth,
        beatsPerMeasure,
        totalBeats,
        containerWidth: tabWidth,
        strings: tuning.openMidi.length,
        minVelocity: prefs.minVelocity,
        chords: transposedChords.map((c) => ({ startBeat: c.startBeat, symbol: c.displaySymbol })),
      }),
    [tabNotes, prefs.detail, prefs.colWidth, prefs.minVelocity, beatsPerMeasure, totalBeats, tabWidth, tuning, transposedChords]
  );

  const handleTabNoteClick = useCallback(
    (n: TabLayoutNote) => {
      onPreviewNote(n.midi, 0.4);
      onSeek(Math.max(0, beatToTime(project, n.col * DETAIL_GRID[prefs.detail])));
    },
    [onPreviewNote, onSeek, project, prefs.detail]
  );
  const handleSeekBeat = useCallback((beat: number) => onSeek(Math.max(0, beatToTime(project, beat))), [onSeek, project]);

  /**
   * Exports MusicXML for MuseScore / Guitar Pro / Sibelius etc.
   * 'instrument' = the selected guitar or bass (notation + TAB staff);
   * 'score' = full band score: Vocals, Guitar (+TAB), Bass (+TAB), Keyboards (grand staff).
   */
  const handleDownloadMusicXml = (scope: 'instrument' | 'score') => {
    const xml = buildMusicXml(project, {
      parts: scope === 'instrument' ? [part] : ['vocals', 'guitar', 'lead', 'bass', 'keyboards'],
      includeTab: true,
      transpose,
      tunings: resolved,
      maxFret,
      accidentals,
    });
    const suffix = scope === 'instrument' ? part : 'full_score';
    triggerTextDownload(
      xml,
      `${slugifyFilename(project.title)}_${suffix}.musicxml`,
      'application/vnd.recordare.musicxml+xml;charset=utf-8'
    );
  };

  const auditionChord = (rootPc: number, quality: ChordEvent['quality']) => {
    const baseMidi = instrument === 'guitar' ? 48 + rootPc : 36 + rootPc;
    const intervals =
      quality === 'min'
        ? [0, 3, 7, 12]
        : quality === 'm7'
          ? [0, 3, 7, 10]
          : quality === 'maj7'
            ? [0, 4, 7, 11]
            : quality === '7'
              ? [0, 4, 7, 10]
              : [0, 4, 7, 12];
    onPreviewChord(intervals.map((i) => baseMidi + i));
  };

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      {/* Top Workspace Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Part switcher: (Rhythm) Guitar / Guitar 1 – Left / Guitar 2 – Right / Lead Guitar / Bass */}
          <div
            role="group"
            aria-label="Part selector"
            className="inline-flex flex-wrap items-center p-1 bg-[#13161C] border border-white/[0.08] rounded-md"
          >
            {availableParts.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={part === p}
                onClick={() => onChangePart(p)}
                title={
                  p === 'guitar1' || p === 'guitar2'
                    ? `The ${p === 'guitar1' ? 'left' : 'right'}-panned guitar on its own. Where both guitars play the same riff it matches the ${partLabel(project, 'guitar')} tab.`
                    : undefined
                }
                className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  part === p
                    ? p === 'bass'
                      ? 'bg-sky-400 text-[#0B0D10] font-semibold'
                      : 'bg-amber-500 text-[#0B0D10] font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {p === 'guitar1'
                  ? 'Guitar 1 – Left'
                  : p === 'guitar2'
                    ? 'Guitar 2 – Right'
                    : `${partLabel(project, p)} (${(p === 'bass' ? resolved.bass : resolved.guitar).openMidi.length}-String)`}
              </button>
            ))}
          </div>

          {/* Notation Mode Switcher: Tabs / Chords / Sheet Music */}
          <div
            role="tablist"
            aria-label="Notation display mode"
            className="inline-flex items-center p-1 bg-[#13161C] border border-white/[0.08] rounded-md"
          >
            {(
              [
                { id: 'tabs', label: 'Tablature' },
                { id: 'chords', label: 'Chords' },
                { id: 'sheet', label: 'Sheet Music' },
              ] as Array<{ id: NotationMode; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={mode === tab.id}
                onClick={() => setMode(tab.id)}
                className={`px-3.5 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer ${
                  mode === tab.id
                    ? 'bg-white/20 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tuning selector (Auto = detected from the notes) */}
          {(mode === 'tabs' || mode === 'sheet') && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <span>Tuning</span>
              {instrument === 'guitar' ? (
                <select
                  aria-label="Guitar tuning"
                  value={guitarTuning}
                  onChange={(e) => onChangeGuitarTuning(e.target.value as GuitarTuningId | 'auto')}
                  className="h-8 px-2.5 rounded bg-[#13161C] border border-white/[0.08] text-xs font-mono text-slate-200 cursor-pointer"
                >
                  <option value="auto" className="bg-[#13161C]">
                    Auto — detected {resolved.detectedGuitar.label}
                  </option>
                  {Object.values(GUITAR_TUNINGS).map((t) => (
                    <option key={t.id} value={t.id} className="bg-[#13161C]">
                      {t.label}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  aria-label="Bass tuning"
                  value={bassTuning}
                  onChange={(e) => onChangeBassTuning(e.target.value as BassTuningId | 'auto')}
                  className="h-8 px-2.5 rounded bg-[#13161C] border border-white/[0.08] text-xs font-mono text-slate-200 cursor-pointer"
                >
                  <option value="auto" className="bg-[#13161C]">
                    Auto — detected {resolved.detectedBass.label}
                  </option>
                  {Object.values(BASS_TUNINGS).map((t) => (
                    <option key={t.id} value={t.id} className="bg-[#13161C]">
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
        </div>

        {/* Mode-specific Export Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {(mode === 'tabs' || mode === 'sheet') && (
            <>
              <button
                type="button"
                onClick={() => handleDownloadMusicXml('instrument')}
                title="Open in MuseScore, Guitar Pro, Sibelius, etc. (standard notation + TAB staff)"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileMusic className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{partName} MusicXML</span>
              </button>
              <button
                type="button"
                onClick={() => handleDownloadMusicXml('score')}
                title="Vocals, Guitar + TAB, Bass + TAB and Keyboards in one MusicXML score"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <FileMusic className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Full Score MusicXML</span>
              </button>
              {onOpenExport && (
                <button
                  type="button"
                  onClick={onOpenExport}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  More export options…
                </button>
              )}
            </>
          )}
          {mode === 'tabs' && (
            <>
              <button
                type="button"
                onClick={handleCopyAsciiTab}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedTab ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>Copied ASCII Tab</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Copy ASCII Tab</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleDownloadTab}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Export .txt Tab</span>
              </button>
            </>
          )}

          {mode === 'sheet' && (
            <>
              <button
                type="button"
                onClick={() => void printScore(sheetXml, `${project.title} — ${partName}`)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Printer className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Print / Save PDF</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadSheetSvg}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-[#13161C] hover:bg-[#1B1F27] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" />
                <span>.svg</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* VIEW 1: INTERACTIVE TABLATURE (grid-based, no overlaps) */}
      {mode === 'tabs' && (
        <section aria-label={`${partName} tablature`} className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">{partName} Tablature</span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono text-slate-400">
                {tuning.label} · {tabLayout.noteCount} notes
                {tabLayout.mergedCount > 0 ? ` (${tabLayout.mergedCount} duplicates merged)` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-slate-400">
              <label className="flex items-center gap-1.5">
                <span>Detail</span>
                <select
                  aria-label="Tab rhythmic detail"
                  value={prefs.detail}
                  onChange={(e) => setPrefs({ detail: e.target.value as TabDetail })}
                  className="h-7 px-2 rounded bg-[#0B0D10] border border-white/[0.1] font-mono text-slate-200 cursor-pointer"
                >
                  <option value="1/8">1/8 notes</option>
                  <option value="1/16">1/16 notes</option>
                  <option value="1/32">1/32 notes</option>
                  <option value="1/8T">1/8 triplets</option>
                  <option value="1/16T">1/16 triplets</option>
                </select>
              </label>
              <div className="flex items-center gap-1" role="group" aria-label="Tab zoom">
                <span className="mr-0.5">Zoom</span>
                <button type="button" aria-label="Zoom out" onClick={() => setPrefs({ colWidth: Math.max(16, prefs.colWidth - 3) })} className="w-6 h-6 inline-flex items-center justify-center rounded bg-[#0B0D10] border border-white/[0.1] hover:text-white cursor-pointer">
                  <Minus className="w-3 h-3" aria-hidden="true" />
                </button>
                <button type="button" aria-label="Zoom in" onClick={() => setPrefs({ colWidth: Math.min(40, prefs.colWidth + 3) })} className="w-6 h-6 inline-flex items-center justify-center rounded bg-[#0B0D10] border border-white/[0.1] hover:text-white cursor-pointer">
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
              <label className="flex items-center gap-1.5" title="Hide very soft notes (usually ghost notes or bleed)">
                <span>Hide soft notes</span>
                <input type="range" min={0} max={90} step={5} value={prefs.minVelocity} onChange={(e) => setPrefs({ minVelocity: Number(e.target.value) })} className="studio-fader w-20" aria-label="Hide notes softer than" />
                <span className="font-mono w-6 text-slate-300">{prefs.minVelocity}</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className="accent-amber-500" checked={prefs.sustain} onChange={(e) => setPrefs({ sustain: e.target.checked })} />
                <span>Sustain</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className="accent-amber-500" checked={prefs.follow} onChange={(e) => setPrefs({ follow: e.target.checked })} />
                <span>Follow playback</span>
              </label>
            </div>
          </div>

          {tabNotes.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No pitched notes detected on the {partName.toLowerCase()} stem for this audio file.
            </div>
          ) : (
            <div ref={tabWrapRef} className="px-3 sm:px-5 py-4 overflow-x-auto studio-scroll">
              <TabStaff
                layout={tabLayout}
                tuning={tuning}
                instrument={instrument}
                showSustain={prefs.sustain}
                currentBeat={currentBeat}
                follow={prefs.follow}
                onNoteClick={handleTabNoteClick}
                onSeekBeat={handleSeekBeat}
              />
              <p className="mt-2 text-[11px] text-slate-500">
                Click a fret number to hear it and jump there · click anywhere in a bar to seek · notes snap to the {prefs.detail} grid
              </p>
            </div>
          )}
        </section>
      )}

      {/* VIEW 2: CHORDS & FRETBOARD DIAGRAMS */}
      {mode === 'chords' && (
        <div className="flex flex-col gap-6">
          {/* Chord Progression Timeline */}
          <section
            aria-label="Chord progression timeline"
            className="border border-white/[0.08] rounded-lg bg-[#13161C] p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Chord Progression</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Click any measure to jump playback and audition the chord
                </p>
              </div>
              {activeChord && (
                <div className="font-mono text-xs text-slate-400">
                  Now Playing:{' '}
                  <span className="text-amber-400 font-semibold text-sm">
                    {activeChord.displaySymbol}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
              {transposedChords.map((chord, idx) => {
                const isNow =
                  currentBeat >= chord.startBeat &&
                  currentBeat < chord.startBeat + chord.durationBeats;
                return (
                  <button
                    key={chord.id}
                    type="button"
                    onClick={() => {
                      onSeek(beatToTime(project, chord.startBeat));
                      auditionChord(chord.rootPc, chord.quality);
                    }}
                    className={`p-3 rounded-md border text-left transition-colors cursor-pointer ${
                      isNow
                        ? 'bg-amber-500/18 border-amber-500 text-white'
                        : 'bg-[#0E1015] border-white/[0.08] hover:border-white/25 text-slate-200'
                    }`}
                  >
                    <div className="text-[10px] font-mono text-slate-500">Bar {idx + 1}</div>
                    <div
                      className={`font-display text-lg font-bold mt-0.5 ${
                        isNow ? 'text-amber-300' : 'text-white'
                      }`}
                    >
                      {chord.displaySymbol}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Fretboard Chord / Bass Box Diagrams */}
          <section aria-label={`${instrument} fretboard diagrams`}>
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">
                {instrument === 'guitar'
                  ? 'Guitar Chord Diagrams (6-String)'
                  : 'Bass Root & Arpeggio Fretboard Shapes (4-String)'}
              </h2>
              <span className="text-xs font-mono text-slate-400">
                {uniqueChordVoicings.length}{' '}
                {uniqueChordVoicings.length === 1 ? 'unique voicing' : 'unique voicings'}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {uniqueChordVoicings.map(({ chord, voicing }) => (
                <ChordFretboardDiagram
                  key={voicing.symbol}
                  voicing={voicing}
                  instrument={instrument}
                  active={activeChord?.displaySymbol === chord.displaySymbol}
                  onClick={() => auditionChord(chord.rootPc, chord.quality)}
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {/* VIEW 3: ENGRAVED SHEET MUSIC (OpenSheetMusicDisplay) */}
      {mode === 'sheet' && (
        <section aria-label={`${partName} sheet music`} className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-x-5 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">{partName} Score</span>
              <span className="text-slate-600" aria-hidden="true">·</span>
              <span className="font-mono text-slate-400">
                {project.timeSignature[0]}/{project.timeSignature[1]} · {Math.round(project.bpm)} BPM · {tuning.label}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-slate-400">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className="accent-amber-500" checked={prefs.sheetTab} onChange={(e) => setPrefs({ sheetTab: e.target.checked })} />
                <span>TAB staff</span>
              </label>
              <div className="flex items-center gap-1" role="group" aria-label="Score zoom">
                <span className="mr-0.5">Zoom</span>
                <button type="button" aria-label="Zoom out" onClick={() => setPrefs({ sheetZoom: Math.max(0.5, Math.round((prefs.sheetZoom - 0.1) * 10) / 10) })} className="w-6 h-6 inline-flex items-center justify-center rounded bg-[#0B0D10] border border-white/[0.1] hover:text-white cursor-pointer">
                  <Minus className="w-3 h-3" aria-hidden="true" />
                </button>
                <span className="font-mono w-9 text-center text-slate-300">{Math.round(prefs.sheetZoom * 100)}%</span>
                <button type="button" aria-label="Zoom in" onClick={() => setPrefs({ sheetZoom: Math.min(1.6, Math.round((prefs.sheetZoom + 0.1) * 10) / 10) })} className="w-6 h-6 inline-flex items-center justify-center rounded bg-[#0B0D10] border border-white/[0.1] hover:text-white cursor-pointer">
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className="accent-amber-500" checked={prefs.follow} onChange={(e) => setPrefs({ follow: e.target.checked })} />
                <span>Follow playback</span>
              </label>
            </div>
          </div>
          {rawNotes.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">No pitched notes detected on the {partName.toLowerCase()} stem.</div>
          ) : (
            <div className="p-3 sm:p-5 bg-[#0E1015]">
              <ScoreView
                xml={sheetXml}
                zoom={prefs.sheetZoom}
                beatsPerMeasure={beatsPerMeasure}
                currentBeat={currentBeat}
                follow={prefs.follow}
                onSeekBeat={handleSeekBeat}
                onReady={(api) => (scoreApi.current = api)}
              />
              <p className="mt-2 text-[11px] text-slate-500">Click a bar to jump there · notes are quantized to 16ths · chord symbols above the staff</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
