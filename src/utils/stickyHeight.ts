import { useEffect, type RefObject } from 'react';

/**
 * Sticky bars on the Tabs & Sheet page (app header, transport, part / mode controls) publish their
 * heights as CSS variables on <html>, so each bar can stick right below the ones above it and the
 * playhead's auto-scroll keeps the current row out from under them.
 */
export const STICKY_VARS = ['--sf-header-h', '--sf-transport-h', '--sf-notation-h'] as const;
export type StickyVar = (typeof STICKY_VARS)[number];

/** Keeps `name` equal to the element's height while it is sticky and `enabled` (0px otherwise: narrow
 * windows, where the bars scroll with the page so they don't cover the music). */
export function useStickyHeightVar(ref: RefObject<HTMLElement | null>, name: StickyVar, enabled = true): void {
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!enabled || !el) {
      root.style.setProperty(name, '0px');
      return;
    }
    const update = () => {
      const sticky = getComputedStyle(el).position === 'sticky';
      root.style.setProperty(name, sticky ? `${Math.round(el.getBoundingClientRect().height)}px` : '0px');
    };
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
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
