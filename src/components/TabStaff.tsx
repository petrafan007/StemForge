import { memo, useEffect, useMemo, useRef } from 'react';
import type { TuningPreset } from '../audio/notationEngine';
import { midiToNoteName } from '../audio/notationEngine';
import { scrollWindowTo } from '../utils/scroll';
import { beatX, locateBeat, type TabLayout, type TabLayoutNote, type TabLayoutRow } from '../audio/tabLayout';

/**
 * Renders a grid-based tablature layout as SVG rows. The heavy static part is memoized; only the
 * small playhead overlay re-renders while the song plays.
 */

interface Palette {
  text: string;
  sustain: string;
  active: string;
}

const PALETTES: Record<'guitar' | 'bass', Palette> = {
  guitar: { text: '#FCD34D', sustain: 'rgba(245,158,11,0.35)', active: '#F59E0B' },
  bass: { text: '#7DD3FC', sustain: 'rgba(56,189,248,0.35)', active: '#38BDF8' },
};

const ROW_BG = '#13161C';

interface TabStaffProps {
  layout: TabLayout;
  tuning: TuningPreset;
  instrument: 'guitar' | 'bass';
  showSustain: boolean;
  currentBeat: number;
  follow: boolean;
  onNoteClick: (note: TabLayoutNote) => void;
  onSeekBeat: (beat: number) => void;
  /** Tab correction mode: clicks on empty spots add notes (onCellClick), bar numbers toggle "checked". */
  editing?: boolean;
  selectedId?: string | null;
  checkedBars?: Set<number>;
  onCellClick?: (col: number, stringIndex: number) => void;
  onBarClick?: (bar: number) => void;
}

const TabRow = memo(function TabRow({
  row,
  layout,
  tuning,
  palette,
  showSustain,
  onNoteClick,
  onSeekBeat,
  editing,
  selectedId,
  checkedBars,
  onCellClick,
  onBarClick,
}: {
  row: TabLayoutRow;
  layout: TabLayout;
  tuning: TuningPreset;
  palette: Palette;
  showSustain: boolean;
  onNoteClick: (note: TabLayoutNote) => void;
  onSeekBeat: (beat: number) => void;
  editing?: boolean;
  selectedId?: string | null;
  checkedBars?: Set<number>;
  onCellClick?: (col: number, stringIndex: number) => void;
  onBarClick?: (bar: number) => void;
}) {
  const { labelWidth, staffTop, stringGap, strings, rowHeight } = layout;
  const width = labelWidth + row.width + 2;
  const yOf = (s: number) => staffTop + s * stringGap;
  const staffBottom = yOf(strings - 1);

  return (
    <svg width={width} height={rowHeight} className="block select-none" role="img" aria-label={`Tab measures ${row.measures[0].index + 1}–${row.measures[row.measures.length - 1].index + 1}`}>
      {/* string names */}
      {tuning.stringNames.map((name, s) => (
        <text key={s} x={labelWidth - 8} y={yOf(s) + 4} textAnchor="end" fontSize={11} fontWeight={600} fontFamily="JetBrains Mono, monospace" fill="#94A3B8">
          {name}
        </text>
      ))}
      <line x1={labelWidth} y1={staffTop} x2={labelWidth} y2={staffBottom} stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} />

      <g transform={`translate(${labelWidth},0)`}>
        {/* string lines */}
        {Array.from({ length: strings }).map((_, s) => (
          <line key={s} x1={0} y1={yOf(s)} x2={row.width} y2={yOf(s)} stroke="rgba(255,255,255,0.16)" strokeWidth={1} />
        ))}

        {row.measures.map((m) => {
          const inner = m.width - layout.padLeft - layout.padRight;
          const beats = Math.round(layout.beatsPerMeasure);
          return (
            <g key={m.index} transform={`translate(${m.x},0)`}>
              {/* click target for seeking */}
              <rect
                x={0}
                y={staffTop - 10}
                width={m.width}
                height={staffBottom - staffTop + 20}
                fill="transparent"
                className={editing ? 'cursor-crosshair hover:fill-white/[0.03]' : 'cursor-pointer hover:fill-white/[0.02]'}
                onClick={(e) => {
                  const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                  if (editing && onCellClick) {
                    const cell = (inner / layout.stepsPerMeasure) || layout.colWidth;
                    const c = Math.max(0, Math.min(layout.stepsPerMeasure - 1, Math.floor((e.clientX - box.left - layout.padLeft) / cell)));
                    const s = Math.round((e.clientY - box.top + (staffTop - 10) - staffTop) / stringGap);
                    onCellClick(m.startCol + c, Math.max(0, Math.min(strings - 1, s)));
                    return;
                  }
                  const frac = Math.max(0, Math.min(1, (e.clientX - box.left - layout.padLeft) / Math.max(1, inner)));
                  onSeekBeat(m.startBeat + frac * layout.beatsPerMeasure);
                }}
              />
              {/* bar number (in edit mode: click to mark the bar as checked) + chord changes */}
              <text
                x={4}
                y={12}
                fontSize={10}
                fontFamily="JetBrains Mono, monospace"
                fill={checkedBars?.has(m.index) ? '#34D399' : '#64748B'}
                className={editing ? 'cursor-pointer' : undefined}
                onClick={editing && onBarClick ? () => onBarClick(m.index) : undefined}
              >
                {m.index + 1}
                {checkedBars?.has(m.index) ? ' ✓' : ''}
              </text>
              {m.chords.map((c, i) => (
                <text key={i} x={Math.max(22, c.x)} y={13} fontSize={11} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill="#F59E0B">
                  {c.symbol}
                </text>
              ))}
              {/* beat ticks under the staff */}
              {Array.from({ length: beats }).map((_, b) => {
                const x = layout.padLeft + (b / beats) * inner;
                return <line key={b} x1={x} y1={staffBottom + 8} x2={x} y2={staffBottom + (b === 0 ? 15 : 12)} stroke={b === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)'} strokeWidth={1} />;
              })}
              {/* sustain lines */}
              {showSustain &&
                m.notes
                  .filter((n) => n.durSteps >= 2)
                  .map((n) => {
                    const half = n.fret >= 10 ? 9 : 6;
                    const end = Math.min(m.width - layout.padRight, n.x + (n.durSteps - 0.5) * layout.colWidth * (m.empty ? 0.3 : 1));
                    return end > n.x + half + 2 ? (
                      <line key={`s${n.id}`} x1={n.x + half + 1} y1={yOf(n.stringIndex)} x2={end} y2={yOf(n.stringIndex)} stroke={palette.sustain} strokeWidth={3} strokeLinecap="round" />
                    ) : null;
                  })}
              {/* fret numbers sitting on the strings */}
              {m.notes.map((n) => {
                const w = n.fret >= 10 ? 17 : 11;
                const y = yOf(n.stringIndex);
                return (
                  <g
                    key={n.id}
                    className="cursor-pointer"
                    opacity={n.velocity < 45 ? 0.55 : 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      onNoteClick(n);
                    }}
                  >
                    <title>{`${midiToNoteName(n.midi)} · string ${tuning.stringNames[n.stringIndex]} · fret ${n.fret} · velocity ${n.velocity}`}</title>
                    <rect x={n.x - w / 2} y={y - 7} width={w} height={14} rx={2} fill={ROW_BG} stroke={n.id === selectedId ? '#F8FAFC' : 'none'} strokeWidth={1.5} />
                    <text x={n.x} y={y + 4} textAnchor="middle" fontSize={12} fontWeight={700} fontFamily="JetBrains Mono, monospace" fill={palette.text}>
                      {n.fret}
                    </text>
                  </g>
                );
              })}
              {/* bar line */}
              <line x1={m.width} y1={staffTop} x2={m.width} y2={staffBottom} stroke="rgba(255,255,255,0.4)" strokeWidth={1} />
            </g>
          );
        })}
      </g>
    </svg>
  );
});

