import { barAt, barPosition } from '../audio/bars';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { scrollWindowTo } from '../utils/scroll';

/**
 * Engraved sheet music (standard notation + optional TAB staff) rendered from the same MusicXML
 * StemForge exports, using OpenSheetMusicDisplay (VexFlow). Loaded on demand.
 */

interface MeasureBox {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ScoreViewProps {
  xml: string;
  zoom: number;
  beatsPerMeasure: number;
  /** Bar starts (quarter beats, src/audio/bars.ts); default: regular bars. */
  barStarts?: number[];
  currentBeat: number;
  follow: boolean;
  onSeekBeat: (beat: number) => void;
  onReady?: (api: { svgMarkup: () => string | null }) => void;
}

type OsmdModule = typeof import('opensheetmusicdisplay');
let osmdModule: Promise<OsmdModule> | null = null;
const loadOsmd = () => (osmdModule ??= import('opensheetmusicdisplay'));

const UNIT = 10; // OSMD units -> px at zoom 1

function collectMeasureBoxes(osmd: OpenSheetMusicDisplay, host: HTMLElement): MeasureBox[] {
  const svg = host.querySelector('svg');
  if (!svg) return [];
  const hostRect = host.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const ox = svgRect.left - hostRect.left;
  const oy = svgRect.top - hostRect.top;
  const scale = UNIT * osmd.Zoom;
  const boxes: MeasureBox[] = [];
  const list = osmd.GraphicSheet?.MeasureList ?? [];
  list.forEach((staves, index) => {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const gm of staves) {
      if (!gm) continue;
      const ps = gm.PositionAndShape;
      const ax = ps.AbsolutePosition.x;
      const ay = ps.AbsolutePosition.y;
      x1 = Math.min(x1, ax + ps.BorderLeft);
      x2 = Math.max(x2, ax + ps.BorderRight);
      y1 = Math.min(y1, ay + ps.BorderTop);
      y2 = Math.max(y2, ay + ps.BorderBottom);
    }
    if (Number.isFinite(x1)) {
      boxes.push({ index, x: ox + x1 * scale, y: oy + y1 * scale, w: (x2 - x1) * scale, h: (y2 - y1) * scale });
    }
  });
  return boxes;
}

const OPTIONS = {
  autoResize: false,
  backend: 'svg',
  drawTitle: true,
  drawSubtitle: false,
  drawComposer: false,
  drawLyricist: false,
  drawCredits: false,
  drawPartNames: true,
  drawPartAbbreviations: false,
  drawMeasureNumbers: true,
  measureNumberInterval: 4,
  drawMetronomeMarks: true,
  disableCursor: true,
  followCursor: false,
  pageBackgroundColor: '#FFFFFF',
} as const;

