/** Page inspection: the visible interactive elements, each with a suggested target verified with `find`. */
import type { FragileFlag, InventoryContext, InventoryElement, InventoryOptions, InventoryPopup, InventoryScroller, KitActionHint, KitInventory, KitSuggestion, ResolveResult } from '../types.js';
import type { ScopeSpec, TargetObject } from '@retake/core/language';
import { RT } from './clock.js';
import { host } from './host.js';
import { withMemo } from './memo.js';
import { POPUP_SEL } from './placement.js';
import { hitInside } from './points.js';
import { deref, ref } from './refs.js';
import { ROW_SEL, cssEscape, find, labelPairs, labelTarget, match, popupExpected, resolveScope, rowFor } from './resolver.js';
import type { Matched } from './resolver.js';
import { FIELD_CONTENT, IMPLICIT, INTERACTIVE, accessibleName, explicitRole, idsText, nameText, roleOf } from './roles.js';
import { isPopoverOpen, lastVisible, topDialog, topPopover } from './scopes.js';
import { SKIP_TAGS, lc, norm, short, textOf } from './text.js';
import { deepContains, deepQsa, hostParent, isA, trees, upOf } from './trees.js';
import { TRIGGER_NAME, fileInputFor, menuTrigger } from './triggers.js';
import { bboxOf, docScroller, inView, isScrollable, isVisible, visibleRect } from './visibility.js';

// ───────────────────────────── inspection ─────────────────────────────
// `inventory` lists the visible interactive elements with one suggested target each. Candidates come from a ladder
// (text, role + name, then the same scoped `in` dialog / menu / listbox / popover / row, testid, aria, css for a stable
// id; fields: label, placeholder, role + name first); counts from in-memory indexes skip the obviously ambiguous ones,
// and every suggestion kept was verified once with `find` itself: it resolves to this element with count 1 (or with
// its `nth`). All of it inside one synchronous call with the per-call memo, under a time budget.
const KNOWN_ROLES = new Set([...Object.keys(IMPLICIT), 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'treeitem', 'gridcell', 'menu', 'tooltip', 'tabpanel']);
const FIELD_SEL =
  'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]),textarea,select,[role=textbox],[role=searchbox],[role=combobox],[contenteditable=""],[contenteditable=true]';
/** Interactive elements that hold their content: an interactive element inside one is part of it. */
const CONTAINER_SEL = 'a[href],button,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab]';
/** Ids a framework generated (React `:r1:`, numbered, hashed): never suggested as css. */
const GENERATED_ID = /[:]|\d{3,}|^[a-f0-9-]{8,}$|(^|[-_])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{6,}($|[-_])/i;
/** Most matches an unscoped `nth` suggestion is looked up among. */
const NTH_MAX = 10_000;
/** Longest text a suggested target carries. */
const SUGGEST_MAX = 60;
/** A text with a letter or a digit (not only symbols). */
const WORDY = /[\p{L}\p{N}]/u;
/** Verifications per element before the `nth` fallback. */
const VERIFY_MAX = 5;
/** Alternatives: extra verifications per element, the default time budget, and the suggestion time (ms) and the
 * count of distinct texts on the page past which a press does not wait for them. */
const ALT_VERIFY_MAX = 6;
const ALT_BUDGET_MS = 10;
const ALT_AFTER_MS = 20;
const ALT_TEXTS_MAX = 2000;

