/** Target checks: whether targets resolve, the elements closest to a missing one, a field's focus and value. */
import type { KitTargetCheck, KitTargetChecks, NearElement, ResolveMissing, ResolveResult } from '../types.js';
import type { TargetObject } from '@retake/core';
import { editableBody } from './fields.js';
import { host } from './host.js';
import { withMemo } from './memo.js';
import { deref, ref } from './refs.js';
import { describeEl, find, resolveScope, similarity } from './resolver.js';
import { INTERACTIVE, accessibleName, roleOf } from './roles.js';
import { short, textOf } from './text.js';
import { deepActive, deepContains, deepQsa, frameElOf, isA } from './trees.js';
import { isVisible } from './visibility.js';

export function checkTargets(list: TargetObject[]): KitTargetChecks {
  return withMemo(() => ({
    origin: location.origin,
    checks: list.map((t): KitTargetCheck => {
      let r: ResolveResult;
      try {
        r = find(t, {});
      } catch (e) {
        return { count: 0, index: null, in_view: null, bbox: null, hidden: 0, scope_found: true, desc: short((e as Error).message, 200), near: [] };
      }
      if (r.count > 0 && 'ref' in r) return { count: r.count, index: r.index, in_view: r.in_view, bbox: r.bbox, hidden: 0, scope_found: true, desc: r.desc, near: [] };
      const miss = r as ResolveMissing;
      return { count: 0, index: null, in_view: null, bbox: null, hidden: miss.hidden, scope_found: miss.scope_found, desc: miss.desc, near: miss.near };
    }),
  }));
}

// ───────────────────────────── reliability checks (L5.6) ─────────────────────────────
/** The visible elements closest to a query (R-FLD-10): role, accessible name and text, most similar first. */
function nearElements(query: string, root: Element, max = 3): NearElement[] {
  if (!query) return [];
  const sel = `${INTERACTIVE},h1,h2,h3,h4,h5,h6,[role=heading],th,legend,[aria-label]`;
  const seen = new Set<string>();
  const scored: Array<{ e: NearElement; s: number }> = [];
  let n = 0;
  for (const el of deepQsa(root, sel)) {
    if (++n > 800) break;
    // A label names its control: the control is listed, not the label.
    if (el === host || isA(el, 'label') || !isVisible(el)) continue;
    const name = short(accessibleName(el), 60);
    const text = short(textOf(el), 60);
    const key = `${roleOf(el) ?? el.tagName}|${name}|${text}`;
    if ((!name && !text) || seen.has(key)) continue;
    seen.add(key);
    const s = Math.max(name ? similarity(query, name) : 0, text ? similarity(query, text) : 0);
    if (s < 0.25) continue;
    const e: NearElement = { role: roleOf(el) ?? el.tagName.toLowerCase() };
    if (name) e.name = name;
    if (text && text !== name) e.text = text;
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map((x) => x.e);
}
/** `find` for each target, without acting (R-FLD-10): its visible count and, when it has none, the closest elements. */
export function closest(list: TargetObject[]): Array<{ count: number; near: NearElement[] }> {
  return withMemo(() =>
    list.map((t) => {
      let count = 0;
      try {
        count = find(t, {}).count;
      } catch {
        count = 0;
      }
      if (count > 0) return { count, near: [] };
      const query = t.text ?? t.name ?? t.aria ?? t.label ?? t.placeholder ?? (Array.isArray(t.contains) ? t.contains.join(' ') : t.contains) ?? '';
      const root = resolveScope(t.in) ?? document.body ?? document.documentElement;
      return { count: 0, near: nearElements(query, root) };
    }),
  );
}
/**
 * After the click of a `type` step (R-FLD-11): is the focused element the field (or inside it, or the control of the
 * label clicked)? `desc` names what has the focus (null: nothing, the page itself), `field` is its ref.
 */
export function focusCheck(id: string): { ok: boolean; desc: string | null; field: string | null } {
  const el = deref(id);
  let act = deepActive();
  if (act && (act === act.ownerDocument.body || act === act.ownerDocument.documentElement) && !editableBody(act)) act = null;
  if (!el) return { ok: false, desc: act ? describeEl(act) : null, field: act ? ref(act) : null };
  if (!act) return { ok: false, desc: null, field: null };
  const label = isA(el, 'label') ? el.control : null;
  const ok = act === el || deepContains(el, act) || act === label || (act.ownerDocument !== el.ownerDocument && deepContains(el, frameElOf(act.ownerDocument)));
  // A field inside the target's own widget (a wrapper the target named): still the target.
  const inWidget = !ok && deepContains(act, el) && (isA(act, 'input') || isA(act, 'textarea') || (act as HTMLElement).isContentEditable === true);
  return { ok: ok || inWidget, desc: describeEl(act), field: ref(act) };
}
/** A field's text (R-FLD-11): an input's or textarea's value, a contenteditable's text; null for anything else. */
export function fieldValue(id: string | null): string | null {
  const el = id ? deref(id) : deepActive();
  if (!el) return null;
  if (isA(el, 'input') || isA(el, 'textarea')) return el.value;
  if ((el as HTMLElement).isContentEditable === true || editableBody(el)) {
    const t = (el as HTMLElement).innerText;
    return typeof t === 'string' ? t.replace(/\n$/, '') : (el.textContent ?? '');
  }
  return null;
}
