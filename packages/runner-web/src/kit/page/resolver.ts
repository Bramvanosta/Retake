/** The resolver: rows, scopes and the matching of a target to elements (`find`). */
import type { FindOptions, ResolveResult } from '../types.js';
import type { ScopeSpec, TargetObject } from '@retake/core/model';
import { host } from './host.js';
import { memo } from './memo.js';
import { deref, ref } from './refs.js';
import { INTERACTIVE, accessibleName, byRole, explicitRole, hasRole, idsText, nameText, promote, roleOf, treeOf } from './roles.js';
import { FLOATING_SEL, lastVisible, topDialog, topPopover } from './scopes.js';
import { BUTTON_INPUT, SKIP_TAGS, bestTier, lc, lowText, norm, short, textOf, tierOf } from './text.js';
import type { Tier } from './text.js';
import { deepClosest, deepCompare, deepContains, deepQsa, flatParent, hostParent, isA, trees } from './trees.js';
import { bboxOf, directText, inView, isVisible } from './visibility.js';

export const ROW_SEL = '[role=row],tr,[role=listitem],li';
export function rowFor(text: string): Element | null {
  if (!memo) return rowForLive(text);
  let v = memo.rows.get(text);
  if (v === undefined) memo.rows.set(text, (v = rowForLive(text)));
  return v;
}
function rowForLive(text: string): Element | null {
  const q = norm(text);
  const ql = lc(q);
  const rows = deepQsa(document, ROW_SEL).filter((r) => lowText(r).includes(ql) && isVisible(r));
  // Innermost rows only (a row containing a matching nested row is dropped).
  const inner = rows.filter((r) => !rows.some((o) => o !== r && r.contains(o)));
  if (inner.length) {
    const exactCell = inner.find((r) => Array.from(r.querySelectorAll('*')).some((c) => c.children.length === 0 && lowText(c) === ql));
    return exactCell ?? inner[0];
  }
  // Card layouts: climb from the text to the first ancestor that holds a button.
  const hits = textSearch(document.body, q, false).filter((h) => isVisible(h.el));
  for (const h of hits) {
    for (let p: Element | null = h.el; p && p !== p.ownerDocument.body; p = hostParent(p)) {
      if (p.querySelector('button,[role=button],[aria-haspopup]') && p !== h.el) return p;
    }
  }
  return null;
}
export function resolveScope(s: ScopeSpec | undefined): Element | null {
  if (s === undefined || s === 'page') return document.body ?? document.documentElement;
  if (s === 'dialog') return topDialog(false);
  if (s === 'menu') return lastVisible(deepQsa(document, '[role=menu]'));
  if (s === 'listbox') return lastVisible(deepQsa(document, '[role=listbox]'));
  if (s === 'popover') return topPopover();
  if (typeof s === 'object' && 'row' in s && typeof (s as { row: unknown }).row === 'string') {
    return rowFor((s as { row: string }).row);
  }
  const r = find(s as TargetObject, { promote: false });
  return r.count > 0 && 'ref' in r ? deref(r.ref) : null;
}

