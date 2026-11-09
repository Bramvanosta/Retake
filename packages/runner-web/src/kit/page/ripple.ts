/** The click ripple. */
import { RT } from './clock.js';
import { effect, ripplesEl } from './overlay.js';

export function ripple(x: number, y: number): void {
  if (!ripplesEl) return;
  const d = document.createElement('div');
  d.className = 'rp';
  d.style.setProperty('--p', `translate(${x}px,${y}px)`);
  d.style.transform = `translate(${x}px,${y}px)`;
  ripplesEl.appendChild(d);
  effect('ripple', { x, y });
  const kill = () => d.remove();
  d.addEventListener('animationend', (e) => {
    if ((e as AnimationEvent).animationName === 'dsr-o') kill();
  });
  RT.setTimeout(kill, 800);
}
