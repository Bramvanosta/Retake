/** Widgets: a row's menu trigger, confirm buttons, file inputs. */
import { deref, ref } from './refs.js';
import { INTERACTIVE, accessibleName } from './roles.js';
import { topDialog } from './scopes.js';
import { bestTier, textOf } from './text.js';
import { deepContains, deepHit, deepQsa, isA, rectOf, styleOf, upOf } from './trees.js';
import { isVisible } from './visibility.js';

// ───────────────────────────── widgets ─────────────────────────────
export const TRIGGER_NAME = /\b(actions?|more|menu|options|manage|settings|row actions)\b|…|⋯|⋮|•••|\.\.\./i;
/**
 * The menu trigger of a row (R-CHO-13): an [aria-haspopup] element (a menu-like name first, else the last one), a
 * button with a menu-like name, else the row's last button. When that last button is laid out but hidden (opacity or
 * visibility: actions shown on hover) and the row was not hovered yet, `hover` asks the runner to hover the row and
 * ask again (`hovered`), instead of taking a visible button of an earlier cell.
 */
export function menuTrigger(rowId: string, hovered = false): { ref: string | null; hover: boolean } {
  const row = deref(rowId);
  if (!row) return { ref: null, hover: false };
  const vis = (sel: string) => deepQsa(row, sel).filter((e) => isVisible(e));
  const popupTriggers = vis('[aria-haspopup=menu],[aria-haspopup=true]');
  const named = (e: Element) => TRIGGER_NAME.test(`${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''} ${textOf(e)}`);
  const pick = popupTriggers.find(named) ?? popupTriggers[popupTriggers.length - 1];
  if (pick) return { ref: ref(pick), hover: false };
  const buttons = vis('button,[role=button]');
  const byName = buttons.find(named);
  if (byName) return { ref: ref(byName), hover: false };
  if (!hovered) {
    const laidOut = deepQsa(row, 'button,[role=button],[aria-haspopup]:not([aria-haspopup=false])').filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    const lastOne = laidOut[laidOut.length - 1];
    if (lastOne && !isVisible(lastOne)) return { ref: null, hover: true };
  }
  const last = buttons[buttons.length - 1];
  return { ref: last ? ref(last) : null, hover: false };
}
export const CELL_SEL = 'td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]';
/** Clickable by itself: interactive, announcing a popup, an onclick attribute, or its own (not inherited) pointer cursor. */
function ownClickable(el: Element): boolean {
  if (el.matches(INTERACTIVE) || el.matches('[aria-haspopup]:not([aria-haspopup=false]),[onclick]')) return true;
  if (styleOf(el).cursor !== 'pointer') return false;
  const p = upOf(el);
  return !p || styleOf(p).cursor !== 'pointer';
}
/**
 * Positional last resort for a row's menu trigger (R-CHO-13): the clickable element at the row's right end (a sweep
 * from 8 to 64 px in from the right edge at mid-height), else at its top-right corner (18 px down: a card header's
 * corner icon). A hit counts only when it is clickable by itself, never a cell or the row (a clickable row's
 * inherited pointer cursor must not make a cell its "trigger"); the nearest clickable ancestor inside the row wins.
 */
export function positionalTrigger(rowId: string): { ref: string; where: string } | null {
  const row = deref(rowId);
  if (!row) return null;
  const r = rectOf(row);
  const W = window.innerWidth;
  const H = window.innerHeight;
  const lines: Array<[string, number]> = [
    ['right end', r.top + r.height / 2],
    ['top-right corner', r.top + Math.min(18, r.height / 2)],
  ];
  for (const [where, ly] of lines) {
    const y = Math.min(H - 1, Math.max(1, ly));
    for (let dx = 8; dx <= 64; dx += 8) {
      const x = Math.min(W - 1, Math.max(1, r.right - dx));
      const hit = deepHit(x, y);
      if (!hit || hit === row || !deepContains(row, hit)) continue;
      for (let el: Element | null = hit, i = 0; el && el !== row && i < 12; el = upOf(el), i++) {
        if (el.matches(CELL_SEL)) break;
        if (ownClickable(el)) return { ref: ref(el), where };
      }
    }
  }
  return null;
}
const CANCEL = /^(cancel|close|dismiss|back|no|not now|keep|annuler|fermer|non|abbrechen|cancelar|annulla)$/i;
export function confirmButton(text: string | null): string | null {
  const dlg = topDialog(true);
  if (!dlg) return null;
  const buttons = deepQsa(dlg, 'button,[role=button],input[type=submit],input[type=button]').filter((e) => isVisible(e));
  if (text !== null) {
    const best = bestTier(buttons, (e) => accessibleName(e), text, false);
    return best.length ? ref(best[0]) : null;
  }
  const ok = buttons.find((b) => !CANCEL.test(accessibleName(b)) && accessibleName(b) !== '');
  return ok ? ref(ok) : null;
}
export function fileInputFor(id: string): string | null {
  const zone = deref(id);
  if (!zone) return null;
  const isFile = (e: Element | null): e is HTMLInputElement => isA(e, 'input') && e.type === 'file';
  if (isFile(zone)) return ref(zone);
  const inside = zone.querySelector('input[type=file]');
  if (inside) return ref(inside);
  const lab = zone.closest('label');
  if (lab && isFile(lab.control)) return ref(lab.control);
  for (let p = zone.parentElement, d = 0; p && d < 3 && p !== zone.ownerDocument.body; p = p.parentElement, d++) {
    const all = p.querySelectorAll('input[type=file]');
    if (all.length === 1) return ref(all[0]);
    if (all.length > 1) break;
  }
  return null;
}
