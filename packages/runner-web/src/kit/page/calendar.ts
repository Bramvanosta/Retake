/** Calendars: the open date picker's month, days and navigation; a native date input set in place. */
import type { CalendarInfo } from '../types.js';
import { host } from './host.js';
import { POPUP_SEL, popupIds, popupState } from './placement.js';
import { deref, ref } from './refs.js';
import { accessibleName } from './roles.js';
import { FLOATING_SEL, isPopoverOpen } from './scopes.js';
import { norm, short, textOf } from './text.js';
import { deepClosest, deepContains, deepQsa, isA, rectOf, upOf, winOf } from './trees.js';
import { CELL_SEL } from './triggers.js';
import { isVisible } from './visibility.js';

// ───────────────────────────── calendars (R-CHO-24) ─────────────────────────────
const DAY_ATTRS = ['data-date', 'data-day', 'datetime', 'data-value'];
const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/;
const YEAR_RE = /\b(1[89]|2\d)\d{2}\b/;
const NEXT_NAV = /\b(next|following|forward|suivant|n[aä]chste[rn]?|siguiente|successivo)\b|^\s*[›»→>]\s*$|chevron right|arrow right/i;
const PREV_NAV = /\b(prev(ious)?|back|earlier|pr[eé]c[eé]dent|vorherige[rn]?|anterior|precedente)\b|^\s*[‹«←<]\s*$|chevron left|arrow left/i;
function dayIso(el: Element): string | null {
  for (const a of DAY_ATTRS) {
    const m = el.getAttribute(a)?.match(ISO_DAY);
    if (m) return m[0];
  }
  return null;
}
/** A day cell, on any tag: a date attribute, or a short aria-label with a year and a day number. */
function isDayCell(el: Element): boolean {
  if (el === host) return false;
  const r = el.getBoundingClientRect();
  if (r.width > 140 || r.height > 140) return false;
  if (dayIso(el)) return true;
  const al = el.getAttribute('aria-label');
  return !!al && al.length <= 80 && YEAR_RE.test(al) && /\b\d{1,2}(st|nd|rd|th)?\b/.test(al.replace(YEAR_RE, ' '));
}
/** Texts a month button is known by: its name, title and class words. */
function navTexts(el: Element): string[] {
  const cls = el.getAttribute('class') ?? '';
  return [accessibleName(el), el.getAttribute('title') ?? '', cls.replace(/[-_]+/g, ' ')];
}
function dayFlag(c: Element, sel: string): boolean {
  const cell = deepClosest(c, CELL_SEL);
  return c.matches(sel) || (cell !== null && cell !== c && cell.matches(sel));
}
const NAV_BUTTON = 'button,[role=button],a[href]';
/** A button that would submit or reset its form (a wizard's "Next"): never a month button. */
function formButton(b: Element): boolean {
  if (!isA(b, 'button') && !isA(b, 'input')) return false;
  const el = b as HTMLInputElement;
  return el.form !== null && ['submit', 'reset', 'image'].includes(el.type);
}
/**
 * The calendar on screen: the innermost floating popup holding day cells (the last one opened), else the inline
 * calendar around the last visible day cells — from there up to the first ancestor holding a month button (≤ 10
 * levels, never onto a form or the body; from a floating popup, never out of the popup layer: a library that makes
 * each month a listbox keeps its month buttons in the popup around them). A month button is a button, link or
 * element classed next / prev (not inside a button) near the days — above them or beside them, never below (a
 * wizard's Back / Next) — and never a form's submit. The LAST visible ones count (a month name first, never a year
 * button when another exists); its days in composed order, with their aria-label (or text), the date of their
 * attributes, disabled and outside-month flags.
 */
