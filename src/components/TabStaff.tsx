import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { TuningPreset } from '../audio/notationEngine';
import { midiToNoteName } from '../audio/notationEngine';
import { scrollWindowTo } from '../utils/scroll';
import { stickyTopPx } from '../utils/stickyHeight';
import { beatX, cellAtPoint, cellBox, cellsBetween, locateBeat, type TabCell, type TabLayout, type TabLayoutNote, type TabLayoutRow } from '../audio/tabLayout';

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
  /**
   * Tab correction mode (src/components/useTabEditor.ts): a click selects a note (onNoteClick) or an
   * empty spot, a double-click adds / removes a note, a drag over empty spots adds notes, a drag of a
   * note moves it (Ctrl+drag from a note fills the spots with its fret), bar numbers toggle "checked".
   */
  editing?: boolean;
  selectedId?: string | null;
  selectedCell?: TabCell | null;
  /** Digits typed for the selection (shown until Enter applies them). */
  typedFret?: string;
  /** The fret a drag over empty spots adds. */
  fillFret?: number;
  checkedBars?: Set<number>;
  onSelectCell?: (cell: TabCell | null) => void;
  onAddNotes?: (cells: TabCell[], fret?: number) => void;
  onDeleteNote?: (note: TabLayoutNote) => void;
  onMoveNote?: (note: TabLayoutNote, to: TabCell) => void;
  onBarClick?: (bar: number) => void;
  /** Bar line mode: a click on a beat starts / removes a bar line there. */
  barMode?: boolean;
  onBeatClick?: (beat: number) => void;
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
  onBarClick,
  barMode,
  onBeatClick,
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
  onBarClick?: (bar: number) => void;
  barMode?: boolean;
  onBeatClick?: (beat: number) => void;
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
          const beats = Math.max(1, Math.round(m.lengthBeats));
          return (
            <g key={m.index} transform={`translate(${m.x},0)`}>
              {/* click target for seeking (in edit mode the pointer handlers of TabStaff take over) */}
              <rect
                x={0}
                y={staffTop - 10}
                width={m.width}
                height={staffBottom - staffTop + 20}
                fill="transparent"
                className={editing || barMode ? 'cursor-crosshair hover:fill-white/[0.03]' : 'cursor-pointer hover:fill-white/[0.02]'}
                onClick={(e) => {
                  if (editing) return;
                  const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
                  if (barMode && onBeatClick) {
                    const frac = Math.max(0, Math.min(1, (e.clientX - box.left - layout.padLeft) / Math.max(1, inner)));
                    onBeatClick(m.startBeat + Math.round(frac * m.lengthBeats));
                    return;
                  }
                  const frac = Math.max(0, Math.min(1, (e.clientX - box.left - layout.padLeft) / Math.max(1, inner)));
                  onSeekBeat(m.startBeat + frac * m.lengthBeats);
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
                const x = layout.padLeft + (b / m.lengthBeats) * inner;
                return (
                  <g key={b}>
                    {barMode && b > 0 && <line x1={x} y1={staffTop - 4} x2={x} y2={staffBottom + 4} stroke="rgba(56,189,248,0.35)" strokeWidth={1} strokeDasharray="3 3" />}
                    <line x1={x} y1={staffBottom + 8} x2={x} y2={staffBottom + (b === 0 ? 15 : 12)} stroke={b === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)'} strokeWidth={1} />
                  </g>
                );
              })}
              {/* odd bar length (e.g. 3/4 inside 4/4), under the staff so it never meets a chord name */}
              {Math.abs(m.lengthBeats - layout.beatsPerMeasure) > 1e-6 && (
                <text x={m.width - 4} y={staffBottom + 19} textAnchor="end" fontSize={9} fontFamily="JetBrains Mono, monospace" fill="#38BDF8">
                  {Math.round(m.lengthBeats * 100) / 100}/4
                </text>
              )}
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
                    className={editing ? 'cursor-grab' : 'cursor-pointer'}
                    opacity={n.velocity < 45 ? 0.55 : 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!editing) onNoteClick(n);
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
    // the part of the window not covered by the sticky bars (header, transport, part controls)
    const covered = stickyTopPx();
    const viewTop = window.scrollY + covered;
    const viewBottom = window.scrollY + window.innerHeight;
    if (top < viewTop + 16 || top + layout.rowHeight > viewBottom - 40) {
      scrollWindowTo(top - covered - Math.max(16, (window.innerHeight - covered) * 0.25));
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

/** A drag in edit mode: over empty spots (adds notes) or of a note (moves it). */
interface Drag {
  kind: 'fill' | 'move';
  pointerId: number;
  from: TabCell;
  to: TabCell;
  /** The note under the pointer when the drag started (a click on it selects it). */
  note?: TabLayoutNote;
  fret: number;
  x0: number;
  y0: number;
  moved: boolean;
}

const sameCell = (a: TabCell, b: TabCell) => a.col === b.col && a.string === b.string;
const keyOf = (c: TabCell) => `${c.col}:${c.string}`;
/** Two clicks on the same spot within this time (ms) are a double-click. */
const DOUBLE_CLICK_MS = 400;

/** Edit mode feedback drawn over the tab: hovered / selected spot, typed fret, drag previews. */
function EditOverlay({
  layout,
  palette,
  notesAt,
  hover,
  drag,
  selectedNote,
  selectedCell,
  typedFret,
}: {
  layout: TabLayout;
  palette: Palette;
  notesAt: Map<string, TabLayoutNote>;
  hover: TabCell | null;
  drag: Drag | null;
  selectedNote: TabLayoutNote | null;
  selectedCell: TabCell | null;
  typedFret: string;
}) {
  const box = (c: TabCell, h = 16) => {
    const b = cellBox(layout, c);
    return b ? { left: b.left + 1, top: b.cy - h / 2, width: Math.max(4, b.width - 2), height: h } : null;
  };
  const items: ReactNode[] = [];
  if (hover && !drag) {
    const b = box(hover);
    if (b) items.push(<div key="hover" className="absolute rounded-sm bg-white/[0.07] border border-white/20" style={b} />);
  }
  if (selectedCell) {
    const b = box(selectedCell, 18);
    if (b)
      items.push(
        <div key="cell" className="absolute rounded-sm border-2 border-sky-400 bg-sky-400/15 flex items-center justify-center text-[12px] font-bold font-mono" style={{ ...b, color: palette.text }}>
          {typedFret}
        </div>
      );
  }
  if (selectedNote && typedFret) {
    const b = cellBox(layout, { col: selectedNote.col, string: selectedNote.stringIndex });
    if (b)
      items.push(
        <div key="typed" className="absolute rounded-sm bg-sky-400 text-[#0B0D10] text-[11px] font-bold font-mono px-1 leading-4 whitespace-nowrap" style={{ left: b.cx - 14, top: b.cy - 27 }}>
          →{typedFret}
        </div>
      );
  }
  if (drag?.moved && drag.kind === 'fill') {
    for (const c of cellsBetween(drag.from, drag.to)) {
      if (notesAt.has(keyOf(c))) continue;
      const b = box(c);
      if (!b) continue;
      items.push(
        <div key={`f${keyOf(c)}`} className="absolute rounded-sm border border-dashed border-amber-400/80 bg-amber-400/15 flex items-center justify-center text-[11px] font-bold font-mono" style={{ ...b, color: palette.text }}>
          {drag.fret}
        </div>
      );
    }
  }
  if (drag?.moved && drag.kind === 'move' && drag.note && !sameCell(drag.from, drag.to)) {
    const from = box(drag.from);
    const to = box(drag.to, 18);
    if (from) items.push(<div key="from" className="absolute rounded-sm border border-dashed border-white/40" style={{ ...from, backgroundColor: 'rgba(19,22,28,0.75)' }} />);
    if (to)
      items.push(
        <div key="to" className="absolute rounded-sm border-2 border-amber-400 flex items-center justify-center text-[12px] font-bold font-mono" style={{ ...to, color: palette.text, backgroundColor: ROW_BG }}>
          {drag.note.fret}
        </div>
      );
  }
  return <div aria-hidden="true" className="absolute inset-0 pointer-events-none">{items}</div>;
}

export function TabStaff({
  layout,
  tuning,
  instrument,
  showSustain,
  currentBeat,
  follow,
  onNoteClick,
  onSeekBeat,
  editing,
  selectedId,
  selectedCell,
  typedFret = '',
  fillFret = 0,
  checkedBars,
  onSelectCell,
  onAddNotes,
  onDeleteNote,
  onMoveNote,
  onBarClick,
  barMode,
  onBeatClick,
}: TabStaffProps) {
  const palette = PALETTES[instrument];
  const containerRef = useRef<HTMLDivElement | null>(null);

  // ---- edit mode: click / double-click / drag on the spots of the tab
  const notesAt = useMemo(() => {
    const map = new Map<string, TabLayoutNote>();
    for (const row of layout.rows) for (const m of row.measures) for (const n of m.notes) map.set(`${n.col}:${n.stringIndex}`, n);
    return map;
  }, [layout]);
  const selectedNote = useMemo(() => {
    if (!editing || !selectedId) return null;
    for (const n of notesAt.values()) if (n.id === selectedId) return n;
    return null;
  }, [editing, selectedId, notesAt]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [hover, setHover] = useState<TabCell | null>(null);
  const lastTap = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    if (editing) return;
    dragRef.current = null;
    setDrag(null);
    setHover(null);
  }, [editing]);

  const pointAt = (e: ReactPointerEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const updateDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing || e.button !== 0 || !containerRef.current) return;
    const { x, y } = pointAt(e);
    const cell = cellAtPoint(layout, x, y);
    if (!cell) return; // bar numbers etc. keep their own click handlers
    e.preventDefault();
    const note = notesAt.get(keyOf(cell));
    const now = performance.now();
    const tap = lastTap.current;
    if (tap && tap.key === keyOf(cell) && now - tap.at < DOUBLE_CLICK_MS) {
      // double-click: remove the note there, or add one on the empty spot
      lastTap.current = null;
      updateDrag(null);
      if (note) onDeleteNote?.(note);
      else onAddNotes?.([cell]);
      return;
    }
    containerRef.current.setPointerCapture(e.pointerId);
    const fill = !note || e.ctrlKey || e.metaKey; // Ctrl+drag from a note: fill the spots with its fret
    updateDrag({ kind: fill ? 'fill' : 'move', pointerId: e.pointerId, from: cell, to: cell, note, fret: note ? note.fret : fillFret, x0: x, y0: y, moved: false });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!editing) return;
    const { x, y } = pointAt(e);
    const d = dragRef.current;
    if (!d) {
      const c = cellAtPoint(layout, x, y);
      if (!(c && hover && sameCell(c, hover)) && (c || hover)) setHover(c);
      return;
    }
    if (e.pointerId !== d.pointerId) return;
    const moved = d.moved || Math.hypot(x - d.x0, y - d.y0) > 4;
    const to = cellAtPoint(layout, x, y, true) ?? d.to;
    if (moved !== d.moved || !sameCell(to, d.to)) updateDrag({ ...d, moved, to });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    updateDrag(null);
    if (containerRef.current?.hasPointerCapture(e.pointerId)) containerRef.current.releasePointerCapture(e.pointerId);
    if (!d.moved || sameCell(d.from, d.to)) {
      // a click: select the note or the empty spot
      lastTap.current = { key: keyOf(d.from), at: performance.now() };
      if (d.note) onNoteClick(d.note);
      else onSelectCell?.(d.from);
      return;
    }
    lastTap.current = null;
    if (d.kind === 'move' && d.note) onMoveNote?.(d.note, d.to);
    else onAddNotes?.(cellsBetween(d.from, d.to), d.fret);
  };

  const onPointerCancel = () => {
    updateDrag(null);
  };

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
            onBarClick={onBarClick}
            barMode={barMode}
            onBeatClick={onBeatClick}
          />
        </div>
      )),
    [layout, tuning, palette, showSustain, onNoteClick, onSeekBeat, editing, selectedId, checkedBars, onBarClick, barMode, onBeatClick]
  );
  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        height: layout.totalHeight,
        width: layout.labelWidth + layout.maxRowWidth + 4,
        ...(drag?.moved ? { cursor: drag.kind === 'move' ? 'grabbing' : 'crosshair' } : {}),
      }}
      onPointerDown={editing ? onPointerDown : undefined}
      onPointerMove={editing ? onPointerMove : undefined}
      onPointerUp={editing ? onPointerUp : undefined}
      onPointerCancel={editing ? onPointerCancel : undefined}
      onPointerLeave={editing && hover ? () => setHover(null) : undefined}
    >
      {rows}
      {editing && (
        <EditOverlay
          layout={layout}
          palette={palette}
          notesAt={notesAt}
          hover={hover}
          drag={drag}
          selectedNote={selectedNote}
          selectedCell={selectedCell ?? null}
          typedFret={typedFret}
        />
      )}
      <Playhead layout={layout} currentBeat={currentBeat} palette={palette} follow={follow} containerRef={containerRef} />
    </div>
  );
}