function whereOf(el: Element): 'document' | 'shadow' | 'frame' {
  if (el.ownerDocument !== document) return 'frame';
  return el.getRootNode().nodeType === 11 ? 'shadow' : 'document';
}
/** Up to `max` distinct leaf texts under `root` (its own tree), skipping `skip`'s subtree, in document order. */
function leafTexts(root: Element, max: number, skip?: Element): string[] {
  const out: string[] = [];
  const all = root.querySelectorAll('*');
  for (let i = 0; i < all.length && out.length < max; i++) {
    const c = all[i];
    if (c.children.length > 0 || SKIP_TAGS.has(c.tagName) || skip?.contains(c)) continue;
    const t = norm(c.textContent);
    if (t && t.length <= SUGGEST_MAX && !out.includes(t)) out.push(t);
  }
  return out;
}
/** Up to `max` non-empty text nodes of `el` (its own tree), normalised, in document order. */
function textPieces(el: Element, max: number): string[] {
  const out: string[] = [];
  const walk = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walk.nextNode(); n && out.length < max; n = walk.nextNode()) {
    const p = n.parentElement;
    if (p && SKIP_TAGS.has(p.tagName)) continue;
    // What a field inside the element holds (a textarea in a label) is not one of its pieces.
    if (p && p !== el && p.closest(FIELD_CONTENT) && el.contains(p.closest(FIELD_CONTENT))) continue;
    const t = norm(n.textContent);
    if (t && t.length <= SUGGEST_MAX) out.push(t);
  }
  return out;
}
function hrefPath(el: Element): string | null {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return null;
  try {
    const u = new URL(a.href);
    return u.origin === (el.ownerDocument.defaultView ?? window).location.origin ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}
function stateOf(el: Element): InventoryElement['state'] {
  const aria = (n: string) => el.getAttribute(n) === 'true';
  const inp = isA(el, 'input') ? el : null;
  return {
    disabled: (el as HTMLButtonElement).disabled === true || aria('aria-disabled'),
    expanded: aria('aria-expanded') || (isA(el, 'summary') && (el.parentElement as HTMLDetailsElement | null)?.open === true),
    checked: (inp !== null && (inp.type === 'checkbox' || inp.type === 'radio') && inp.checked) || aria('aria-checked') || aria('aria-pressed'),
    selected: aria('aria-selected') || (isA(el, 'option') && el.selected),
    popup_expected: popupExpected(el),
    covered: false,
  };
}
/** Something else is drawn over the centre of the element's visible part (a dialog, a toast): a click lands there. */
function coveredAt(el: Element): boolean {
  const v = visibleRect(el);
  if (v.r - v.l <= 0 || v.b - v.t <= 0) return false;
  return !hitInside(el, Math.round((v.l + v.r) / 2), Math.round((v.t + v.b) / 2));
}
/** The first row ([role=row], tr, listitem, li) holding the element (not the element itself). */
function rowOf(el: Element): Element | null {
  for (let p = upOf(el), i = 0; p && i < 16 && p !== p.ownerDocument.body; p = upOf(p), i++) if (p.matches(ROW_SEL)) return p;
  return null;
}

/** An index: lower-cased key → elements of the universe carrying it. */
type Index = Map<string, number>;
type Indexes = Record<'text' | 'name' | 'rn' | 'role' | 'label' | 'placeholder' | 'aria' | 'testid' | 'id', Index>;
/** A rung of the ladder: a target, the index that counts its key (null: not counted) and that key. */
type Candidate = { t: TargetObject; m: Index | null; k: string; noisy?: boolean };
/** One inventory call: its options, its clock and budget, its counts and indexes, whether the budget ran out. */
interface Pass {
  opts: InventoryOptions;
  t0: number;
  budget: number;
  counts: KitInventory['counts'];
  idx: Indexes;
  labelOf: Map<Element, string>;
  partial: boolean;
}
/** The popup layers open on the page; `top`: the one in front. */
interface Layers {
  menuEl: Element | null;
  listEl: Element | null;
  dlg: Element | null;
  pop: Element | null;
  top: Element | null;
}
/** What the ladder of an element is built from. */
interface Facts {
  role: string | null;
  known: string | null;
  name: string;
  field: boolean;
  valued: boolean;
  label: string | null;
  ph: string | null;
  testid: string | null;
  ariaLabel: string | null;
  ctx: InventoryContext;
  row: Element | null;
}
/** An element's suggested target, its alternatives and the row key its scope was found with. */
interface Suggestion {
  suggested: KitSuggestion | null;
  alternatives: KitSuggestion[] | undefined;
  alternativesPartial: boolean;
  rowKey: string | null;
}

function isField(e: Element): boolean {
  return e.matches(FIELD_SEL);
}
/** A field, or a value drawn with ARIA (a spin button, a slider): what it shows is a value. */
function holdsValue(e: Element): boolean {
  return isField(e) || e.matches('[role=spinbutton],[role=slider]');
}
/** Text an element shows (never a field's content, nor that of a field inside a label). */
function ownText(e: Element): string {
  return isA(e, 'label') ? norm(nameText(e)) : textOf(e);
}
function shown(e: Element): string {
  return holdsValue(e) ? '' : ownText(e);
}
function nameOf(e: Element): string {
  const n = accessibleName(e);
  // A contenteditable without a label is named by its content: a field value, never reported.
  return holdsValue(e) && !isA(e, 'input') && !isA(e, 'select') && !isA(e, 'textarea') && n === textOf(e) ? '' : n;
}
function fits(s: string | null): s is string {
  return !!s && s.length <= SUGGEST_MAX;
}
function numeric(t: string): boolean {
  return (t.match(/\p{N}/gu)?.length ?? 0) >= (t.match(/\p{L}/gu)?.length ?? 0);
}

export function inventory(opts: InventoryOptions = {}): KitInventory {
  return withMemo(() => inventoryMemo(opts));
}
function inventoryMemo(opts: InventoryOptions): KitInventory {
  const t0 = RT.performance.now();
  const limit = Math.max(1, Math.min(300, Math.floor(opts.limit ?? 80)));
  const budget = Math.max(100, opts.budget_ms ?? 2500);
  const body = document.body ?? document.documentElement;
  const scope = opts.within ? deref(opts.within) : body;
  const tr = trees(body);
  const counts: KitInventory['counts'] = {
    interactive: 0,
    listed: 0,
    in_view: 0,
    suggested: 0,
    ambiguous: 0,
    unsuggested: 0,
    verifications: 0,
    shadow_roots: tr.list.filter((t) => t.nodeType === 11).length,
    same_origin_frames: tr.list.filter((t) => t !== body && t.nodeType === 1).length,
    cross_origin_frames: tr.cross,
  };
  const headings = headingsOf(body, scope);
  const popups = popupsOf();
  const scrollers = scrollersOf(scope ?? body);
  const base = {
    origin: location.origin,
    title: short(norm(document.title), 120),
    headings,
    popups,
    scrollers,
  };
  if (!scope) return { ...base, elements: [], within_found: false, counts, partial: false, ms: Math.round(RT.performance.now() - t0) };

  const universe = universeOf(body);
  const labelOf = labelsOf(body, universe);
  const idx = indexesOf(universe, labelOf);
  const listedAll = universe.filter((e) => scope === body || scope === e || deepContains(scope, e));
  counts.interactive = listedAll.length;

  const layers = layersOf();
  // Order: the top popup layer first, then what is in view, then the rest (document order within each group).
  const views = new Map<Element, boolean>();
  for (const e of listedAll) views.set(e, inView(e));
  const group = (e: Element) => (layers.top && deepContains(layers.top, e) ? 0 : views.get(e) ? 1 : 2);
  const ordered = listedAll
    .map((e, i) => ({ e, i, g: group(e) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.e);
  counts.in_view = listedAll.filter((e) => views.get(e)).length;
  const listed = ordered.slice(0, limit);
  counts.listed = listed.length;

  const pass: Pass = { opts, t0, budget, counts, idx, labelOf, partial: false };
  const elements: InventoryElement[] = [];
  for (const el of listed) elements.push(entryOf(pass, el, layers, views));
  return { ...base, elements, within_found: true, counts, partial: pass.partial, ms: Math.round(RT.performance.now() - t0) };
}

/** The visible headings of levels 1 to 3 inside the scope (20 at most). */
function headingsOf(body: HTMLElement, scope: Element | null): KitInventory['headings'] {
  const headings: KitInventory['headings'] = [];
  for (const h of deepQsa(body, 'h1,h2,h3,[role=heading]')) {
    if (headings.length >= 20) break;
    if (!isVisible(h) || (scope && !deepContains(scope, h))) continue;
    const lvl = /^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level')) || 2;
    if (lvl > 3) continue;
    const text = short(accessibleName(h), 120);
    if (text) headings.push({ level: lvl, text });
  }
  return headings;
}
/** The open popups of the page (dialogs, menus, listboxes, popovers). */
function popupsOf(): InventoryPopup[] {
  const popups: InventoryPopup[] = [];
  for (const el of deepQsa(document, POPUP_SEL)) {
    if (el === host || (el.hasAttribute('popover') && !isPopoverOpen(el)) || !isVisible(el)) continue;
    const role = explicitRole(el);
    const kind: InventoryPopup['kind'] =
      role === 'dialog' || role === 'alertdialog' || role === 'menu' || role === 'listbox' ? role : el.tagName === 'DIALOG' ? 'dialog' : el.hasAttribute('popover') ? 'popover' : 'other';
    popups.push({ kind, bbox: bboxOf(el), name: short(norm(el.getAttribute('aria-label')) || (el.getAttribute('aria-labelledby') ? idsText(el.getAttribute('aria-labelledby') ?? '', el) : ''), 80) });
  }
  return popups;
}
/** The document when it scrolls, then the visible scrolling containers under `root` (10 in all at most). */
function scrollersOf(root: Element): InventoryScroller[] {
  const scrollers: InventoryScroller[] = [];
  const se = docScroller();
  if (se.scrollHeight > se.clientHeight + 1) {
    scrollers.push({
      document: true,
      bbox: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight },
      scroll_top: Math.round(se.scrollTop),
      scroll_height: se.scrollHeight,
      client_height: se.clientHeight,
    });
  }
  for (const c of deepQsa(root, '*')) {
    if (scrollers.length >= 10) break;
    if (c === host || c.scrollHeight <= c.clientHeight + 1 || c.clientHeight < 60 || c.clientWidth < 100) continue;
    if (!isScrollable(c) || !isVisible(c)) continue;
    scrollers.push({ document: false, bbox: bboxOf(c), scroll_top: Math.round(c.scrollTop), scroll_height: c.scrollHeight, client_height: c.clientHeight });
  }
  return scrollers;
}
/**
 * The universe: every visible interactive element of the page (indexes count over it), labels merged into a
 * visible control, an interactive element inside a button / link / option dropped (part of it).
 */
function universeOf(body: HTMLElement): Element[] {
  const raw = deepQsa(body, INTERACTIVE, true).filter((e) => e !== host && isVisible(e));
  const rawSet = new Set(raw);
  return raw.filter((e) => {
    if (isA(e, 'label')) {
      const c = labelTarget(e);
      if (c && rawSet.has(c)) return false;
    }
    for (let p = hostParent(e), i = 0; p && i < 6; p = hostParent(p), i++) if (rawSet.has(p) && p.matches(CONTAINER_SEL)) return false;
    return true;
  });
}
/** The label text of each control (a label of the universe labels itself). */
function labelsOf(body: HTMLElement, universe: Element[]): Map<Element, string> {
  const labelOf = new Map<Element, string>();
  for (const p of labelPairs(body)) if (p.text && !labelOf.has(p.control)) labelOf.set(p.control, p.text);
  for (const e of universe) {
    if (isA(e, 'label') && !labelOf.has(e)) {
      const t = norm(nameText(e));
      if (t) labelOf.set(e, t);
    }
  }
  return labelOf;
}
/** The indexes of the universe: lower-cased key → how many of its elements carry it. */
function indexesOf(universe: Element[], labelOf: Map<Element, string>): Indexes {
  const idx: Indexes = {
    text: new Map(),
    name: new Map(),
    rn: new Map(),
    role: new Map(),
    label: new Map(),
    placeholder: new Map(),
    aria: new Map(),
    testid: new Map(),
    id: new Map(),
  };
  const bump = (m: Index, k: string | null | undefined) => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const e of universe) {
    const n = lc(nameOf(e));
    bump(idx.text, lc(shown(e)));
    bump(idx.name, n);
    bump(idx.rn, `${roleOf(e) ?? ''}\n${n}`);
    bump(idx.role, roleOf(e));
    bump(idx.label, lc(labelOf.get(e) ?? ''));
    bump(idx.placeholder, lc(norm(e.getAttribute('placeholder'))));
    bump(idx.aria, lc(norm(e.getAttribute('aria-label'))));
    bump(idx.testid, e.getAttribute('data-testid'));
    bump(idx.id, e.id);
  }
  return idx;
}
/** Another key of the index contains this one (a broader text tier would match if this one went away). */
function broader(m: Index, q: string): boolean {
  const ql = lc(q);
  for (const k of m.keys()) if (k !== ql && k.includes(ql)) return true;
  return false;
}
function layersOf(): Layers {
  const menuEl = lastVisible(deepQsa(document, '[role=menu]'));
  const listEl = lastVisible(deepQsa(document, '[role=listbox]'));
  const dlg = topDialog(false);
  const pop = topPopover();
  return { menuEl, listEl, dlg, pop, top: pop ?? dlg };
}
function contextOf(layers: Layers, e: Element): { ctx: InventoryContext; row: Element | null } {
  const { menuEl, listEl, dlg, pop } = layers;
  if (menuEl && deepContains(menuEl, e)) return { ctx: 'menu', row: null };
  if (listEl && deepContains(listEl, e)) return { ctx: 'listbox', row: null };
  if (dlg && deepContains(dlg, e)) return { ctx: 'dialog', row: null };
  if (pop && deepContains(pop, e)) return { ctx: 'popover', row: null };
  const row = e.matches(ROW_SEL) ? null : rowOf(e);
  return row ? { ctx: 'row', row } : { ctx: 'page', row: null };
}
/** How many elements `find` resolves the target to, when one of them (the only one, unless positional) is `el`; else -1. */
function verify(pass: Pass, t: TargetObject, el: Element): number {
  pass.counts.verifications++;
  let r: ResolveResult;
  try {
    r = find(t, {});
  } catch {
    return -1;
  }
  if (r.count === 0 || !('ref' in r) || deref(r.ref) !== el) return -1;
  if (t.nth === undefined && !t.last_visible && r.count !== 1) return -1;
  return r.count;
}
// The budget is checked before each lookup too: on a page of many identical elements one lookup is long.
function spent(pass: Pass): boolean {
  if (RT.performance.now() - pass.t0 > pass.budget) pass.partial = true;
  return pass.partial;
}
function rowKeyOf(row: Element, el: Element): string | null {
  for (const k of leafTexts(row, 6, el)) if (k.length >= 2 && rowFor(k) === row) return k;
  return null;
}

/** One element of the inventory: its facts, its suggested target (within the budget), its action. */
function entryOf(pass: Pass, el: Element, layers: Layers, views: Map<Element, boolean>): InventoryElement {
  const f = factsOf(pass, el, layers);
  let s: Suggestion = { suggested: null, alternatives: undefined, alternativesPartial: false, rowKey: null };
  if (RT.performance.now() - pass.t0 > pass.budget) pass.partial = true;
  else s = suggestionOf(pass, el, f);
  const { suggested, alternatives, alternativesPartial } = s;
  const action = actionOf(pass, el, f, suggested, s.rowKey);
  if (suggested) pass.counts.suggested++;
  else pass.counts.unsuggested++;
  const { role, name, label, ph, testid, ctx } = f;
  return {
    ref: ref(el),
    bbox: bboxOf(el),
    in_view: views.get(el) === true,
    in: ctx,
    where: whereOf(el),
    state: { ...stateOf(el), covered: views.get(el) === true && coveredAt(el) },
    role,
    tag: el.tagName.toLowerCase(),
    input_type: isA(el, 'input') ? el.type : null,
    name: short(name, 120),
    text: short(shown(el), 120),
    label: label ? short(label, 120) : null,
    placeholder: ph ? short(ph, 120) : null,
    testid: testid ? short(testid, 120) : null,
    href_path: hrefPath(el),
    suggested,
    action,
    ...(alternatives !== undefined ? { alternatives, alternatives_partial: alternativesPartial } : {}),
  };
}
function factsOf(pass: Pass, el: Element, layers: Layers): Facts {
  const role = roleOf(el);
  const known = role !== null && KNOWN_ROLES.has(role) ? role : null;
  const name = nameOf(el);
  const field = isField(el);
  const valued = holdsValue(el);
  const label = pass.labelOf.get(el) ?? null;
  const ph = norm(el.getAttribute('placeholder')) || null;
  const testid = el.getAttribute('data-testid');
  const ariaLabel = norm(el.getAttribute('aria-label')) || null;
  const { ctx, row } = contextOf(layers, el);
  return { role, known, name, field, valued, label, ph, testid, ariaLabel, ctx, row };
}
/** The element's ladder of candidates, the first that resolves to it alone (else a positional one), its alternatives. */
function suggestionOf(pass: Pass, el: Element, f: Facts): Suggestion {
  const { idx } = pass;
  const { role, known, name, testid, ariaLabel, ctx, row } = f;
  const plain = plainOf(idx, el, f);
  // A name of symbols only ("↻"): after testid, aria and a stable id.
  const symbolic = known && fits(name) && !WORDY.test(name) ? [{ t: { role: known, name } as TargetObject, m: idx.rn, k: `${role}\n${lc(name)}` }] : [];
  let rowKey: string | null = null;
  let scopeSpec: ScopeSpec | null = null;
  if (ctx === 'row' && row) {
    rowKey = rowKeyOf(row, el);
    if (rowKey) scopeSpec = { row: rowKey };
  } else if (ctx !== 'page' && ctx !== 'row') scopeSpec = ctx;
  const ladder: Candidate[] = [
    ...plain,
    ...(scopeSpec ? plain.map((c) => ({ t: { ...c.t, in: scopeSpec } as TargetObject, m: null, k: '', noisy: c.noisy })) : []),
    ...(testid ? [{ t: { testid }, m: idx.testid, k: testid }] : []),
    ...(fits(ariaLabel) ? [{ t: { aria: ariaLabel }, m: idx.aria, k: lc(ariaLabel) }] : []),
    ...(el.id && !GENERATED_ID.test(el.id) ? [{ t: { css: `#${cssEscape(el.id)}` }, m: idx.id, k: el.id }] : []),
    ...symbolic,
    ...(scopeSpec ? symbolic.map((c) => ({ t: { ...c.t, in: scopeSpec } as TargetObject, m: null, k: '' })) : []),
  ];
  const unique = uniqueOf(pass, el, ladder);
  let suggested = unique.suggested;
  if (!suggested && !spent(pass)) suggested = positionalOf(pass, el, plain, scopeSpec, known);
  if (suggested) flag(idx, suggested.target, suggested.fragile);
  return { suggested, ...alternativesOf(pass, el, ladder, suggested, unique.at), rowKey };
}
/** The unscoped candidates of an element: a field's label, placeholder, role + name; else its texts, role + name. */
function plainOf(idx: Indexes, el: Element, f: Facts): Candidate[] {
  const { role, known, name, valued, label, ph } = f;
  // `noisy`: a text an alternative never offers — mostly digits (a price, a count, a date) or pieces run
  // together without a space ("5 kg€36.40 / kg"). The suggestion ignores the flag.
  const plain: Candidate[] = [];
  if (valued) {
    if (fits(label)) plain.push({ t: { label }, m: idx.label, k: lc(label) });
    if (fits(ph)) plain.push({ t: { placeholder: ph }, m: idx.placeholder, k: lc(ph) });
    if (known && fits(name)) plain.push({ t: { role: known, name }, m: idx.rn, k: `${role}\n${lc(name)}` });
  } else {
    const full = ownText(el);
    // A text of symbols only (an icon glyph "⋯", "×") reads poorly in a scenario: role + name first then.
    // A text made of several pieces (initials + name + city on an account button, a label + a count badge) reads
    // better — and lasts longer — as one of its pieces with letters.
    const pieces = full ? textPieces(el, 4) : [];
    const leaves = pieces.length >= 2 ? pieces.filter((l) => l.length >= 3 && /\p{L}/u.test(l)) : [];
    const runTogether = (t: string) => t.length > 16 && pieces.some((p, i) => i > 0 && t.includes(pieces[i - 1] + p));
    const noisyText = (t: string) => numeric(t) || runTogether(t);
    if (fits(full) && leaves.length === 0 && WORDY.test(full)) plain.push({ t: { text: full }, m: idx.text, k: lc(full), noisy: noisyText(full) });
    for (const leaf of leaves.slice(0, 2)) plain.push({ t: { text: leaf }, m: null, k: '', noisy: numeric(leaf) });
    if (fits(full) && leaves.length > 0 && WORDY.test(full)) plain.push({ t: { text: full }, m: idx.text, k: lc(full), noisy: noisyText(full) });
    if (known && fits(name) && WORDY.test(name)) plain.push({ t: { role: known, name }, m: idx.rn, k: `${role}\n${lc(name)}`, noisy: noisyText(name) });
  }
  return plain;
}
/** The first candidate of the ladder that resolves to the element alone, and its rung (-1: none). */
function uniqueOf(pass: Pass, el: Element, ladder: Candidate[]): { suggested: KitSuggestion | null; at: number } {
  let tries = 0;
  for (const [k, c] of ladder.entries()) {
    // The index knows another element with the same key: `find` would see at least as many.
    if (c.m && (c.m.get(c.k) ?? 0) > 1) continue;
    if (tries++ >= VERIFY_MAX || spent(pass)) break;
    if (verify(pass, c.t, el) === 1) return { suggested: { target: c.t, matches: 1, fragile: [] }, at: k };
  }
  return { suggested: null, at: -1 };
}
/**
 * No unique target: the most specific candidate with the element's position among its matches.
 * An unscoped candidate shared by more than NTH_MAX elements is not offered with an `nth` (a poor target, and
 * one lookup over them all can outlast the whole budget).
 */
function positionalOf(pass: Pass, el: Element, plain: Candidate[], scopeSpec: ScopeSpec | null, known: string | null): KitSuggestion | null {
  const { idx } = pass;
  const fewEnough = (c: { m: Index | null; k: string }) => !c.m || (c.m.get(c.k) ?? 0) <= NTH_MAX;
  const bases: TargetObject[] = [
    ...(scopeSpec ? plain.map((c) => ({ ...c.t, in: scopeSpec }) as TargetObject) : []),
    ...plain.filter(fewEnough).map((c) => c.t),
    ...(known && (scopeSpec || (idx.role.get(known) ?? 0) <= NTH_MAX) ? [scopeSpec ? ({ role: known, in: scopeSpec } as TargetObject) : { role: known }] : []),
  ];
  for (const b of bases.slice(0, 3)) {
    if (spent(pass)) break;
    const root = resolveScope(b.in);
    if (!root) continue;
    let m: Matched;
    try {
      m = match(b, root, {});
    } catch {
      continue;
    }
    const i = m.visible.indexOf(el);
    if (i < 0 || spent(pass)) continue;
    const t = { ...b, nth: i };
    const n = verify(pass, t, el);
    if (n > 0) {
      pass.counts.ambiguous++;
      return { target: t, matches: n, fragile: ['nth'] };
    }
  }
  return null;
}
/** The fragile flags of a target (added to `fragile`, which is returned). */
function flag(idx: Indexes, t: TargetObject, fragile: FragileFlag[]): FragileFlag[] {
  const q = t.text ?? t.name ?? t.label ?? t.placeholder ?? t.aria;
  const kindIdx =
    t.text !== undefined ? idx.text : t.name !== undefined ? idx.name : t.label !== undefined ? idx.label : t.placeholder !== undefined ? idx.placeholder : t.aria !== undefined ? idx.aria : null;
  if (t.css !== undefined) fragile.push('css');
  const rk = t.in && typeof t.in === 'object' && 'row' in t.in ? (t.in as { row: string }).row : '';
  if ((q && /\d/.test(q)) || /\d/.test(rk)) fragile.push('dynamic_text');
  if (q && kindIdx && broader(kindIdx, q)) fragile.push('broader');
  return fragile;
}
/**
 * Alternatives (the recorder): the rest of the ladder past the suggestion, inside a press — so a small
 * budget of their own, none on a large page or after a slow suggestion. Never positional, never a key the
 * indexes know is shared, each verified to resolve once to this very element.
 */
function alternativesOf(pass: Pass, el: Element, ladder: Candidate[], suggested: KitSuggestion | null, at: number): { alternatives: KitSuggestion[] | undefined; alternativesPartial: boolean } {
  const { opts, t0, idx } = pass;
  const want = Math.max(0, Math.min(3, Math.floor(opts.alternatives ?? 0)));
  if (!(want > 0 && suggested && at >= 0)) return { alternatives: undefined, alternativesPartial: false };
  const alternatives: KitSuggestion[] = [];
  let alternativesPartial = false;
  const tA = RT.performance.now();
  const cap = Math.min(opts.alternatives_budget_ms ?? ALT_BUDGET_MS, (opts.budget_ms ?? 2500) - (tA - t0));
  if (tA - t0 > ALT_AFTER_MS || idx.text.size > ALT_TEXTS_MAX || cap <= 0) alternativesPartial = true;
  else {
    const seen = new Set([JSON.stringify(suggested.target)]);
    let extra = 0;
    for (let k = at + 1; k < ladder.length && alternatives.length < want; k++) {
      const c = ladder[k];
      if (c.noisy || c.t.nth !== undefined || c.t.last_visible || (c.m && (c.m.get(c.k) ?? 0) > 1)) continue;
      const key = JSON.stringify(c.t);
      if (seen.has(key)) continue;
      if (extra >= ALT_VERIFY_MAX || RT.performance.now() - tA > cap) {
        alternativesPartial = true;
        break;
      }
      extra++;
      seen.add(key);
      if (verify(pass, c.t, el) === 1) alternatives.push({ target: c.t, matches: 1, fragile: flag(idx, c.t, []) });
    }
  }
  return { alternatives, alternativesPartial };
}
/** The action: through the helper the runner's action uses, else the target's own verification. */
function actionOf(pass: Pass, el: Element, f: Facts, suggested: KitSuggestion | null, rowKey: string | null): KitActionHint {
  const { role, field, label, ariaLabel, row } = f;
  let action: KitActionHint = { kind: field ? 'type' : 'click', verified: suggested !== null };
  const fileInput = isA(el, 'input') && el.type === 'file' ? el : (el.querySelector('input[type=file]') ?? (isA(el, 'label') ? labelTarget(el) : null));
  if (fileInput && isA(fileInput, 'input') && fileInput.type === 'file') {
    action = { kind: 'drop_file', verified: suggested !== null && fileInputFor(ref(el)) !== null };
  } else if (isA(el, 'select') || role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
    action = fits(label) && !pass.partial && verify(pass, { label }, el) === 1 ? { kind: 'select', field: label, verified: true } : { kind: 'select', verified: suggested !== null };
  } else if (row && !field && (/^(menu|true)$/.test(el.getAttribute('aria-haspopup') ?? '') || TRIGGER_NAME.test(`${ariaLabel ?? ''} ${el.getAttribute('title') ?? ''} ${textOf(el)}`))) {
    const key = rowKey ?? (RT.performance.now() - pass.t0 > pass.budget ? null : rowKeyOf(row, el));
    const trig = key ? menuTrigger(ref(row)) : null;
    if (key && trig?.ref && deref(trig.ref) === el) action = { kind: 'menu', row: key, verified: true };
  }
  return action;
}
