/**
 * L5.9: placing a popover (a menu) under its trigger — `position: fixed` from the trigger's box, flipped above it when it
 * would cross the window's bottom, kept inside the window sideways; re-placed on resize and scroll while open. The
 * platform does the rest (`popover="auto"`: the top layer above every pane, light dismiss, Escape) — no library.
 */
export function placeUnder(trigger: HTMLElement, pop: HTMLElement, gap = 4): void {
  const t = trigger.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const below = t.bottom + gap + h <= vh || t.top - gap - h < 0;
  const top = below ? t.bottom + gap : t.top - gap - h;
  const left = Math.max(8, Math.min(t.left, vw - w - 8));
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

/** Re-place `pop` on every resize and scroll (any scroller: capture) until the returned function is called. */
export function followTrigger(trigger: HTMLElement, pop: HTMLElement): () => void {
  const again = () => placeUnder(trigger, pop);
  again();
  window.addEventListener('resize', again);
  window.addEventListener('scroll', again, true);
  return () => {
    window.removeEventListener('resize', again);
    window.removeEventListener('scroll', again, true);
  };
}