export function ScoreView({ xml, zoom, beatsPerMeasure, barStarts, currentBeat, follow, onSeekBeat, onReady }: ScoreViewProps) {
  const starts = barStarts?.length ? barStarts : [0];
  const hostRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<MeasureBox[]>([]);
  const [width, setWidth] = useState(0);
  const lastFollowY = useRef<number>(-1);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let t: number | undefined;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      window.clearTimeout(t);
      t = window.setTimeout(() => setWidth((prev) => (Math.abs(prev - w) > 24 ? w : prev)), 250);
    });
    ro.observe(el);
    setWidth(Math.round(el.getBoundingClientRect().width));
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!width || !hostRef.current) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);
    (async () => {
      try {
        const mod = await loadOsmd();
        if (cancelled || !hostRef.current) return;
        if (!osmdRef.current) {
          osmdRef.current = new mod.OpenSheetMusicDisplay(hostRef.current, { ...OPTIONS });
          osmdRef.current.setLogLevel('error');
        }
        const osmd = osmdRef.current;
        await osmd.load(xml);
        if (cancelled) return;
        osmd.Zoom = zoom;
        await new Promise((r) => setTimeout(r, 30)); // let the spinner paint before the (blocking) engrave
        osmd.render();
        if (cancelled) return;
        setBoxes(collectMeasureBoxes(osmd, hostRef.current!));
        setStatus('ready');
        onReady?.({ svgMarkup: () => hostRef.current?.querySelector('svg')?.outerHTML ?? null });
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Could not engrave the score.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [xml, zoom, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const bar = barPosition(starts, Math.max(0, currentBeat), beatsPerMeasure);
  const measureIdx = bar.index;
  const active = status === 'ready' ? boxes.find((b) => b.index === measureIdx) : undefined;

  useEffect(() => {
    if (!active || !follow || !hostRef.current) return;
    if (Math.abs(active.y - lastFollowY.current) < 1) return;
    lastFollowY.current = active.y;
    const top = hostRef.current.getBoundingClientRect().top + window.scrollY + active.y;
    if (top < window.scrollY + 120 || top + active.h > window.scrollY + window.innerHeight - 40) {
      scrollWindowTo(top - window.innerHeight * 0.3);
    }
  }, [active?.y, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const playX = active ? active.x + Math.max(0, Math.min(1, (currentBeat - bar.start) / bar.length)) * active.w : 0;

  return (
    <div ref={wrapRef} className="relative">
      <div
        ref={hostRef}
        className="relative bg-white rounded-md cursor-pointer"
        onClick={(e) => {
          const host = hostRef.current;
          if (!host) return;
          const r = host.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          const hit = boxes.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y - 10 && y <= b.y + b.h + 10);
          if (hit) {
            const b = barAt(starts, hit.index, beatsPerMeasure);
            onSeekBeat(b.start + ((x - hit.x) / Math.max(1, hit.w)) * b.length);
          }
        }}
      />
      {active && (
        <>
          <div
            aria-hidden="true"
            className="absolute pointer-events-none rounded-sm bg-amber-400/15 ring-1 ring-amber-500/60"
            style={{ left: active.x, top: active.y - 6, width: active.w, height: active.h + 12 }}
          />
          <div aria-hidden="true" className="absolute pointer-events-none w-0.5 bg-amber-500" style={{ left: playX, top: active.y - 8, height: active.h + 16 }} />
        </>
      )}
      {status === 'loading' && (
        <div className="absolute inset-0 min-h-[160px] flex items-start justify-center pt-12 bg-white/70 rounded-md">
          <span className="inline-flex items-center gap-2 text-sm text-slate-700">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            Engraving score…
          </span>
        </div>
      )}
      {status === 'error' && <div className="p-6 text-sm text-rose-600 bg-white rounded-md">{error}</div>}
    </div>
  );
}

/** Renders the score on A4 pages in a hidden container and opens the browser print dialog (Save as PDF). */
export async function printScore(xml: string, title: string): Promise<void> {
  const mod = await loadOsmd();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff';
  document.body.appendChild(holder);
  try {
    const osmd = new mod.OpenSheetMusicDisplay(holder, { ...OPTIONS, pageFormat: 'A4_P', drawCredits: true });
    osmd.setLogLevel('error');
    await osmd.load(xml);
    osmd.Zoom = 1;
    osmd.render();
    const pages = [...holder.querySelectorAll('svg')].map((s) => s.outerHTML);
    const win = window.open('', '_blank', 'width=900,height=1000');
    if (!win) throw new Error('The print window was blocked.');
    const safeTitle = title.replace(/[<>&]/g, '');
    win.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title><style>
        @page { size: A4 portrait; margin: 0; } body { margin: 0; background: #fff; }
        .page { page-break-after: always; display: flex; justify-content: center; }
        .page:last-child { page-break-after: auto; } svg { width: 210mm; height: auto; }
      </style></head><body>${pages.map((p) => `<div class="page">${p}</div>`).join('')}</body></html>`
    );
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
  } finally {
    holder.remove();
  }
}
