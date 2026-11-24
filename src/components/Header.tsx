import { Upload } from 'lucide-react';
import type { WorkspaceView } from '../types/music';

interface HeaderProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  onImportClick: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceView; label: string }> = [
  { id: 'mixer', label: 'Mixer' },
  { id: 'midi', label: 'MIDI Studio' },
  { id: 'notation', label: 'Tabs & Sheet' },
  { id: 'library', label: 'Library' },
];

export function Header({ activeView, onSelectView, onImportClick }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 bg-[#0B0D10]/95 backdrop-blur-md border-b border-white/[0.08]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:h-14 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-8">
        {/* Zone 1: Single-element brand wordmark */}
        <button
          type="button"
          onClick={() => onSelectView('mixer')}
          className="h-12 md:h-14 inline-flex items-center font-display text-lg font-bold tracking-tight text-white hover:text-amber-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-500 focus-visible:outline-offset-4 rounded-sm cursor-pointer order-1"
        >
          StemForge
        </button>

        {/* Zone 2: Clean single-line text navigation */}
        <nav
          aria-label="Workspace views"
          className="order-3 md:order-2 w-full md:w-auto border-t border-white/[0.06] md:border-t-0 flex items-center justify-between md:justify-center gap-4 sm:gap-7"
        >
          {NAV_ITEMS.map((item) => {
            const active = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(item.id)}
                className={`relative h-10 md:h-14 inline-flex items-center text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 focus-visible:outline-offset-[-4px] ${
                  active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary CTA */}
        <div className="order-2 md:order-3 flex items-center shrink-0">
          <button
            type="button"
            onClick={onImportClick}
            className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 active:bg-amber-600 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300 focus-visible:outline-offset-2"
          >
            <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Import Audio</span>
          </button>
        </div>
      </div>
    </header>
  );
}
