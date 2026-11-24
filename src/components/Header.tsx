import { useEffect, useRef, useState, type ReactElement } from 'react';
import { CheckCircle2, ChevronDown, CloudOff, Download, FolderOpen, Loader2, Save, Upload } from 'lucide-react';
import type { WorkspaceView } from '../types/music';

export type SaveStatus = 'saved' | 'saving' | 'pending' | 'error' | 'not-saved' | 'none';

interface HeaderProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  onImportClick: () => void;
  saveStatus: SaveStatus;
  saveMessage?: string;
  canSaveProject: boolean;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onExport: () => void;
  onRevealProjects?: () => void;
}

const NAV_ITEMS: Array<{ id: WorkspaceView; label: string }> = [
  { id: 'mixer', label: 'Mixer' },
  { id: 'midi', label: 'MIDI Studio' },
  { id: 'notation', label: 'Tabs & Sheet' },
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
];

function SaveBadge({ status, message }: { status: SaveStatus; message?: string }) {
  if (status === 'none') return null;
  const map: Record<Exclude<SaveStatus, 'none'>, { icon: ReactElement; text: string; cls: string }> = {
    saved: { icon: <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />, text: 'Saved', cls: 'text-emerald-300' },
    saving: { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />, text: 'Saving…', cls: 'text-slate-300' },
    pending: { icon: <Loader2 className="w-3.5 h-3.5" aria-hidden="true" />, text: 'Unsaved changes', cls: 'text-amber-300' },
    error: { icon: <CloudOff className="w-3.5 h-3.5" aria-hidden="true" />, text: 'Not saved', cls: 'text-rose-300' },
    'not-saved': { icon: <CloudOff className="w-3.5 h-3.5" aria-hidden="true" />, text: 'Temporary song', cls: 'text-slate-400' },
  };
  const m = map[status];
  return (
    <span role="status" title={message} className={`hidden lg:inline-flex items-center gap-1.5 text-xs ${m.cls}`}>
      {m.icon}
      <span>{m.text}</span>
    </span>
  );
}

export function Header({
  activeView,
  onSelectView,
  onImportClick,
  saveStatus,
  saveMessage,
  canSaveProject,
  onOpenProject,
  onSaveProject,
  onSaveProjectAs,
  onExport,
  onRevealProjects,
}: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const item = (label: string, shortcut: string, onClick: () => void, disabled = false, icon?: ReactElement) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setMenuOpen(false);
        onClick();
      }}
      className="w-full flex items-center justify-between gap-6 px-3 py-2 text-xs text-left text-slate-200 hover:bg-white/[0.06] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
    >
      <span className="inline-flex items-center gap-2">
        {icon}
        {label}
      </span>
      <span className="font-mono text-[10px] text-slate-500">{shortcut}</span>
    </button>
  );

  return (
    <header className="sticky top-0 z-30 bg-[#0B0D10]/95 backdrop-blur-md border-b border-white/[0.08]">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 md:h-14 flex flex-wrap md:flex-nowrap items-center justify-between gap-x-6">
        <div className="order-1 flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => onSelectView('mixer')}
            className="h-12 md:h-14 inline-flex items-center font-display text-lg font-bold tracking-tight text-white hover:text-amber-400 transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 rounded-sm"
          >
            StemForge
          </button>

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white rounded-md hover:bg-white/[0.06] cursor-pointer"
            >
              File
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
            {menuOpen && (
              <div role="menu" className="absolute left-0 mt-1 w-64 py-1 bg-[#13161C] border border-white/[0.12] rounded-md shadow-xl z-40">
                {item('Import audio or video…', '', onImportClick, false, <Upload className="w-3.5 h-3.5" aria-hidden="true" />)}
                {item('Open project (.sfg)…', 'Ctrl+O', onOpenProject, false, <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />)}
                <div className="my-1 border-t border-white/[0.06]" />
                {item('Save project', 'Ctrl+S', onSaveProject, !canSaveProject, <Save className="w-3.5 h-3.5" aria-hidden="true" />)}
                {item('Save project as (.sfg)…', 'Ctrl+Shift+S', onSaveProjectAs, !canSaveProject)}
                <div className="my-1 border-t border-white/[0.06]" />
                {item('Export audio / MIDI / score…', 'Ctrl+E', onExport, false, <Download className="w-3.5 h-3.5" aria-hidden="true" />)}
                {onRevealProjects && (
                  <>
                    <div className="my-1 border-t border-white/[0.06]" />
                    {item('Show projects folder', '', onRevealProjects)}
                  </>
                )}
              </div>
            )}
          </div>
          <SaveBadge status={saveStatus} message={saveMessage} />
        </div>

        <nav
          aria-label="Workspace views"
          className="order-3 md:order-2 w-full md:w-auto border-t border-white/[0.06] md:border-t-0 flex items-center justify-between md:justify-center gap-4 sm:gap-6"
        >
          {NAV_ITEMS.map((nav) => {
            const active = activeView === nav.id;
            return (
              <button
                key={nav.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelectView(nav.id)}
                className={`relative h-10 md:h-14 inline-flex items-center text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-500 focus-visible:outline-offset-[-4px] ${
                  active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {nav.label}
                {active && <span aria-hidden="true" className="absolute bottom-0 left-0 right-0 h-0.5 bg-amber-500" />}
              </button>
            );
          })}
        </nav>

        <div className="order-2 md:order-3 flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onExport}
            className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-slate-200 bg-[#1B1F27] hover:bg-[#252B36] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap cursor-pointer"
          >
            <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Export</span>
          </button>
          <button
            type="button"
            onClick={onImportClick}
            className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-semibold text-[#0B0D10] bg-amber-500 hover:bg-amber-400 active:bg-amber-600 rounded-md transition-colors whitespace-nowrap cursor-pointer focus-visible:outline-2 focus-visible:outline-amber-300 focus-visible:outline-offset-2"
          >
            <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Import</span>
          </button>
        </div>
      </div>
    </header>
  );
}
