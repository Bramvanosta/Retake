/** Fields: native selects, text fields, what a field holds and how it is cleared (typing). */
import type { FieldState } from '../types.js';
import { deref } from './refs.js';
import { accessibleName, explicitRole } from './roles.js';
import { FLOATING_SEL } from './scopes.js';
import { bestTier, lc, norm } from './text.js';
import { deepActive, deepClosest, deepQsa, flatParent, isA, styleOf, winOf } from './trees.js';
import { isVisible } from './visibility.js';

export function selectNative(id: string, option: string): { ok: boolean; label?: string; options: string[] } {
  const el = deref(id);
  if (!isA(el, 'select')) return { ok: false, options: [] };
  const opts = Array.from(el.options);
  const labels = opts.map((o) => norm(o.label || o.text));
  const best = bestTier(opts, (o) => norm(o.label || o.text), option, false);
  const o = best[0] ?? opts.find((x) => x.value === option);
  if (!o) return { ok: false, options: labels };
  // The element's own realm (a <select> in a frame): its prototype's setter and its Event constructor.
  const realm = winOf(el) as Window & typeof globalThis;
  const setter = Object.getOwnPropertyDescriptor(realm.HTMLSelectElement.prototype, 'value')?.set;
  if (setter) setter.call(el, o.value);
  else el.value = o.value;
  el.dispatchEvent(new realm.Event('input', { bubbles: true }));
  el.dispatchEvent(new realm.Event('change', { bubbles: true }));
  return { ok: true, label: norm(o.label || o.text), options: labels };
}
export function textField(el: Element): boolean {
  if (isA(el, 'textarea')) return true;
  if (isA(el, 'input')) {
    return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}
export function isTextInput(id: string | null): boolean {
  const el = id ? deref(id) : deepActive();
  return !!el && textField(el);
}
/** Words of a field's name, id, placeholder, label or title that make it a search field (camelCase / snake_case split). */
const SEARCH_WORDS = /\b(search|filter|find|look ?up|recherche[r]?|filtrer|such(e|en)|buscar|cerca)\b/i;
/** The body of a document edited in place (contenteditable or designMode: the rich-text editors drawn in a frame). */
export function editableBody(el: Element): boolean {
  const doc = el.ownerDocument;
  if (el !== doc.body && el !== doc.documentElement) return false;
  return (el as HTMLElement).isContentEditable === true || doc.designMode === 'on';
}
/**
 * A field the viewer can see some of: visible, and not clipped to a sliver by an `overflow: hidden` ancestor (the
 * hidden input of an editor that draws its text elsewhere sits in a 0–3 px box). Scrolling ancestors are ignored.
 */
function shownField(el: Element): boolean {
  if (!isVisible(el)) return false;
  const rc = el.getBoundingClientRect();
  let [l, t, r, b] = [rc.left, rc.top, rc.right, rc.bottom];
  const doc = el.ownerDocument;
  for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
    const cs = styleOf(p);
    if (!/(hidden|clip)/.test(cs.overflowX + cs.overflowY) || /(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY)) continue;
    const pr = p.getBoundingClientRect();
    [l, t, r, b] = [Math.max(l, pr.left), Math.max(t, pr.top), Math.min(r, pr.right), Math.min(b, pr.bottom)];
  }
  return r - l >= 4 && b - t >= 4;
}
const LIST_SEL = '[role=listbox],[role=menu]';
/**
 * The field typed into (R-CHO-14, R-CHO-15): editable or not, empty or not (never its value: it may be a secret)
 * and its kind — `search` (type=search, searchbox, combobox, autocomplete list, inside a search landmark or an open
 * floating popover that lists options, or named like one), `multiline` (textarea, contenteditable, a frame's edited
 * body) or `text`. `known`: the kit reads it — a shown input or textarea, or edited text; an editor's hidden input
 * (clipped or a pixel wide: what the viewer sees is drawn elsewhere) or any other element is not read (its `empty`
 * means nothing).
 */
export function fieldState(id: string | null): FieldState | null {
  const el = id ? deref(id) : deepActive();
  if (!el) return null;
  const body = el === el.ownerDocument.body || el === el.ownerDocument.documentElement;
  if (body && !editableBody(el)) return null;
  const ce = body || (!isA(el, 'input') && !isA(el, 'textarea') && (el as HTMLElement).isContentEditable === true);
  const field = isA(el, 'input') || isA(el, 'textarea');
  const editable = (ce || (field && textField(el))) && !(field && ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly));
  const empty = field ? (el as HTMLInputElement).value === '' : norm(el.textContent) === '';
  const known = ce || (field && shownField(el));
  if (isA(el, 'textarea') || ce) return { editable, empty, kind: 'multiline', known };
  const role = explicitRole(el);
  const attr = (n: string) => lc(el.getAttribute(n) ?? '');
  let search = (isA(el, 'input') && el.type === 'search') || role === 'searchbox' || role === 'combobox';
  search ||= attr('aria-autocomplete') === 'list' || attr('aria-autocomplete') === 'both' || attr('enterkeyhint') === 'search';
  search ||= deepClosest(el, '[role=search],search') !== null;
  // Inside an open floating popover that lists options (a listbox's filter); never a modal or anchored dialog, nor a
  // popover holding a small form (a rename field): their fields are not searches.
  const pop = deepClosest(el, FLOATING_SEL);
  search ||=
    pop !== null &&
    !pop.matches('dialog,[aria-modal=true],[role=dialog]:not([data-side]),[role=alertdialog]') &&
    (pop.matches(LIST_SEL) || deepQsa(pop, LIST_SEL).length > 0);
  if (!search) {
    const names = ['name', 'id', 'placeholder', 'aria-label', 'title'].map((n) => el.getAttribute(n) ?? '');
    names.push(accessibleName(el));
    search = names.some((n) => SEARCH_WORDS.test(n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')));
  }
  return { editable, empty, kind: search ? 'search' : 'text', known };
}
/**
 * Clear the field when select-all + delete did not (R-CHO-15): the value setter of the element's own prototype (what
 * React's value tracker sees as a change) + an `input` event; contenteditable: selectAll + delete commands.
 */
export function clearField(id: string | null): 'setter' | 'editor' | null {
  const el = id ? deref(id) : deepActive();
  if (!el) return null;
  const realm = winOf(el) as Window & typeof globalThis;
  if (isA(el, 'input') || isA(el, 'textarea')) {
    const proto = isA(el, 'input') ? realm.HTMLInputElement.prototype : realm.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, '');
    else el.value = '';
    el.dispatchEvent(new realm.Event('input', { bubbles: true }));
    return 'setter';
  }
  if ((el as HTMLElement).isContentEditable || editableBody(el)) {
    (el as HTMLElement).focus();
    el.ownerDocument.execCommand('selectAll');
    el.ownerDocument.execCommand('delete');
    return 'editor';
  }
  return null;
}
