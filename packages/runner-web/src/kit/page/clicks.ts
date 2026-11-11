/** Synthetic clicks and pointer sequences, dispatched in the element's own realm. */
import { RT } from './clock.js';
import { cursorApi } from './cursor.js';
import { deref } from './refs.js';
import { deepClosest, deepContains, deepHit, frameOffset, winOf } from './trees.js';

// ───────────────────────────── synthetic clicks ─────────────────────────────
function innerTarget(el: Element, x: number, y: number): Element {
  const hit = deepHit(x, y);
  return hit && deepContains(el, hit) ? hit : el;
}
function flashPress(): void {
  cursorApi.press(true);
  RT.setTimeout(() => cursorApi.press(false), 110);
}
// Synthetic events go to the element's realm at its frame-local coordinates; the ripple stays in top px.
export function domClick(id: string, x: number, y: number): void {
  const el = deref(id);
  if (!el) throw new Error('element is gone');
  const t = innerTarget(el, x, y);
  cursorApi.ripple(x, y);
  flashPress();
  if (typeof (t as HTMLElement).click === 'function') (t as HTMLElement).click();
  else {
    const realm = winOf(t) as Window & typeof globalThis;
    const o = frameOffset(t);
    t.dispatchEvent(new realm.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x - o.x, clientY: y - o.y, view: realm, detail: 1 }));
  }
}
export function pointerSequence(id: string, x: number, y: number): void {
  const el = deref(id);
  if (!el) throw new Error('element is gone');
  const t = innerTarget(el, x, y);
  cursorApi.ripple(x, y);
  flashPress();
  const realm = winOf(t) as Window & typeof globalThis;
  const o = frameOffset(t);
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x - o.x, clientY: y - o.y, screenX: x, screenY: y, view: realm, detail: 1, button: 0 };
  const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
  t.dispatchEvent(new realm.PointerEvent('pointerover', { ...ptr, buttons: 0 }));
  t.dispatchEvent(new realm.MouseEvent('mouseover', { ...base, buttons: 0 }));
  const downOk = t.dispatchEvent(new realm.PointerEvent('pointerdown', { ...ptr, buttons: 1, pressure: 0.5 }));
  let mdOk = true;
  if (downOk) mdOk = t.dispatchEvent(new realm.MouseEvent('mousedown', { ...base, buttons: 1 }));
  if (downOk && mdOk) {
    const focusable = deepClosest(
      t,
      'button,a[href],input,select,textarea,[tabindex],[contenteditable=""],[contenteditable=true]',
    ) as HTMLElement | null;
    focusable?.focus?.({ preventScroll: true });
  }
  t.dispatchEvent(new realm.PointerEvent('pointerup', { ...ptr, buttons: 0, pressure: 0 }));
  if (downOk) t.dispatchEvent(new realm.MouseEvent('mouseup', { ...base, buttons: 0 }));
  t.dispatchEvent(new realm.MouseEvent('click', { ...base, buttons: 0 }));
}