// ───────────────────────────── matching ─────────────────────────────
interface Hit {
  el: Element;
  tier: Tier;
}
/** Text of a shadow root without its style/script children (what it renders, as text). */
function shadowText(sr: ShadowRoot): string {
  return norm(
    Array.from(sr.childNodes)
      .map((c) => (c.nodeType === 3 ? c.textContent : c.nodeType === 1 && !SKIP_TAGS.has((c as Element).tagName) ? c.textContent : ''))
      .join(' '),
  );
}
/** Innermost elements whose text contains `q`, with their match tier (in every tree under `root`). */
function textSearch(root: Element, q: string, exactOnly: boolean): Hit[] {
  const qn = norm(q);
  const ql = lc(qn);
  const out: Hit[] = [];
  if (!ql) return out;
  const visit = (el: Element) => {
    let childHas = false;
    for (const c of Array.from(el.children)) {
      if (SKIP_TAGS.has(c.tagName)) continue;
      if (lowText(c).includes(ql)) {
        childHas = true;
        visit(c);
      }
    }
    if (!childHas) {
      const t = tierOf(textOf(el), qn, exactOnly);
      if (t >= 0) out.push({ el, tier: t as Tier });
    }
  };
  for (const tree of trees(root).list) {
    if (tree.nodeType === 1) {
      if (lowText(tree).includes(ql)) visit(tree as Element);
    } else {
      const sr = tree as ShadowRoot;
      if (!lc(shadowText(sr)).includes(ql)) continue;
      let childHas = false;
      for (const c of Array.from(sr.children)) {
        if (SKIP_TAGS.has(c.tagName) || !lowText(c).includes(ql)) continue;
        childHas = true;
        visit(c);
      }
      // Text placed directly in the shadow root: its host shows it.
      if (!childHas) {
        const t = tierOf(directText(sr), qn, exactOnly);
        if (t >= 0) out.push({ el: sr.host, tier: t as Tier });
      }
    }
    for (const inp of Array.from(tree.querySelectorAll(BUTTON_INPUT))) {
      const t = tierOf(textOf(inp), qn, exactOnly);
      if (t >= 0) out.push({ el: inp, tier: t as Tier });
    }
  }
  return out;
}
function containsSearch(root: Element, parts: string[]): Element[] {
  const ps = parts.map((p) => lc(norm(p))).filter(Boolean);
  const out: Element[] = [];
  if (!ps.length) return out;
  const holds = (text: string) => {
    const t = lc(norm(text));
    return ps.every((p) => t.includes(p));
  };
  const has = (el: Element) => ps.every((p) => lowText(el).includes(p));
  const visit = (el: Element) => {
    let childHas = false;
    for (const c of Array.from(el.children)) {
      if (SKIP_TAGS.has(c.tagName)) continue;
      if (has(c)) {
        childHas = true;
        visit(c);
      }
    }
    if (!childHas) out.push(el);
  };
  for (const tree of trees(root).list) {
    if (tree.nodeType === 1) {
      if (has(tree as Element)) visit(tree as Element);
      continue;
    }
    const sr = tree as ShadowRoot;
    if (!holds(shadowText(sr))) continue;
    let childHas = false;
    for (const c of Array.from(sr.children)) {
      if (SKIP_TAGS.has(c.tagName) || !has(c)) continue;
      childHas = true;
      visit(c);
    }
    if (!childHas) out.push(sr.host);
  }
  return out;
}
/** The control a <label> designates: its `control`, its `for` id in its own tree, else a control inside it. */
export function labelTarget(lab: Element): Element | null {
  let control: Element | null = (lab as HTMLLabelElement).control;
  if (!control) {
    const f = lab.getAttribute('for');
    if (f) control = treeOf(lab).getElementById(f);
  }
  return control ?? lab.querySelector('input,select,textarea,button,[role=combobox],[role=textbox],[contenteditable]');
}
export function labelPairs(root: Element): Array<{ control: Element; text: string }> {
  const cached = memo?.labels.get(root);
  if (cached) return cached.slice();
  const out: Array<{ control: Element; text: string }> = [];
  for (const lab of deepQsa(root, 'label')) {
    const control = labelTarget(lab);
    if (control) out.push({ control, text: norm(nameText(lab, control)) });
  }
  for (const el of deepQsa(root, '[aria-labelledby]')) {
    out.push({ control: el, text: idsText(el.getAttribute('aria-labelledby') ?? '', el, el) });
  }
  memo?.labels.set(root, out.slice());
  return out;
}
function uniq(els: Element[]): Element[] {
  const seen = new Set<Element>();
  const out: Element[] = [];
  for (const e of els) {
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}
/** Document order; across shadow roots and frames, composed visual order (deepCompare). */
function docOrder(els: Element[]): Element[] {
  return els.sort(deepCompare);
}
export function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}
/** `root` and its descendants matching `sel`, in every tree (a selector never crosses a shadow or frame boundary). */
function safeQsa(root: Element, sel: string): Element[] {
  try {
    return deepQsa(root, sel, true);
  } catch (e) {
    throw new Error(`invalid CSS selector ${JSON.stringify(sel)}: ${(e as Error).message}`);
  }
}

