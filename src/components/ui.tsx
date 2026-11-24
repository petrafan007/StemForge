import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

/** Shared form controls in the StemForge studio style. */

export const inputClass =
  'h-8 px-2.5 rounded-md bg-[#0B0D10] border border-white/[0.12] text-xs text-slate-100 focus-visible:outline-2 focus-visible:outline-amber-500';

export const buttonClass =
  'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-amber-500';

export const secondaryButtonClass = `${buttonClass} bg-[#1B1F27] hover:bg-[#252B36] border-white/[0.08] text-slate-200`;

export const primaryButtonClass = `${buttonClass} bg-amber-500 hover:bg-amber-400 border-amber-500 text-[#0B0D10] font-semibold`;

export const dangerButtonClass = `${buttonClass} bg-rose-500/15 hover:bg-rose-500/25 border-rose-500/40 text-rose-200`;

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="border border-white/[0.08] rounded-lg bg-[#13161C] p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-base font-bold text-white">{title}</h2>
          {description && <p className="text-xs text-slate-400 mt-0.5 max-w-3xl">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 ${wide ? 'md:col-span-2' : ''}`}>
      <span className="text-xs font-medium text-slate-300">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-slate-500 leading-snug">{hint}</span>}
    </div>
  );
}

export function FieldGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-6 gap-y-4">{children}</div>;
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={`flex items-start gap-3 ${disabled ? 'opacity-50' : ''}`}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 w-9 h-5 rounded-full border transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-amber-500 ${
          checked ? 'bg-amber-500 border-amber-500' : 'bg-[#0B0D10] border-white/20'
        }`}
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${checked ? 'left-[18px] bg-[#0B0D10]' : 'left-0.5 bg-slate-400'}`}
        />
      </button>
      <label htmlFor={id} className="flex flex-col gap-0.5 cursor-pointer">
        <span className="text-xs font-medium text-slate-200">{label}</span>
        {hint && <span className="text-[11px] text-slate-500 leading-snug">{hint}</span>}
      </label>
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value;
        const match = options.find((o) => String(o.value) === raw);
        if (match) onChange(match.value);
      }}
      className={`${inputClass} cursor-pointer disabled:opacity-50 ${className ?? ''}`}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)} disabled={o.disabled} className="bg-[#13161C]">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  ariaLabel,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        className="studio-fader flex-1"
      />
      <span className="w-14 text-right font-mono text-xs tabular-nums text-slate-300">{format ? format(value) : value}</span>
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  ariaLabel,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
      className={`${inputClass} font-mono tabular-nums ${className ?? 'w-24'}`}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex flex-wrap items-center p-1 bg-[#0B0D10] border border-white/[0.08] rounded-md">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-xs font-medium rounded whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            value === o.value ? 'bg-amber-500 text-[#0B0D10] font-semibold' : 'text-slate-300 hover:text-white'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-3xl',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${width} bg-[#13161C] border border-white/[0.12] rounded-xl shadow-2xl flex flex-col max-h-[92vh] outline-none`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-white/[0.08]">
          <h2 className="font-display text-base font-bold text-white">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto studio-scroll flex flex-col gap-5">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-white/[0.08] flex flex-wrap items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function StatusLine({ kind, children }: { kind: 'ok' | 'error' | 'info'; children: ReactNode }) {
  const cls =
    kind === 'ok'
      ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30'
      : kind === 'error'
        ? 'text-rose-200 bg-rose-500/10 border-rose-500/35'
        : 'text-slate-300 bg-white/[0.04] border-white/[0.1]';
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`text-xs border rounded-md px-3.5 py-2 ${cls}`}>
      {children}
    </div>
  );
}
