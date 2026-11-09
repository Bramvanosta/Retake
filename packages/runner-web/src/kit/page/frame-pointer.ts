/** Pointer input forwarded from sub-frames to the top document's cursor. */
import { config } from './config.js';
import { moveTo, press } from './cursor.js';
import { isTop, on } from './lifecycle.js';
import { ripple } from './ripple.js';
import { contentOffset, deepQsa } from './trees.js';

// The frame element a forwarding window lives in (also inside open shadow roots), cached per source window.
const frameFor = new WeakMap<object, Element>();
function sourceFrame(src: MessageEventSource | null): Element | null {
  if (!src) return null;
  const known = frameFor.get(src);
  if (known && known.isConnected && (known as HTMLIFrameElement).contentWindow === src) return known;
  const isSrc = (f: Element) => (f as HTMLIFrameElement).contentWindow === src;
  const f = Array.from(document.querySelectorAll('iframe,frame')).find(isSrc) ?? deepQsa(document, 'iframe,frame').find(isSrc) ?? null;
  if (f) frameFor.set(src, f);
  return f;
}
/** Pointer input a sub-frame forwards: offset by the frame's position, passed up to the top document, drawn there. */
export function relayFramePointer(): void {
  if (!config.passive) on(window, 'message', (ev: Event) => {
    const e = ev as MessageEvent;
    const d = e.data as { __retakePtr?: number; type?: string; x?: number; y?: number } | null;
    if (!d || d.__retakePtr !== 1 || typeof d.x !== 'number' || typeof d.y !== 'number') return;
    const frame = sourceFrame(e.source);
    if (!frame) return;
    const o = contentOffset(frame);
    const x = d.x + o.x;
    const y = d.y + o.y;
    if (!isTop) {
      try {
        window.parent.postMessage({ ...d, x, y }, '*');
      } catch {
        /* detached */
      }
      return;
    }
    if (d.type === 'move') moveTo(x, y);
    else if (d.type === 'down') {
      moveTo(x, y);
      press(true);
      ripple(x, y);
    } else if (d.type === 'up') press(false);
  });
}