export interface Matched {
  visible: Element[];
  hidden: number;
}
export function match(t: TargetObject, root: Element, opts: FindOptions): Matched {
  const exact = t.exact === true;
  const contains = t.contains === undefined ? undefined : Array.isArray(t.contains) ? t.contains : [t.contains];
  let base: Element[];
  let used: string;
  let hidden = 0;
  const vis0 = (e: Element) => e !== host && (opts.include_hidden === true || isVisible(e));
  // Text tiers are chosen on the searched document's own matches first (bestTier `own`).
  const home = root.ownerDocument;
  const own = (e: Element) => e.ownerDocument === home;
  const keepVisible = (els: Element[]) => {
    const vis = els.filter(vis0);
    hidden += els.length - vis.length;
    return vis;
  };
  if (t.css !== undefined) {
    base = keepVisible(safeQsa(root, t.css));
    used = 'css';
  } else if (t.testid !== undefined) {
    base = keepVisible(safeQsa(root, `[data-testid="${cssEscape(t.testid)}"]`));
    used = 'testid';
  } else if (t.role !== undefined) {
    base = keepVisible(byRole(root, t.role.toLowerCase()));
    used = 'role';
  } else if (t.label !== undefined) {
    const pairs = labelPairs(root).filter((p) => vis0(p.control));
    let best = bestTier(
      pairs,
      (p) => p.text,
      t.label,
      exact,
      (p) => own(p.control),
    ).map((p) => p.control);
    if (!best.length) {
      const trig = fieldTriggerEl(t.label, root);
      if (trig) best = [trig];
    }
    base = best;
    used = 'label';
  } else if (t.aria !== undefined) {
    const all = keepVisible(safeQsa(root, '[aria-label]'));
    base = bestTier(all, (e) => norm(e.getAttribute('aria-label')), t.aria, exact, own);
    used = 'aria';
  } else if (t.placeholder !== undefined) {
    const all = keepVisible(safeQsa(root, '[placeholder]'));
    base = bestTier(all, (e) => norm(e.getAttribute('placeholder')), t.placeholder, exact, own);
    used = 'placeholder';
  } else if (contains !== undefined) {
    const raw = containsSearch(root, contains);
    const vis = keepVisible(raw);
    base = opts.promote === false ? vis : vis.map((e) => promote(e, root));
    used = 'contains';
  } else if (t.text !== undefined) {
    const hits = textSearch(root, t.text, exact);
    const visHits = hits.filter((h) => vis0(h.el));
    hidden += hits.length - visHits.length;
    const mine = visHits.filter((h) => own(h.el));
    const best = Math.min(...(mine.length ? mine : visHits).map((h) => h.tier));
    base = visHits.filter((h) => h.tier === best).map((h) => (opts.promote === false ? h.el : promote(h.el, root)));
    used = 'text';
  } else {
    return { visible: [root], hidden: 0 };
  }
  let els = docOrder(uniq(base));
  // Remaining keys act as filters.
  if (used !== 'css' && t.css !== undefined) els = els.filter((e) => e.matches(t.css as string));
  if (used !== 'testid' && t.testid !== undefined) els = els.filter((e) => e.getAttribute('data-testid') === t.testid);
  if (used !== 'role' && t.role !== undefined) els = els.filter((e) => hasRole(e, (t.role as string).toLowerCase()));
  if (t.name !== undefined) els = bestTier(els, accessibleName, t.name, exact, own);
  if (used !== 'label' && t.label !== undefined) {
    const pairs = labelPairs(root);
    els = els.filter((e) => pairs.some((p) => p.control === e && tierOf(p.text, norm(t.label), exact) >= 0));
  }
  if (used !== 'aria' && t.aria !== undefined) els = bestTier(els, (e) => norm(e.getAttribute('aria-label')), t.aria, exact);
  if (used !== 'placeholder' && t.placeholder !== undefined) {
    els = bestTier(els, (e) => norm(e.getAttribute('placeholder')), t.placeholder, exact);
  }
  if (used !== 'text' && t.text !== undefined) els = bestTier(els, textOf, t.text, exact);
  if (used !== 'contains' && contains !== undefined) {
    const ps = contains.map((p) => lc(norm(p)));
    els = els.filter((e) => ps.every((p) => lc(norm(e.textContent)).includes(p)));
  }
  return { visible: els, hidden };
}

export function similarity(a: string, b: string): number {
  const al = lc(a);
  const bl = lc(b);
  if (!al || !bl) return 0;
  if (bl.includes(al) || al.includes(bl)) return 0.9;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(al);
  const gb = grams(bl);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / Math.max(1, al.length - 1 + bl.length - 1);
}
function nearTexts(query: string, root: Element): string[] {
  const sel = `${INTERACTIVE},h1,h2,h3,h4,h5,h6,[role=heading],[role=row],td,th,legend,[aria-label]`;
  const seen = new Set<string>();
  const scored: Array<{ t: string; s: number }> = [];
  let n = 0;
  for (const el of deepQsa(root, sel)) {
    if (++n > 600) break;
    if (!isVisible(el)) continue;
    const t = short(accessibleName(el) || textOf(el), 60);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    scored.push({ t, s: query ? similarity(query, t) : 0 });
  }
  // Most similar first; the rest of what is on screen fills the list (context for the error message).
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 8).map((x) => x.t);
}

export function describeEl(el: Element): string {
  const role = roleOf(el);
  const tag = el.tagName.toLowerCase();
  const name = short(accessibleName(el), 50);
  return `${role ?? tag}${name ? ` "${name}"` : ''}`;
}
export function popupExpected(el: Element): boolean {
  const hp = el.getAttribute('aria-haspopup');
  if (hp && hp !== 'false') return true;
  if (el.getAttribute('aria-expanded') === 'false') return true;
  return explicitRole(el) === 'combobox';
}

