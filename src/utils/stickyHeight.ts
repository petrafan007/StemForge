import { useEffect, type RefObject } from 'react';

/**
 * Sticky bars on the Tabs & Sheet page (app header, transport, part / mode controls) publish their
 * heights as CSS variables on <html>, so each bar can stick right below the ones above it and the
 * playhead's auto-scroll keeps the current row out from under them.
 */
export const STICKY_VARS = ['--sf-header-h', '--sf-transport-h', '--sf-notation-h'] as const;
export type StickyVar = (typeof STICKY_VARS)[number];

/** Keeps `name` equal to the element's height while `enabled` (0px otherwise). */
export function useStickyHeightVar(ref: RefObject<HTMLElement | null>, name: StickyVar, enabled = true): void {
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!enabled || !el) {
      root.style.setProperty(name, '0px');
      return;
    }
    const update = () => root.style.setProperty(name, `${Math.round(el.getBoundingClientRect().height)}px`);
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.setProperty(name, '0px');
    };
  }, [ref, name, enabled]);
}

/** Height (px) covered by the sticky bars at the top of the window. */
export function stickyTopPx(): number {
  if (typeof document === 'undefined') return 0;
  const style = getComputedStyle(document.documentElement);
  return STICKY_VARS.reduce((sum, v) => sum + (parseFloat(style.getPropertyValue(v)) || 0), 0);
}
