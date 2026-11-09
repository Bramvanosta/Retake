/** Dialogs and popovers: the topmost visible one. */
import { host } from './host.js';
import { deepQsa, hostParent } from './trees.js';
import { isVisible } from './visibility.js';

// ───────────────────────────── scopes ─────────────────────────────
const DIALOG_SEL = '[role=dialog],[role=alertdialog],dialog[open]';
export const FLOATING_SEL =
  '[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[popover],[role=dialog][data-side],[data-side][data-open],[data-floating-ui-portal] > *';
export function isFloating(el: Element): boolean {
  if (el.closest('[data-radix-popper-content-wrapper]')) return true;
  if (el.hasAttribute('data-side')) return true;
  if (el.hasAttribute('popover') && el !== host) return true;
  return false;
}
export function isPopoverOpen(el: Element): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return false;
  }
}
export function lastVisible(els: Iterable<Element>, ok: (e: Element) => boolean = () => true): Element | null {
  let last: Element | null = null;
  for (const e of els) if (e !== host && ok(e) && isVisible(e)) last = e;
  return last;
}
export function topDialog(preferAlert: boolean, skip?: (e: Element) => boolean): Element | null {
  const all = deepQsa(document, DIALOG_SEL).filter((e) => isVisible(e) && !skip?.(e));
  if (!all.length) return null;
  if (preferAlert) {
    const alerts = all.filter((e) => e.matches('[role=alertdialog]'));
    if (alerts.length) return alerts[alerts.length - 1];
  }
  const modal = all.filter((e) => {
    try {
      return e.matches(':modal');
    } catch {
      return false;
    }
  });
  if (modal.length) return modal[modal.length - 1];
  const anchored = all.filter((e) => !isFloating(e));
  const pool = anchored.length ? anchored : all;
  return pool[pool.length - 1];
}
export function topPopover(): Element | null {
  const cands = deepQsa(document, FLOATING_SEL).filter(
    (e) => e !== host && !e.matches('[role=menubar]') && (!e.hasAttribute('popover') || isPopoverOpen(e)),
  );
  let last = lastVisible(cands);
  if (!last) return null;
  // Climb to the outermost floating layer of that group (popper wrapper around a listbox…).
  for (let p = hostParent(last); p && p !== p.ownerDocument.body; p = hostParent(p)) {
    if (cands.includes(p)) last = p;
  }
  return last;
}