/**
 * Matches behind an open modal dialog cannot be used (R-FLD-11: a field "found" behind the dialog had its point on
 * another field of the dialog): when some matches are inside the topmost modal dialog — `:modal`, aria-modal, or the
 * rest of the page aria-hidden / inert, as dialog libraries leave it — or in a floating layer above it (a listbox, a
 * menu portaled to the body), the others are dropped. With none there, every match stays (a toast outside the dialog).
 */
function unblocked(els: Element[]): Element[] {
  const modal = topDialog(false);
  if (!modal) return els;
  let isModal = modal.getAttribute('aria-modal') === 'true';
  try {
    isModal ||= modal.matches(':modal');
  } catch {
    /* no :modal support */
  }
  const free = (e: Element) => deepContains(modal, e) || deepClosest(e, FLOATING_SEL) !== null;
  const blocked = (e: Element) => !free(e) && (isModal || deepClosest(e, '[aria-hidden=true],[inert]') !== null);
  const keep = els.filter((e) => !blocked(e));
  return keep.length > 0 && keep.length < els.length ? keep : els;
}
export function find(t: TargetObject, opts: FindOptions = {}): ResolveResult {
  const root = resolveScope(t.in);
  const query = t.text ?? t.name ?? t.aria ?? t.label ?? t.placeholder ?? (Array.isArray(t.contains) ? t.contains.join(' ') : t.contains) ?? '';
  if (!root) {
    return { count: 0, desc: '', hidden: 0, scope_found: false, near: nearTexts(query, document.body ?? document.documentElement) };
  }
  const m = match(t, root, opts);
  if (t.in === undefined && m.visible.length > 1) m.visible = unblocked(m.visible);
  const n = m.visible.length;
  let index = 0;
  if (t.last_visible) index = n - 1;
  if (t.nth !== undefined) index = t.nth < 0 ? n + t.nth : t.nth;
  if (n === 0 || index < 0 || index >= n) {
    // Frames this kit cannot enter (another origin): say so, a target inside one is not a mystery.
    const cross = n > 0 ? 0 : trees(root).cross;
    return {
      count: 0,
      desc: n > 0 ? `nth=${t.nth} out of range (${n} visible matches)` : cross > 0 ? `${cross} cross-origin frame${cross > 1 ? 's' : ''} not searched` : '',
      hidden: m.hidden,
      scope_found: true,
      near: nearTexts(query, root),
    };
  }
  const el = m.visible[index];
  return {
    count: n,
    index,
    desc: describeEl(el),
    ref: ref(el),
    bbox: bboxOf(el),
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    text: short(textOf(el)),
    href: (el.closest('a[href]') as HTMLAnchorElement | null)?.href ?? null,
    popup_expected: popupExpected(el),
    in_view: inView(el),
  };
}
export function fieldTriggerEl(label: string, root: Element): Element | null {
  const q = norm(label);
  const labels = deepQsa(root, 'label,legend,[id],div,span,p,dt,th').filter((e) => e.children.length <= 3 && tierOf(norm(nameText(e)), q, false) >= 0 && isVisible(e));
  const best = bestTier(labels, (e) => norm(nameText(e)), q, false);
  const TRIG = '[role=combobox],[aria-haspopup]:not([aria-haspopup=false]),button,[role=button],input:not([type=hidden]),select,textarea';
  for (const lab of best) {
    const tree = treeOf(lab);
    if (isA(lab, 'label')) {
      const c = lab.control;
      if (c && isVisible(c)) return c;
      const f = lab.getAttribute('for');
      const byFor = f ? tree.getElementById(f) : null;
      if (byFor && isVisible(byFor)) return byFor;
    }
    if (lab.id) {
      const lb = Array.from(tree.querySelectorAll(`[aria-labelledby~="${cssEscape(lab.id)}"]`)).find((e) => isVisible(e));
      if (lb) return lb;
    }
    const body = lab.ownerDocument.body;
    for (let p = flatParent(lab), depth = 0; p && depth < 4 && p !== body; p = flatParent(p), depth++) {
      const cands = Array.from(p.querySelectorAll(TRIG)).filter((e) => e !== lab && !lab.contains(e) && isVisible(e));
      if (cands.length) {
        return cands.find((e) => e.matches('[role=combobox],[aria-haspopup]:not([aria-haspopup=false])')) ?? cands[0];
      }
    }
  }
  return null;
}
