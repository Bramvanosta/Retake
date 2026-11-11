/**
 * The overlay layer: built once, kept attached and at the top of the top layer; what the cursor shows reported to the
 * runner.
 */
import type { CursorKind } from '../types.js';
import { RT } from './clock.js';
import { css, lookHtml } from './cursor-look.js';
import { host } from './host.js';
import { disposed } from './lifecycle.js';
import { isPopoverOpen } from './scopes.js';

/**
 * Report a cursor effect (what the cursor shows: its icon, a press, a release, a ripple) to the runner (binding
 * `__retakeCursor`, types.ts `CursorEffectPayload`), never failing.
 */
export function reportCursorEffect(type: 'icon' | 'press' | 'release' | 'ripple', extra: { icon?: CursorKind; x?: number; y?: number } = {}): void {
  try {
    const b = (window as unknown as Record<string, unknown>).__retakeCursor;
    if (typeof b !== 'function') return;
    const r = (b as (p: unknown) => unknown)({ type, time: RT.Date.now(), ...extra }) as { catch?: (f: () => void) => void } | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => undefined);
  } catch {
    /* the runner is gone */
  }
}
let shadow: ShadowRoot | null = null;
export let cursorEl: HTMLElement | null = null;
export let scaleEl: HTMLElement | null = null;
export let ripplesEl: HTMLElement | null = null;
export let ghostEl: HTMLElement | null = null;

export function buildOverlay(): void {
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute(
    'style',
    [
      'position:fixed', 'inset:0', 'left:0', 'top:0', 'width:100vw', 'height:100vh', 'max-width:none', 'max-height:none',
      'margin:0', 'padding:0', 'border:0', 'background:transparent', 'overflow:visible', 'pointer-events:none',
      'z-index:2147483647', 'display:block', 'opacity:1', 'visibility:visible', 'transform:none', 'filter:none',
      'clip-path:none', 'color-scheme:normal',
    ]
      .map((d) => d + '!important')
      .join(';'),
  );
  if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
  shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${css}</style>${lookHtml}`;
  cursorEl = shadow.querySelector('.c');
  scaleEl = shadow.querySelector('.s');
  ripplesEl = shadow.querySelector('.rps');
  ghostEl = shadow.querySelector('.g');
}

let origShowPopover: typeof HTMLElement.prototype.showPopover;
let origHidePopover: typeof HTMLElement.prototype.hidePopover;
/**
 * Keep the page's popover methods, read where the kit installs itself: after a previous kit was disposed, before this
 * one patches them.
 */
export function keepPopoverMethods(): void {
  origShowPopover = HTMLElement.prototype.showPopover;
  origHidePopover = HTMLElement.prototype.hidePopover;
}

function popoverOpen(): boolean {
  return isPopoverOpen(host);
}
function showLayer(): void {
  if (disposed || !host.isConnected || !host.hasAttribute('popover') || typeof origShowPopover !== 'function') return;
  try {
    if (!popoverOpen()) origShowPopover.call(host);
  } catch {
    /* not allowed right now (e.g. during a fullscreen transition); z-index fallback applies */
  }
}
/** Move the overlay to the top of the top layer (above a modal dialog / popover opened after it). */
function raise(): void {
  if (disposed || !host.isConnected || !host.hasAttribute('popover')) return;
  try {
    if (popoverOpen()) origHidePopover.call(host);
    origShowPopover.call(host);
  } catch {
    /* keep the z-index fallback */
  }
}
let raiseQueued = false;
export function queueRaise(): void {
  if (raiseQueued) return;
  raiseQueued = true;
  queueMicrotask(() => {
    raiseQueued = false;
    raise();
  });
}
export function attach(): void {
  if (disposed) return;
  const root = document.documentElement;
  if (!root) return;
  if (host.parentNode !== root) root.appendChild(host);
  showLayer();
}
