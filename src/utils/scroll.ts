/**
 * Scrolls the page to `top`, smoothly when the browser does it, otherwise instantly
 * (some embedded browsers / reduced-motion settings silently ignore smooth scrolling).
 */
export function scrollWindowTo(top: number): void {
  const target = Math.max(0, Math.round(top));
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    window.scrollTo({ top: target });
    return;
  }
  const start = window.scrollY;
  window.scrollTo({ top: target, behavior: 'smooth' });
  window.setTimeout(() => {
    if (Math.abs(window.scrollY - start) < 2 && Math.abs(target - start) > 2) window.scrollTo({ top: target });
  }, 180);
}