function Playhead({ layout, currentBeat, palette, follow, containerRef }: { layout: TabLayout; currentBeat: number; palette: Palette; follow: boolean; containerRef: React.RefObject<HTMLDivElement | null> }) {
  const loc = locateBeat(layout, currentBeat);
  const lastRow = useRef<number>(-1);

  useEffect(() => {
    if (!loc || !follow || !containerRef.current) return;
    if (loc.row.index === lastRow.current) return;
    lastRow.current = loc.row.index;
    const host = containerRef.current;
    const top = host.getBoundingClientRect().top + window.scrollY + loc.row.top;
    const viewTop = window.scrollY;
    const viewBottom = viewTop + window.innerHeight;
    if (top < viewTop + 120 || top + layout.rowHeight > viewBottom - 40) {
      scrollWindowTo(top - window.innerHeight * 0.3);
    }
  }, [loc?.row.index, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!loc || currentBeat < 0) return null;
  const { row, measure } = loc;
  const x = layout.labelWidth + beatX(layout, measure, currentBeat);
  // Light a note from the moment it is really played (not its grid slot, which can be up to half a
  // step early) until it ends; very short notes stay lit long enough to be seen.
  const minLit = layout.grid * 0.75;
  const active = measure.notes.filter((n) => currentBeat >= n.beat && currentBeat < Math.max(n.endBeat, n.beat + minLit));
  const yOf = (s: number) => row.top + layout.staffTop + s * layout.stringGap;
  return (
    <>
      <div
        aria-hidden="true"
        className="absolute w-0.5 bg-amber-500 pointer-events-none"
        style={{ left: x, top: row.top + layout.staffTop - 12, height: (layout.strings - 1) * layout.stringGap + 24 }}
      />
      {active.map((n) => (
        <div
          key={n.id}
          aria-hidden="true"
          className="absolute pointer-events-none rounded-sm text-[12px] font-bold font-mono flex items-center justify-center text-[#0B0D10]"
          style={{
            left: layout.labelWidth + measure.x + n.x - (n.fret >= 10 ? 10 : 7),
            top: yOf(n.stringIndex) - 8,
            width: n.fret >= 10 ? 20 : 14,
            height: 16,
            backgroundColor: palette.active,
          }}
        >
          {n.fret}
        </div>
      ))}
    </>
  );
}

export function TabStaff({ layout, tuning, instrument, showSustain, currentBeat, follow, onNoteClick, onSeekBeat, editing, selectedId, checkedBars, onCellClick, onBarClick }: TabStaffProps) {
  const palette = PALETTES[instrument];
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(
    () =>
      layout.rows.map((row) => (
        <div key={row.index} className="absolute left-0" style={{ top: row.top }}>
          <TabRow
            row={row}
            layout={layout}
            tuning={tuning}
            palette={palette}
            showSustain={showSustain}
            onNoteClick={onNoteClick}
            onSeekBeat={onSeekBeat}
            editing={editing}
            selectedId={selectedId}
            checkedBars={checkedBars}
            onCellClick={onCellClick}
            onBarClick={onBarClick}
          />
        </div>
      )),
    [layout, tuning, palette, showSustain, onNoteClick, onSeekBeat, editing, selectedId, checkedBars, onCellClick, onBarClick]
  );
  return (
    <div ref={containerRef} className="relative" style={{ height: layout.totalHeight, width: layout.labelWidth + layout.maxRowWidth + 4 }}>
      {rows}
      <Playhead layout={layout} currentBeat={currentBeat} palette={palette} follow={follow} containerRef={containerRef} />
    </div>
  );
}
