/**
 * The kit's lifecycle: one instance per document (an unhealthy one replaced), its listeners and cleanups, the health
 * ping.
 */
import type { CursorState, KitApi } from '../types.js';
import { config } from './config.js';
import { host } from './host.js';

export const VERSION = '1.6.0';
const w = window as unknown as Window & { __retake?: KitApi };

export let carried: CursorState | null = null;
/**
 * Replace the kit a document already holds: a healthy one of this version stays (false: this one stops here); any
 * other is disposed and its cursor carried over.
 */
export function replacePrevious(): boolean {
  const prev = w.__retake;
  if (prev && typeof prev.healthy === 'function') {
    if (prev.version === VERSION && prev.healthy()) return false;
    // document.open() erases window listeners and drops the overlay: replace the old instance.
    try {
      carried = prev.cursor.state();
      prev.dispose();
    } catch {
      /* old instance unusable */
    }
  }
  return true;
}
export let disposed = false;
export const cleanups: Array<() => void> = [];
export function on(target: EventTarget, type: string, fn: (e: Event) => void, opts: AddEventListenerOptions = { capture: true, passive: true }): void {
  target.addEventListener(type, fn, opts);
  cleanups.push(() => target.removeEventListener(type, fn, opts));
}
export let pinged = false;
/** Answer the health ping (`api.healthy`): a document whose listeners were erased stops answering. */
export function listenForPing(): void {
  on(window, '__retake_ping', () => {
    pinged = true;
  });
}

export const isTop = (() => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
})();
/** The kit answers its own ping and, in a top document that draws, its overlay is still attached (`api.healthy`). */
export function healthy(): boolean {
  if (disposed) return false;
  pinged = false;
  window.dispatchEvent(new Event('__retake_ping'));
  return pinged && (!isTop || config.passive === true || host.isConnected);
}
/** Remove every listener, observer and timer the kit holds (`api.dispose`). */
export function dispose(): void {
  disposed = true;
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
}