export function calendar(): CalendarInfo | null {
  popupState(); // popup ids
  const all = deepQsa(document, '[aria-label],[data-date],[data-day],[datetime],[data-value]').filter((e) => isDayCell(e) && isVisible(e));
  const cells = all.filter((c) => !all.some((o) => o !== c && deepContains(c, o)));
  if (!cells.length) return null;
  const isNav = (b: Element) => navTexts(b).some((t) => NEXT_NAV.test(t) || PREV_NAV.test(t));
  const navs = (root: Element) => {
    const mine = cells.filter((c) => deepContains(root, c));
    if (!mine.length) return [];
    const rs = mine.map(rectOf);
    const box = { l: Math.min(...rs.map((r) => r.left)), t: Math.min(...rs.map((r) => r.top)), r: Math.max(...rs.map((r) => r.right)), b: Math.max(...rs.map((r) => r.bottom)) };
    const near = (b: Element) => {
      const r = rectOf(b);
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      return cx >= box.l - 80 && cx <= box.r + 80 && cy >= box.t - 160 && cy <= box.b;
    };
    return deepQsa(root, `${NAV_BUTTON},[class*=next i],[class*=prev i]`).filter(
      (b) =>
        (b.matches(NAV_BUTTON) || (isNav(b) && !deepClosest(upOf(b), NAV_BUTTON) && !b.querySelector(NAV_BUTTON))) &&
        !cells.includes(b) &&
        !cells.some((c) => deepContains(b, c)) &&
        !formButton(b) &&
        isVisible(b) &&
        near(b),
    );
  };
  const floats = deepQsa(document, FLOATING_SEL).filter(
    (e) => e !== host && (!e.hasAttribute('popover') || isPopoverOpen(e)) && cells.some((c) => deepContains(e, c)) && isVisible(e),
  );
  const LAYER = `${POPUP_SEL},${FLOATING_SEL}`;
  const climb = (start: Element, inPopup: boolean): Element => {
    let r = start;
    for (let i = 0; i < 10; i++) {
      if (navs(r).some(isNav)) return r;
      const up = upOf(r);
      if (!up || up === up.ownerDocument.body || up === up.ownerDocument.documentElement || up.matches('form,[role=form]')) break;
      if (inPopup && !deepClosest(up, LAYER)) break;
      r = up;
    }
    return inPopup ? start : r;
  };
  const float = floats.length ? floats[floats.length - 1] : null;
  const first = float ?? upOf(cells[cells.length - 1]);
  const root = first ? climb(first, float !== null) : null;
  if (!root) return null;
  const mine = cells.filter((c) => deepContains(root, c));
  const own = navs(root);
  const pickNav = (re: RegExp): string | null => {
    const m = own.filter((b) => navTexts(b).some((t) => re.test(t)));
    const month = m.filter((b) => navTexts(b).some((t) => /month|mois|monat|\bmes\b/i.test(t)));
    const notYear = m.filter((b) => !navTexts(b).some((t) => /year|ann[ée]e|jahr|a[ñn]o\b/i.test(t)));
    const pool = month.length ? month : notYear.length ? notYear : m;
    return pool.length ? ref(pool[pool.length - 1]) : null;
  };
  const popEl = floats.length ? deepClosest(root, POPUP_SEL) : null;
  return {
    popup: popEl ? (popupIds.get(popEl) ?? null) : null,
    next: pickNav(NEXT_NAV),
    prev: pickNav(PREV_NAV),
    days: mine.map((c) => ({
      ref: ref(c),
      label: norm(c.getAttribute('aria-label')) || short(textOf(c), 40),
      iso: dayIso(c),
      disabled:
        (c as HTMLButtonElement).disabled === true ||
        dayFlag(c, '[aria-disabled=true],[data-disabled]:not([data-disabled=false])'),
      outside: dayFlag(c, '[data-outside],[data-outside-month],[class*=outside],[class*=other-month],[class*=adjacent]'),
    })),
  };
}
/**
 * Set a native input (type=date…) in place: its realm's value setter, then `input` and `change`. A value it would not
 * take — out of its min / max or step, not a value of its type — is refused before anything is set (checked on a copy).
 */
export function setNativeValue(id: string, value: string): boolean {
  const el = deref(id);
  if (!isA(el, 'input')) return false;
  const probe = el.cloneNode(false) as HTMLInputElement;
  probe.value = value;
  const v = probe.validity;
  if (probe.value !== value || v.rangeUnderflow || v.rangeOverflow || v.stepMismatch || v.badInput) return false;
  const realm = winOf(el) as Window & typeof globalThis;
  const setter = Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new realm.Event('input', { bubbles: true }));
  el.dispatchEvent(new realm.Event('change', { bubbles: true }));
  return el.value === value;
}
