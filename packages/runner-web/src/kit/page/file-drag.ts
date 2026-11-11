/** A file dragged onto the page: the drag events and the dropped file. */
import type { DropOutcome, FileSpec } from '../types.js';
import { ref } from './refs.js';

// ───────────────────────────── file drag ─────────────────────────────
export let drag: { dt: DataTransfer; current: Element | null; accepted: boolean } | null = null;
function fireDrag(type: string, el: Element, x: number, y: number, related?: Element | null): boolean {
  if (!drag) return false;
  const ev = new DragEvent(type, {
    bubbles: true,
    cancelable: type !== 'dragleave',
    composed: true,
    clientX: x,
    clientY: y,
    dataTransfer: drag.dt,
    relatedTarget: related ?? null,
  });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}
export const fileDrag = {
  begin(spec: FileSpec): void {
    let bytes: Uint8Array<ArrayBuffer>;
    if (spec.base64 !== undefined) {
      const bin = atob(spec.base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new Uint8Array(spec.size);
      for (let i = 0; i < bytes.length; i++) bytes[i] = 32 + (i % 90);
    }
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], spec.name, { type: spec.mime, lastModified: Date.now() }));
    dt.effectAllowed = 'copy';
    drag = { dt, current: null, accepted: false };
  },
  over(x: number, y: number): void {
    if (!drag) return;
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    if (el !== drag.current) {
      const prev = drag.current;
      if (fireDrag('dragenter', el, x, y, prev)) drag.accepted = true;
      if (prev) fireDrag('dragleave', prev, x, y, el);
      drag.current = el;
    }
    if (fireDrag('dragover', el, x, y)) drag.accepted = true;
  },
  drop(x: number, y: number): DropOutcome {
    if (!drag) throw new Error('no file drag in progress');
    fileDrag.over(x, y);
    const el = drag.current ?? document.elementFromPoint(x, y) ?? document.body;
    const prevented = fireDrag('drop', el, x, y);
    const out = { accepted: drag.accepted || prevented, target: ref(el) };
    drag = null;
    return out;
  },
  cancel(): void {
    if (drag?.current) fireDrag('dragleave', drag.current, 0, 0, null);
    drag = null;
  },
};
