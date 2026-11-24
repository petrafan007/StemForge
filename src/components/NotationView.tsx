import { useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, FileMusic } from 'lucide-react';
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
  getStaffPosition,
  getTuningPreset,
  mapNotesToTab,
  midiToNoteName,
  type ChordVoicing,
} from '../audio/notationEngine';
import { buildMusicXml, partLabel, partNotes, resolveTunings, type TuningOptions } from '../audio/scoreExport';
import { beatToTime, quarterBeatsPerMeasure, timeToBeat } from '../audio/timeline';
import type { NotationPart } from '../types/music';
import { slugifyFilename, triggerTextDownload } from '../utils/download';

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
  const part: NotationPart = requestedPart === 'lead' && !project.stems.lead ? 'guitar' : requestedPart;
  const instrument: StringInstrument = part === 'bass' ? 'bass' : 'guitar';
  const [mode, setMode] = useState<NotationMode>('tabs');
  const [copiedTab, setCopiedTab] = useState(false);
  const sheetSvgRef = useRef<SVGSVGElement | null>(null);

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

  const transposedChords = useMemo(
    () =>
      project.chords.map((c) => ({
        ...c,
        displaySymbol: formatChordSymbol(c.rootPc, c.quality, transpose),
      })),
    [project.chords, transpose]
  );

  const uniqueChordVoicings = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ chord: ChordEvent & { displaySymbol: string }; voicing: ChordVoicing }> = [];
    for (const c of transposedChords) {
      if (seen.has(c.displaySymbol)) continue;
      seen.add(c.displaySymbol);
      list.push({
        chord: c,
        voicing: getChordVoicing(c.rootPc, c.quality, instrument, transpose),
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
    if (!sheetSvgRef.current) return;
    const svgXml = new XMLSerializer().serializeToString(sheetSvgRef.current);
    triggerTextDownload(
      svgXml,
      `${slugifyFilename(project.title)}_${part}_sheet.svg`,
      'image/svg+xml;charset=utf-8'
    );
  };

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

  // Sheet music layout constants
  const clef: 'treble' | 'bass' = instrument === 'guitar' ? 'treble' : 'bass';
  const measuresPerStaffLine = 4;
  const staffLinesCount = Math.ceil(totalMeasures / measuresPerStaffLine);
  const staffLineWidth = 1040;
  const staffRowHeight = 148;
  const clefMargin = 92;
  const measureWidth = (staffLineWidth - clefMargin - 20) / measuresPerStaffLine;
  const lineGap = 11; // pixels between adjacent staff lines

  return (
    <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 flex flex-col gap-5">
      {/* Top Workspace Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Part switcher: Guitar / Lead Guitar / Bass */}
          <div
            role="group"
            aria-label="Part selector"
            className="inline-flex items-center p-1 bg-[#13161C] border border-white/[0.08] rounded-md"
          >
            {(['guitar', 'lead', 'bass'] as NotationPart[])
              .filter((p) => p !== 'lead' || Boolean(project.stems.lead))
              .map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={part === p}
                  onClick={() => onChangePart(p)}
                  className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    part === p
                      ? p === 'bass'
                        ? 'bg-sky-400 text-[#0B0D10] font-semibold'
                        : 'bg-amber-500 text-[#0B0D10] font-semibold'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {partLabel(project, p)} ({(p === 'bass' ? resolved.bass : resolved.guitar).openMidi.length}-String)
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
            <button
              type="button"
              onClick={handleDownloadSheetSvg}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Export Score (.svg)</span>
            </button>
          )}
        </div>
      </div>

      {/* VIEW 1: INTERACTIVE TABLATURE */}
      {mode === 'tabs' && (
        <section
          aria-label={`${instrument} tablature`}
          className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden"
        >
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">
                {partName} Tablature
              </span>
              <span className="text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-slate-400">
                {tuning.label} · {tabNotes.length} notes transcribed
              </span>
            </div>
            <span className="text-slate-400">Click any fret number to audition & seek</span>
          </div>

          {tabNotes.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No pitched notes detected on the {partName.toLowerCase()} stem for this audio file.
            </div>
          ) : (
            <div className="p-4 sm:p-6 flex flex-col gap-6 overflow-x-auto studio-scroll">
              {Array.from({ length: Math.ceil(totalMeasures / 4) }).map((_, rowIdx) => {
                const startMeasure = rowIdx * 4;
                const endMeasure = Math.min(totalMeasures, startMeasure + 4);
                const measuresInRow = endMeasure - startMeasure;

                return (
                  <div
                    key={rowIdx}
                    className="min-w-[720px] grid gap-0 border-y border-white/[0.06] py-3"
                    style={{ gridTemplateColumns: `36px repeat(${measuresInRow}, minmax(0, 1fr))` }}
                  >
                    {/* String tuning labels */}
                    <div className="flex flex-col justify-between pt-5 pb-1 pr-2 border-r border-white/20">
                      {tuning.stringNames.map((name, sIdx) => (
                        <div
                          key={name + sIdx}
                          className="h-6 flex items-center justify-end font-mono text-xs font-semibold text-slate-400"
                        >
                          {name}
                        </div>
                      ))}
                    </div>

                    {/* Measures */}
                    {Array.from({ length: measuresInRow }).map((__, offset) => {
                      const m = startMeasure + offset;
                      const mStartBeat = m * beatsPerMeasure;
                      const mEndBeat = mStartBeat + beatsPerMeasure;
                      const measureNotes = tabNotes.filter(
                        (n) => n.startBeat >= mStartBeat - 0.01 && n.startBeat < mEndBeat - 0.01
                      );
                      const measureChord = transposedChords.find(
                        (c) => mStartBeat >= c.startBeat && mStartBeat < c.startBeat + c.durationBeats
                      );
                      const isPlayheadHere = currentBeat >= mStartBeat && currentBeat < mEndBeat;
                      const playheadPct = ((currentBeat - mStartBeat) / beatsPerMeasure) * 100;

                      return (
                        <div
                          key={m}
                          onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                            onSeek(beatToTime(project, mStartBeat + frac * beatsPerMeasure));
                          }}
                          className="relative border-r border-white/20 cursor-pointer hover:bg-white/[0.015]"
                        >
                          {/* Measure Header: Bar number + Chord */}
                          <div className="h-5 px-2 flex items-center justify-between text-[11px] font-mono">
                            <span className="text-slate-500">{m + 1}</span>
                            {measureChord && (
                              <span className="text-amber-400 font-semibold">
                                {measureChord.displaySymbol}
                              </span>
                            )}
                          </div>

                          {/* Horizontal string lines */}
                          <div className="relative py-1">
                            {tuning.stringNames.map((_, sIdx) => (
                              <div key={sIdx} className="h-6 flex items-center relative">
                                <div className="w-full h-px bg-white/15" />
                              </div>
                            ))}

                            {/* Fret numbers placed accurately along measure timeline */}
                            {measureNotes.map((note) => {
                              const leftPct = Math.max(
                                4,
                                Math.min(92, ((note.startBeat - mStartBeat) / beatsPerMeasure) * 100)
                              );
                              const isNow =
                                currentBeat >= note.startBeat &&
                                currentBeat <= note.startBeat + Math.max(0.35, note.durationBeats);

                              return (
                                <button
                                  key={note.id}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onPreviewNote(note.midi, 0.4);
                                    onSeek(beatToTime(project, note.startBeat));
                                  }}
                                  title={`${midiToNoteName(note.midi)} · String ${tuning.stringNames[note.stringIndex]} · Fret ${note.fret}`}
                                  aria-label={`Fret ${note.fret} on string ${tuning.stringNames[note.stringIndex]} at measure ${m + 1}`}
                                  style={{
                                    left: `${leftPct}%`,
                                    top: `${4 + note.stringIndex * 24 + 2}px`,
                                  }}
                                  className={`absolute -translate-x-1/2 min-w-[20px] h-5 px-1 rounded text-[11px] font-mono font-bold flex items-center justify-center transition-colors cursor-pointer ${
                                    isNow
                                      ? 'bg-amber-500 text-[#0B0D10]'
                                      : instrument === 'guitar'
                                        ? 'bg-[#1B1F27] text-amber-300 border border-amber-500/40 hover:bg-amber-500 hover:text-[#0B0D10]'
                                        : 'bg-[#1B1F27] text-sky-300 border border-sky-400/40 hover:bg-sky-400 hover:text-[#0B0D10]'
                                  }`}
                                >
                                  {note.fret}
                                </button>
                              );
                            })}

                            {/* Playhead indicator inside active measure */}
                            {isPlayheadHere && (
                              <div
                                aria-hidden="true"
                                style={{ left: `${playheadPct}%` }}
                                className="absolute top-0 bottom-0 w-0.5 bg-amber-500 pointer-events-none"
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
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
                  active={activeChord?.displaySymbol === voicing.symbol}
                  onClick={() => auditionChord(chord.rootPc, chord.quality)}
                />
              ))}
            </div>
          </section>
        </div>
      )}

      {/* VIEW 3: STANDARD SHEET MUSIC (SVG TREBLE / BASS CLEF STAFF) */}
      {mode === 'sheet' && (
        <section
          aria-label={`${instrument} standard sheet music`}
          className="border border-white/[0.08] rounded-lg bg-[#13161C] overflow-hidden"
        >
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">
                {instrument === 'guitar'
                  ? 'Guitar Sheet Music (Treble Clef)'
                  : 'Bass Sheet Music (Bass Clef)'}
              </span>
              <span className="text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="font-mono text-slate-400">
                {project.timeSignature[0]}/{project.timeSignature[1]} · {project.bpm} BPM
              </span>
            </div>
            <span className="text-slate-400">Click any notehead to hear pitch</span>
          </div>

          <div className="p-4 sm:p-6 overflow-x-auto studio-scroll bg-[#0E1015]">
            <svg
              ref={sheetSvgRef}
              width={staffLineWidth}
              height={staffLinesCount * staffRowHeight + 30}
              viewBox={`0 0 ${staffLineWidth} ${staffLinesCount * staffRowHeight + 30}`}
              className="block mx-auto bg-[#F8FAFC] text-slate-900 rounded-md shadow-sm"
            >
              {/* Title on engraved sheet */}
              <text
                x={staffLineWidth / 2}
                y={24}
                textAnchor="middle"
                fill="#0F172A"
                fontSize={15}
                fontWeight={700}
                fontFamily="Plus Jakarta Sans, sans-serif"
              >
                {project.title} — {partName} Score
              </text>

              {Array.from({ length: staffLinesCount }).map((_, sysIdx) => {
                const baseTop = 62 + sysIdx * staffRowHeight;
                const bottomLineY = baseTop + 4 * lineGap;
                const startM = sysIdx * measuresPerStaffLine;
                const endM = Math.min(totalMeasures, startM + measuresPerStaffLine);
                const countM = endM - startM;

                return (
                  <g key={sysIdx}>
                    {/* 5 Horizontal Staff Lines */}
                    {[0, 1, 2, 3, 4].map((lineIdx) => (
                      <line
                        key={lineIdx}
                        x1={24}
                        y1={baseTop + lineIdx * lineGap}
                        x2={clefMargin + countM * measureWidth}
                        y2={baseTop + lineIdx * lineGap}
                        stroke="#334155"
                        strokeWidth={1}
                      />
                    ))}

                    {/* Left system barline */}
                    <line
                      x1={24}
                      y1={baseTop}
                      x2={24}
                      y2={bottomLineY}
                      stroke="#0F172A"
                      strokeWidth={1.6}
                    />

                    {/* Clef Symbol */}
                    <text
                      x={30}
                      y={clef === 'treble' ? baseTop + 36 : baseTop + 31}
                      fill="#0F172A"
                      fontSize={clef === 'treble' ? 40 : 34}
                      fontFamily="Georgia, serif"
                    >
                      {clef === 'treble' ? '𝄞' : '𝄢'}
                    </text>

                    {/* Time signature on first system */}
                    {sysIdx === 0 && (
                      <g
                        fontFamily="Plus Jakarta Sans, sans-serif"
                        fontWeight={700}
                        fontSize={14}
                        fill="#0F172A"
                      >
                        <text x={70} y={baseTop + 17} textAnchor="middle">
                          {project.timeSignature[0]}
                        </text>
                        <text x={70} y={baseTop + 39} textAnchor="middle">
                          {project.timeSignature[1]}
                        </text>
                      </g>
                    )}

                    {/* Measures in this system */}
                    {Array.from({ length: countM }).map((__, offset) => {
                      const m = startM + offset;
                      const mX = clefMargin + offset * measureWidth;
                      const mStartBeat = m * beatsPerMeasure;
                      const mEndBeat = mStartBeat + beatsPerMeasure;

                      const mNotes = tabNotes.filter(
                        (n) => n.startBeat >= mStartBeat - 0.01 && n.startBeat < mEndBeat - 0.01
                      );
                      const mChord = transposedChords.find(
                        (c) => mStartBeat >= c.startBeat && mStartBeat < c.startBeat + c.durationBeats
                      );
                      const isPlayheadHere = currentBeat >= mStartBeat && currentBeat < mEndBeat;
                      const playheadX =
                        mX + 12 + ((currentBeat - mStartBeat) / beatsPerMeasure) * (measureWidth - 24);

                      return (
                        <g key={m}>
                          {/* Barline at right edge of measure */}
                          <line
                            x1={mX + measureWidth}
                            y1={baseTop}
                            x2={mX + measureWidth}
                            y2={bottomLineY}
                            stroke="#0F172A"
                            strokeWidth={m === totalMeasures - 1 ? 2.5 : 1.1}
                          />

                          {/* Measure number & Chord symbol above staff */}
                          <text
                            x={mX + 4}
                            y={baseTop - 16}
                            fill="#64748B"
                            fontSize={10}
                            fontFamily="JetBrains Mono, monospace"
                          >
                            {m + 1}
                          </text>
                          {mChord && (
                            <text
                              x={mX + 26}
                              y={baseTop - 15}
                              fill="#B45309"
                              fontSize={12}
                              fontWeight={700}
                              fontFamily="Plus Jakarta Sans, sans-serif"
                            >
                              {mChord.displaySymbol}
                            </text>
                          )}

                          {/* Notes */}
                          {mNotes.map((note) => {
                            const pos = getStaffPosition(note.midi, clef);
                            const noteX =
                              mX +
                              18 +
                              ((note.startBeat - mStartBeat) / beatsPerMeasure) *
                                (measureWidth - 32);
                            const noteY = bottomLineY - pos.lineOffsetFromBottom * lineGap;
                            const isOpenHead = note.durationBeats >= 1.75;
                            const isEighth = note.durationBeats <= 0.6;
                            const stemDown = pos.lineOffsetFromBottom >= 2;
                            const isActive =
                              currentBeat >= note.startBeat &&
                              currentBeat <= note.startBeat + Math.max(0.35, note.durationBeats);

                            // Ledger lines above or below staff
                            const ledgers: number[] = [];
                            if (pos.lineOffsetFromBottom < -0.5) {
                              for (let l = -1; l >= Math.ceil(pos.lineOffsetFromBottom); l--) {
                                ledgers.push(bottomLineY - l * lineGap);
                              }
                            } else if (pos.lineOffsetFromBottom > 4.5) {
                              for (let l = 5; l <= Math.floor(pos.lineOffsetFromBottom); l++) {
                                ledgers.push(bottomLineY - l * lineGap);
                              }
                            }

                            const noteColor = isActive ? '#D97706' : '#0F172A';

                            return (
                              <g
                                key={note.id}
                                className="cursor-pointer"
                                onClick={() => {
                                  onPreviewNote(note.midi, 0.4);
                                  onSeek(beatToTime(project, note.startBeat));
                                }}
                              >
                                {ledgers.map((ly, idx) => (
                                  <line
                                    key={idx}
                                    x1={noteX - 10}
                                    y1={ly}
                                    x2={noteX + 10}
                                    y2={ly}
                                    stroke="#475569"
                                    strokeWidth={1}
                                  />
                                ))}

                                {pos.accidental && (
                                  <text
                                    x={noteX - 14}
                                    y={noteY + 4}
                                    fill={noteColor}
                                    fontSize={12}
                                    fontWeight={700}
                                    fontFamily="Georgia, serif"
                                  >
                                    ♯
                                  </text>
                                )}

                                <ellipse
                                  cx={noteX}
                                  cy={noteY}
                                  rx={5.2}
                                  ry={3.8}
                                  transform={`rotate(-18 ${noteX} ${noteY})`}
                                  fill={isOpenHead ? '#F8FAFC' : noteColor}
                                  stroke={noteColor}
                                  strokeWidth={1.6}
                                />

                                {/* Stem */}
                                <line
                                  x1={stemDown ? noteX - 4.8 : noteX + 4.8}
                                  y1={noteY}
                                  x2={stemDown ? noteX - 4.8 : noteX + 4.8}
                                  y2={stemDown ? noteY + 28 : noteY - 28}
                                  stroke={noteColor}
                                  strokeWidth={1.3}
                                />

                                {/* Eighth note flag */}
                                {isEighth && (
                                  <path
                                    d={
                                      stemDown
                                        ? `M ${noteX - 4.8} ${noteY + 28} Q ${noteX + 4} ${noteY + 22} ${noteX + 2} ${noteY + 14}`
                                        : `M ${noteX + 4.8} ${noteY - 28} Q ${noteX + 13} ${noteY - 22} ${noteX + 11} ${noteY - 14}`
                                    }
                                    fill="none"
                                    stroke={noteColor}
                                    strokeWidth={1.5}
                                  />
                                )}
                              </g>
                            );
                          })}

                          {/* Synchronized Playhead on Staff */}
                          {isPlayheadHere && (
                            <line
                              x1={playheadX}
                              y1={baseTop - 10}
                              x2={playheadX}
                              y2={bottomLineY + 10}
                              stroke="#D97706"
                              strokeWidth={2}
                            />
                          )}
                        </g>
                      );
                    })}
                  </g>
                );
              })}
            </svg>
          </div>
        </section>
      )}
    </div>
  );
}
