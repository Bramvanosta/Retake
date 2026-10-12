/**
 * The in-page kit, installed as `window.__demoStudio` in every page and frame.
 *
 * `demoKit` MUST stay self-contained: it is serialised with `Function.prototype.toString()` and evaluated
 * in the page (see source.ts), so it may not reference anything outside its own body at runtime
 * (type-only imports are fine, they are erased).
 */
import type { BBox, PointSpec, ScopeSpec, TargetObject } from '@demo-studio/core';
import type {
  CursorKind,
  CursorState,
  DropOutcome,
  FileSpec,
  FindOptions,
  KitApi,
  KitConfig,
  OutsidePlan,
  PointInfo,
  PopupEntry,
  ResolveResult,
  ScrollInfo,
  ScrollOp,
} from './types.js';

export function demoKit(config: KitConfig): void {
  const VERSION = '1.0.0';
  // ── Web notifications (R-NTF-03): report every `new Notification(…)` and ServiceWorkerRegistration#showNotification
  // to the runner (binding `__demoStudioNotification`, else queued in `__demoStudioNotifications`), then let the page's
  // call proceed unchanged. Patched once per window (a re-installed kit keeps the first patch).
  (() => {
    type Reported = { via: string; title: string; body: string; tag?: string; icon?: string; time: number; url: string; origin: string };
    const g = window as unknown as Record<string, unknown> & { __demoStudioNotifications?: Reported[] };
    if (g.__demoStudioNotifyPatched) return;
    g.__demoStudioNotifyPatched = true;
    const report = (via: string, title: unknown, options: unknown) => {
      try {
        const o = (options && typeof options === 'object' ? options : {}) as { body?: unknown; tag?: unknown; icon?: unknown };
        let icon: string | undefined;
        if (o.icon !== undefined && o.icon !== null && String(o.icon) !== '') {
          try {
            icon = new URL(String(o.icon), location.href).href;
          } catch {
            icon = String(o.icon);
          }
        }
        const payload: Reported = {
          via,
          title: String(title ?? ''),
          body: o.body === undefined || o.body === null ? '' : String(o.body),
          time: Date.now(),
          url: location.href,
          origin: location.origin,
        };
        if (o.tag !== undefined && o.tag !== null && String(o.tag) !== '') payload.tag = String(o.tag);
        if (icon) payload.icon = icon;
        const binding = g.__demoStudioNotification;
        if (typeof binding === 'function') (binding as (p: Reported) => unknown)(payload);
        else (g.__demoStudioNotifications ??= []).push(payload);
      } catch {
        /* never break the page */
      }
    };
    const Orig = g.Notification as (new (title: string, options?: unknown) => Notification) & { permission?: string; requestPermission?: (...a: unknown[]) => unknown; maxActions?: number } | undefined;
    if (typeof Orig === 'function') {
      const Patched = function (this: unknown, title: string, options?: unknown) {
        if (!new.target) throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator.");
        report('Notification', title, options);
        return Reflect.construct(Orig, [title, options], new.target) as Notification;
      } as unknown as Record<string, unknown>;
      Patched.prototype = Orig.prototype;
      Object.defineProperty(Patched, 'permission', { get: () => Orig.permission, configurable: true });
      if ('maxActions' in Orig) Object.defineProperty(Patched, 'maxActions', { get: () => Orig.maxActions, configurable: true });
      if (typeof Orig.requestPermission === 'function') Patched.requestPermission = (...a: unknown[]) => Orig.requestPermission!.apply(Orig, a);
      Object.defineProperty(Patched, 'name', { value: 'Notification' });
      g.Notification = Patched;
    }
    const SWR = g.ServiceWorkerRegistration as { prototype: { showNotification?: (this: unknown, title: string, options?: unknown) => Promise<void> } } | undefined;
    const show = SWR?.prototype.showNotification;
    if (SWR && typeof show === 'function') {
      SWR.prototype.showNotification = function (this: unknown, title: string, options?: unknown) {
        report('ServiceWorkerRegistration.showNotification', title, options);
        return show.call(this, title, options);
      };
    }
  })();
  const w = window as unknown as Window & { __demoStudio?: KitApi };
  const prev = w.__demoStudio;
  let carried: CursorState | null = null;
  if (prev && typeof prev.healthy === 'function') {
    if (prev.version === VERSION && prev.healthy()) return;
    // document.open() erases window listeners and drops the overlay: replace the old instance.
    try {
      carried = prev.cursor.state();
      prev.dispose();
    } catch {
      /* old instance unusable */
    }
  }
  let disposed = false;
  const cleanups: Array<() => void> = [];
  function on(target: EventTarget, type: string, fn: (e: Event) => void, opts: AddEventListenerOptions = { capture: true, passive: true }): void {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }
  let pinged = false;
  on(window, '__demo_studio_ping', () => {
    pinged = true;
  });

  const isTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  // ───────────────────────────── element refs ─────────────────────────────
  const refs = new Map<string, WeakRef<Element>>();
  const refOf = new WeakMap<Element, string>();
  let refSeq = 0;
  function ref(el: Element): string {
    const existing = refOf.get(el);
    if (existing && refs.get(existing)?.deref() === el) return existing;
    if (refs.size > 4000) {
      for (const [k, v] of refs) if (!v.deref()?.isConnected) refs.delete(k);
    }
    const id = `r${++refSeq}`;
    refs.set(id, new WeakRef(el));
    refOf.set(el, id);
    return id;
  }
  function deref(id: string | null | undefined): Element | null {
    if (!id) return null;
    const el = refs.get(id)?.deref() ?? null;
    return el && el.isConnected ? el : null;
  }

  // ───────────────────────────── text helpers ─────────────────────────────
  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  const lc = (s: string): string => s.toLowerCase();
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'DEMO-STUDIO-CURSOR']);
  const BUTTON_INPUT = 'input[type=button],input[type=submit],input[type=reset]';

  function textOf(el: Element): string {
    if (el instanceof HTMLInputElement) {
      return el.matches(BUTTON_INPUT) ? norm(el.value) : '';
    }
    return norm(el.textContent);
  }
  function short(s: string, n = 120): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  type Tier = 0 | 1 | 2; // exact, case-insensitive exact, substring
  function tierOf(text: string, q: string, exactOnly: boolean): Tier | -1 {
    if (text === q) return 0;
    const tl = lc(text);
    const ql = lc(q);
    if (tl === ql) return 1;
    if (!exactOnly && ql.length > 0 && tl.includes(ql)) return 2;
    return -1;
  }
  /** Keep the best non-empty tier (exact first, then case-insensitive, then substring). */
  function bestTier<T>(items: T[], text: (t: T) => string, q: string, exactOnly: boolean): T[] {
    const tiers: T[][] = [[], [], []];
    const qn = norm(q);
    for (const it of items) {
      const t = tierOf(text(it), qn, exactOnly);
      if (t >= 0) tiers[t].push(it);
    }
    return tiers.find((t) => t.length > 0) ?? [];
  }

  // ───────────────────────────── visibility ─────────────────────────────
  function isScrollable(el: Element): boolean {
    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    const ox = cs.overflowX;
    const sy = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    const sx = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
    return sy || sx;
  }
  function clipsContent(el: Element): boolean {
    const cs = getComputedStyle(el);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  }
  function docScroller(): Element {
    return document.scrollingElement ?? document.documentElement;
  }

  function isVisible(el: Element): boolean {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.width <= 1 && r.height <= 1) return false;
    const anyEl = el as Element & {
      checkVisibility?: (o: Record<string, boolean>) => boolean;
    };
    if (typeof anyEl.checkVisibility === 'function') {
      if (!anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
        return false;
      }
    } else {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
    }
    // Outside the scrollable area of the document (e.g. left:-9999px).
    const sx = window.scrollX;
    const sy = window.scrollY;
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
    // Clipped away by a non-scrolling overflow ancestor (carousels, collapsed panels).
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!clipsContent(p)) continue;
      const cs = getComputedStyle(p);
      const scrolls = /(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY);
      if (scrolls) continue;
      const pr = p.getBoundingClientRect();
      if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return false;
    }
    return true;
  }

  /** Product of the computed opacities of an element and its ancestors (animations included). */
  function effectiveOpacity(el: Element): number {
    let o = 1;
    for (let p: Element | null = el; p && o > 0; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity) || 0;
    return o;
  }

  /**
   * Whether `text` is visible to a viewer: the innermost elements containing it must be visible and at least half
   * opaque. `innerText` alone also counts text that is laid out but still transparent (staggered reveals, fade-ins).
   */
  function textVisible(text: string): boolean {
    const needle = lc(norm(text));
    const body = document.body as HTMLElement | null;
    if (!needle) return true;
    if (!body || !lc(norm(body.innerText ?? '')).includes(needle)) return false;
    const has = (el: Element) => lc(norm(el.textContent ?? '')).includes(needle);
    const hits: Element[] = [];
    const visit = (el: Element) => {
      let deeper = false;
      for (const child of Array.from(el.children)) {
        if (has(child)) {
          deeper = true;
          visit(child);
        }
      }
      if (!deeper) hits.push(el);
    };
    visit(body);
    return hits.some(
      (el) => isVisible(el) && effectiveOpacity(el) >= 0.5 && lc(norm((el as HTMLElement).innerText ?? el.textContent ?? '')).includes(needle),
    );
  }

  function bboxOf(el: Element): BBox {
    const r = el.getBoundingClientRect();
    const rd = (n: number) => Math.round(n * 100) / 100;
    return { x: rd(r.left), y: rd(r.top), w: rd(r.width), h: rd(r.height) };
  }

  /** Visible part of an element: rect ∩ viewport ∩ every clipping/scrolling ancestor. */
  function visibleRect(el: Element): { l: number; t: number; r: number; b: number } {
    const rc = el.getBoundingClientRect();
    let l = Math.max(rc.left, 0);
    let t = Math.max(rc.top, 0);
    let r = Math.min(rc.right, window.innerWidth);
    let b = Math.min(rc.bottom, window.innerHeight);
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!clipsContent(p)) continue;
      const pr = p.getBoundingClientRect();
      l = Math.max(l, pr.left + p.clientLeft);
      t = Math.max(t, pr.top + p.clientTop);
      r = Math.min(r, pr.left + p.clientLeft + p.clientWidth);
      b = Math.min(b, pr.top + p.clientTop + p.clientHeight);
    }
    return { l, t, r, b };
  }
  function inView(el: Element): boolean {
    const rc = el.getBoundingClientRect();
    const v = visibleRect(el);
    const vw = v.r - v.l;
    const vh = v.b - v.t;
    if (vw <= 0 || vh <= 0) return false;
    return vw >= Math.min(rc.width, window.innerWidth * 0.8) - 1 && vh >= Math.min(rc.height, window.innerHeight * 0.8) - 1;
  }

  // ───────────────────────────── roles & names ─────────────────────────────
  const IMPLICIT: Record<string, string> = {
    button: 'button,input[type=button],input[type=submit],input[type=reset],input[type=image],summary',
    link: 'a[href],area[href]',
    textbox:
      'input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=password],input[type=search],textarea,[contenteditable=""],[contenteditable=true]',
    searchbox: 'input[type=search]',
    combobox: 'select:not([multiple]):not([size]),input[list]',
    listbox: 'select[multiple],select[size],datalist',
    checkbox: 'input[type=checkbox]',
    radio: 'input[type=radio]',
    option: 'option',
    heading: 'h1,h2,h3,h4,h5,h6',
    dialog: 'dialog',
    row: 'tr',
    cell: 'td',
    columnheader: 'th',
    table: 'table',
    list: 'ul,ol',
    listitem: 'li',
    img: 'img[alt]:not([alt=""])',
    navigation: 'nav',
    main: 'main',
    form: 'form',
    slider: 'input[type=range]',
    spinbutton: 'input[type=number]',
    progressbar: 'progress',
    article: 'article',
    banner: 'header',
    contentinfo: 'footer',
    complementary: 'aside',
    group: 'fieldset,details',
  };
  const ROLE_ALIASES: Record<string, string[]> = {
    menuitem: ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
    textbox: ['textbox', 'searchbox'],
  };
  function explicitRole(el: Element): string | null {
    const r = el.getAttribute('role');
    if (!r) return null;
    const first = r.trim().split(/\s+/)[0];
    return first ? first.toLowerCase() : null;
  }
  function roleOf(el: Element): string | null {
    const ex = explicitRole(el);
    if (ex) return ex;
    for (const [role, sel] of Object.entries(IMPLICIT)) {
      if (role === 'searchbox') continue; // reported as textbox-compatible below
      if (el.matches(sel)) return el.matches(IMPLICIT.searchbox) ? 'searchbox' : role;
    }
    return null;
  }
  function hasRole(el: Element, role: string): boolean {
    const wanted = ROLE_ALIASES[role] ?? [role];
    const r = roleOf(el);
    return r !== null && wanted.includes(r);
  }
  function byRole(root: Element, role: string): Element[] {
    const wanted = ROLE_ALIASES[role] ?? [role];
    const sels: string[] = [];
    for (const r of wanted) {
      sels.push(`[role="${r}"]`, `[role^="${r} "]`);
      if (IMPLICIT[r]) sels.push(IMPLICIT[r]);
    }
    const out: Element[] = [];
    const all = [root, ...Array.from(root.querySelectorAll(sels.join(',')))];
    for (const el of all) if (el.matches(sels.join(',')) && hasRole(el, role)) out.push(el);
    return out;
  }
  function idsText(ids: string): string {
    return norm(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  }
  function accessibleName(el: Element): string {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = idsText(lb);
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && norm(al)) return norm(al);
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const labels = el.labels ? Array.from(el.labels).map((l) => norm(l.textContent)).filter(Boolean) : [];
      if (labels.length) return labels.join(' ');
      if (el instanceof HTMLInputElement && el.matches(BUTTON_INPUT)) return norm(el.value);
      const t = el.getAttribute('title') ?? el.getAttribute('placeholder');
      return norm(t);
    }
    if (el instanceof HTMLImageElement) return norm(el.alt);
    const t = textOf(el);
    if (t) return t;
    return norm(el.getAttribute('title'));
  }

  const INTERACTIVE =
    'button,a[href],input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
  function promote(el: Element, root: Element): Element {
    let cur: Element | null = el;
    for (let i = 0; cur && i <= 6; i++) {
      if (cur.matches(INTERACTIVE)) return cur;
      if (cur === root) break;
      cur = cur.parentElement;
    }
    return el;
  }
  function isInteractive(el: Element): boolean {
    return el.closest(INTERACTIVE) !== null;
  }

  // ───────────────────────────── scopes ─────────────────────────────
  const DIALOG_SEL = '[role=dialog],[role=alertdialog],dialog[open]';
  const FLOATING_SEL =
    '[data-radix-popper-content-wrapper],[role=menu],[role=listbox],[popover],[role=dialog][data-side],[data-side][data-open],[data-floating-ui-portal] > *';
  function isFloating(el: Element): boolean {
    if (el.closest('[data-radix-popper-content-wrapper]')) return true;
    if (el.hasAttribute('data-side')) return true;
    if (el.hasAttribute('popover') && el !== host) return true;
    return false;
  }
  function isPopoverOpen(el: Element): boolean {
    try {
      return el.matches(':popover-open');
    } catch {
      return false;
    }
  }
  function lastVisible(els: Iterable<Element>, ok: (e: Element) => boolean = () => true): Element | null {
    let last: Element | null = null;
    for (const e of els) if (e !== host && ok(e) && isVisible(e)) last = e;
    return last;
  }
  function topDialog(preferAlert: boolean): Element | null {
    const all = Array.from(document.querySelectorAll(DIALOG_SEL)).filter((e) => isVisible(e));
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
  function topPopover(): Element | null {
    const cands = Array.from(document.querySelectorAll(FLOATING_SEL)).filter(
      (e) => e !== host && !e.matches('[role=menubar]') && (!e.hasAttribute('popover') || isPopoverOpen(e)),
    );
    let last = lastVisible(cands);
    if (!last) return null;
    // Climb to the outermost floating layer of that group (popper wrapper around a listbox…).
    for (let p = last.parentElement; p && p !== document.body; p = p.parentElement) {
      if (cands.includes(p)) last = p;
    }
    return last;
  }
  const ROW_SEL = '[role=row],tr,[role=listitem],li';
  function rowFor(text: string): Element | null {
    const q = norm(text);
    const ql = lc(q);
    const rows = Array.from(document.querySelectorAll(ROW_SEL)).filter(
      (r) => lc(textOf(r)).includes(ql) && isVisible(r),
    );
    // Innermost rows only (a row containing a matching nested row is dropped).
    const inner = rows.filter((r) => !rows.some((o) => o !== r && r.contains(o)));
    if (inner.length) {
      const exactCell = inner.find((r) =>
        Array.from(r.querySelectorAll('*')).some((c) => c.children.length === 0 && lc(norm(c.textContent)) === ql),
      );
      return exactCell ?? inner[0];
    }
    // Card layouts: climb from the text to the first ancestor that holds a button.
    const hits = textSearch(document.body, q, false).filter((h) => isVisible(h.el));
    for (const h of hits) {
      for (let p: Element | null = h.el; p && p !== document.body; p = p.parentElement) {
        if (p.querySelector('button,[role=button],[aria-haspopup]') && p !== h.el) return p;
      }
    }
    return null;
  }
  function resolveScope(s: ScopeSpec | undefined): Element | null {
    if (s === undefined || s === 'page') return document.body ?? document.documentElement;
    if (s === 'dialog') return topDialog(false);
    if (s === 'menu') return lastVisible(document.querySelectorAll('[role=menu]'));
    if (s === 'listbox') return lastVisible(document.querySelectorAll('[role=listbox]'));
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
  /** Innermost elements whose text contains `q`, with their match tier. */
  function textSearch(root: Element, q: string, exactOnly: boolean): Hit[] {
    const qn = norm(q);
    const ql = lc(qn);
    const out: Hit[] = [];
    if (!ql) return out;
    const visit = (el: Element) => {
      let childHas = false;
      for (const c of Array.from(el.children)) {
        if (SKIP_TAGS.has(c.tagName)) continue;
        if (lc(norm(c.textContent)).includes(ql)) {
          childHas = true;
          visit(c);
        }
      }
      if (!childHas) {
        const t = tierOf(textOf(el), qn, exactOnly);
        if (t >= 0) out.push({ el, tier: t as Tier });
      }
    };
    if (lc(norm(root.textContent)).includes(ql)) visit(root);
    for (const inp of Array.from(root.querySelectorAll(BUTTON_INPUT))) {
      const t = tierOf(textOf(inp), qn, exactOnly);
      if (t >= 0) out.push({ el: inp, tier: t as Tier });
    }
    return out;
  }
  function containsSearch(root: Element, parts: string[]): Element[] {
    const ps = parts.map((p) => lc(norm(p))).filter(Boolean);
    const out: Element[] = [];
    if (!ps.length) return out;
    const has = (el: Element) => {
      const t = lc(norm(el.textContent));
      return ps.every((p) => t.includes(p));
    };
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
    if (has(root)) visit(root);
    return out;
  }
  function labelPairs(root: Element): Array<{ control: Element; text: string }> {
    const out: Array<{ control: Element; text: string }> = [];
    for (const lab of Array.from(root.querySelectorAll('label'))) {
      const text = norm(lab.textContent);
      let control: Element | null = (lab as HTMLLabelElement).control;
      if (!control) {
        const f = lab.getAttribute('for');
        if (f) control = document.getElementById(f);
      }
      if (!control) control = lab.querySelector('input,select,textarea,button,[role=combobox],[role=textbox],[contenteditable]');
      if (control) out.push({ control, text });
    }
    for (const el of Array.from(root.querySelectorAll('[aria-labelledby]'))) {
      out.push({ control: el, text: idsText(el.getAttribute('aria-labelledby') ?? '') });
    }
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
  function docOrder(els: Element[]): Element[] {
    return els.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });
  }
  function cssEscape(s: string): string {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }
  function safeQsa(root: Element, sel: string): Element[] {
    try {
      const all = Array.from(root.querySelectorAll(sel));
      if (root.matches(sel)) all.unshift(root);
      return all;
    } catch (e) {
      throw new Error(`invalid CSS selector ${JSON.stringify(sel)}: ${(e as Error).message}`);
    }
  }

  interface Matched {
    visible: Element[];
    hidden: number;
  }
  function match(t: TargetObject, root: Element, opts: FindOptions): Matched {
    const exact = t.exact === true;
    const contains = t.contains === undefined ? undefined : Array.isArray(t.contains) ? t.contains : [t.contains];
    let base: Element[];
    let used: string;
    let hidden = 0;
    const vis0 = (e: Element) => e !== host && (opts.include_hidden === true || isVisible(e));
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
      let best = bestTier(pairs, (p) => p.text, t.label, exact).map((p) => p.control);
      if (!best.length) {
        const trig = fieldTriggerEl(t.label, root);
        if (trig) best = [trig];
      }
      base = best;
      used = 'label';
    } else if (t.aria !== undefined) {
      const all = keepVisible(safeQsa(root, '[aria-label]'));
      base = bestTier(all, (e) => norm(e.getAttribute('aria-label')), t.aria, exact);
      used = 'aria';
    } else if (t.placeholder !== undefined) {
      const all = keepVisible(safeQsa(root, '[placeholder]'));
      base = bestTier(all, (e) => norm(e.getAttribute('placeholder')), t.placeholder, exact);
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
      const tier = ([0, 1, 2] as Tier[]).map((k) => visHits.filter((h) => h.tier === k)).find((l) => l.length > 0) ?? [];
      base = tier.map((h) => (opts.promote === false ? h.el : promote(h.el, root)));
      used = 'text';
    } else {
      return { visible: [root], hidden: 0 };
    }
    let els = docOrder(uniq(base));
    // Remaining keys act as filters.
    if (used !== 'css' && t.css !== undefined) els = els.filter((e) => e.matches(t.css as string));
    if (used !== 'testid' && t.testid !== undefined) els = els.filter((e) => e.getAttribute('data-testid') === t.testid);
    if (used !== 'role' && t.role !== undefined) els = els.filter((e) => hasRole(e, (t.role as string).toLowerCase()));
    if (t.name !== undefined) els = bestTier(els, accessibleName, t.name, exact);
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

  function similarity(a: string, b: string): number {
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
    for (const el of Array.from(root.querySelectorAll(sel))) {
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

  function describeEl(el: Element): string {
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const name = short(accessibleName(el), 50);
    return `${role ?? tag}${name ? ` "${name}"` : ''}`;
  }
  function popupExpected(el: Element): boolean {
    const hp = el.getAttribute('aria-haspopup');
    if (hp && hp !== 'false') return true;
    if (el.getAttribute('aria-expanded') === 'false') return true;
    return explicitRole(el) === 'combobox';
  }

  function find(t: TargetObject, opts: FindOptions = {}): ResolveResult {
    const root = resolveScope(t.in);
    const query = t.text ?? t.name ?? t.aria ?? t.label ?? t.placeholder ?? (Array.isArray(t.contains) ? t.contains.join(' ') : t.contains) ?? '';
    if (!root) {
      return { count: 0, desc: '', hidden: 0, scope_found: false, near: nearTexts(query, document.body ?? document.documentElement) };
    }
    const m = match(t, root, opts);
    const n = m.visible.length;
    let index = 0;
    if (t.last_visible) index = n - 1;
    if (t.nth !== undefined) index = t.nth < 0 ? n + t.nth : t.nth;
    if (n === 0 || index < 0 || index >= n) {
      return {
        count: 0,
        desc: n > 0 ? `nth=${t.nth} out of range (${n} visible matches)` : '',
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

  // ───────────────────────────── points & hit testing ─────────────────────────────
  function hitInside(el: Element, x: number, y: number): boolean {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (el.contains(hit)) return true;
    // A <label> forwarding to its control, or a control that sits inside a label we hit.
    return hit instanceof HTMLLabelElement && hit.control === el;
  }
  function pointFor(id: string, offset?: PointSpec | null): PointInfo | null {
    const el = deref(id);
    if (!el) return null;
    const bbox = bboxOf(el);
    const v = visibleRect(el);
    if (offset) {
      const x = Math.round(bbox.x + offset.x);
      const y = Math.round(bbox.y + offset.y);
      return { x, y, bbox, hit: hitInside(el, x, y) };
    }
    const cx = Math.round((Math.max(v.l, bbox.x) + Math.min(v.r, bbox.x + bbox.w)) / 2);
    const cy = Math.round((Math.max(v.t, bbox.y) + Math.min(v.b, bbox.y + bbox.h)) / 2);
    if (hitInside(el, cx, cy)) return { x: cx, y: cy, bbox, hit: true };
    // Centre obscured: sample a grid inside the visible part, closest to the centre first.
    const pts: Array<[number, number]> = [];
    for (let fx = 0.15; fx <= 0.86; fx += 0.175) {
      for (let fy = 0.2; fy <= 0.81; fy += 0.2) {
        pts.push([Math.round(v.l + (v.r - v.l) * fx), Math.round(v.t + (v.b - v.t) * fy)]);
      }
    }
    pts.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const [x, y] of pts) if (hitInside(el, x, y)) return { x, y, bbox, hit: true };
    return { x: cx, y: cy, bbox, hit: false };
  }

  // ───────────────────────────── scrolling ─────────────────────────────
  function scrollPlan(id: string, margin: number): ScrollOp | null {
    const el = deref(id);
    if (!el) return null;
    const containers: Element[] = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (isScrollable(p)) containers.push(p);
    }
    containers.push(docScroller());
    const r = el.getBoundingClientRect();
    for (const c of containers) {
      const isDoc = c === docScroller();
      let vt: number;
      let vb: number;
      let vl: number;
      let vr: number;
      if (isDoc) {
        vt = 0;
        vb = window.innerHeight;
        vl = 0;
        vr = window.innerWidth;
      } else {
        const cr = c.getBoundingClientRect();
        vt = cr.top + c.clientTop;
        vb = vt + c.clientHeight;
        vl = cr.left + c.clientLeft;
        vr = vl + c.clientWidth;
      }
      const viewH = vb - vt;
      const viewW = vr - vl;
      const m = Math.min(margin, viewH / 4);
      let dy = 0;
      if (r.top < vt + m || r.bottom > vb - m) {
        dy = r.height > viewH - 2 * m ? r.top - (vt + m) : r.top + r.height / 2 - (vt + viewH * 0.42);
      }
      let dx = 0;
      if (r.left < vl || r.right > vr) {
        dx = r.width > viewW ? r.left - vl : r.left + r.width / 2 - (vl + viewW / 2);
      }
      const maxTop = c.scrollHeight - c.clientHeight;
      const maxLeft = c.scrollWidth - c.clientWidth;
      const fromTop = c.scrollTop;
      const fromLeft = c.scrollLeft;
      const top = Math.max(0, Math.min(maxTop, Math.round(fromTop + dy)));
      const left = Math.max(0, Math.min(maxLeft, Math.round(fromLeft + dx)));
      if (Math.abs(top - fromTop) >= 1 || Math.abs(left - fromLeft) >= 1) {
        return { container: isDoc ? '' : ref(c), top, left, from_top: fromTop, from_left: fromLeft };
      }
    }
    return null;
  }
  function scrollContainerFor(id: string | null, fromParent = false): string {
    const el = deref(id);
    if (el) {
      for (let p: Element | null = fromParent ? el.parentElement : el; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (isScrollable(p)) return ref(p);
      }
      return '';
    }
    const se = docScroller();
    if (se.scrollHeight > se.clientHeight + 1) return '';
    // App shells: the document does not scroll; use the largest visible scrollable element.
    let best: Element | null = null;
    let bestArea = 0;
    for (const c of Array.from(document.body?.querySelectorAll('*') ?? [])) {
      if (c === host) continue;
      const cs = getComputedStyle(c);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY) || c.scrollHeight <= c.clientHeight + 1) continue;
      const v = visibleRect(c);
      const area = Math.max(0, v.r - v.l) * Math.max(0, v.b - v.t);
      if (area > bestArea) {
        best = c;
        bestArea = area;
      }
    }
    return best ? ref(best) : '';
  }
  function containerEl(id: string): Element | null {
    return id ? deref(id) : docScroller();
  }
  function scrollInfo(id: string, of?: string | null): ScrollInfo {
    const c = containerEl(id);
    if (!c) throw new Error('scroll container is gone');
    const info: ScrollInfo = {
      container: id,
      top: c.scrollTop,
      left: c.scrollLeft,
      max_top: c.scrollHeight - c.clientHeight,
      max_left: c.scrollWidth - c.clientWidth,
      client_height: c.clientHeight,
    };
    const t = deref(of ?? null);
    if (t) {
      const tr = t.getBoundingClientRect();
      const top = c === docScroller() ? 0 : c.getBoundingClientRect().top + c.clientTop;
      info.target_top = Math.round(tr.top - top + c.scrollTop);
    }
    return info;
  }
  function easeInOutCubic(u: number): number {
    return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }
  /** rAF raced with setTimeout: rAF alone can stall (background/occluded rendering). */
  function nextTick(fn: () => void): void {
    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      fn();
    };
    requestAnimationFrame(go);
    setTimeout(go, 17);
  }
  function scrollAnimate(id: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }> {
    const c = containerEl(id);
    if (!c) return Promise.reject(new Error('scroll container is gone'));
    const styleEl = (c === docScroller() ? document.documentElement : c) as HTMLElement;
    const prev = styleEl.style.scrollBehavior;
    styleEl.style.scrollBehavior = 'auto';
    const fromTop = c.scrollTop;
    const fromLeft = c.scrollLeft;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const u = ms <= 0 ? 1 : Math.min(1, (performance.now() - t0) / ms);
        const e = easeInOutCubic(u);
        c.scrollTop = fromTop + (top - fromTop) * e;
        c.scrollLeft = fromLeft + (left - fromLeft) * e;
        if (u >= 1) {
          styleEl.style.scrollBehavior = prev;
          resolve({ top: c.scrollTop, left: c.scrollLeft });
          return;
        }
        nextTick(step);
      };
      step();
    });
  }

  // ───────────────────────────── popups ─────────────────────────────
  const POPUP_SEL =
    '[role=menu],[role=listbox],[role=dialog],[role=alertdialog],dialog[open],[data-radix-popper-content-wrapper],[popover]';
  const popupIds = new WeakMap<Element, number>();
  let popupSeq = 0;
  function popupState(): PopupEntry[] {
    const out: PopupEntry[] = [];
    for (const el of Array.from(document.querySelectorAll(POPUP_SEL))) {
      if (el === host) continue;
      if (el.hasAttribute('popover') && !isPopoverOpen(el)) continue;
      if (!isVisible(el)) continue;
      let id = popupIds.get(el);
      if (id === undefined) {
        id = ++popupSeq;
        popupIds.set(el, id);
      }
      const role = explicitRole(el);
      out.push({ id, kind: role ?? (el.tagName === 'DIALOG' ? 'dialog' : el.hasAttribute('popover') ? 'popover' : 'popper'), bbox: bboxOf(el) });
    }
    return out;
  }

  function blankAt(x: number, y: number, avoid: Element[]): boolean {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (isInteractive(hit)) return false;
    if (avoid.some((a) => a.contains(hit))) return false;
    if (hit.closest(POPUP_SEL.replace(',[role=dialog],[role=alertdialog],dialog[open]', ''))) return false;
    return true;
  }
  function textRectCentre(el: Element): PointSpec | null {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }
  function outsidePlan(near: PointSpec, avoidIds: number[]): OutsidePlan | null {
    const popupEls = Array.from(document.querySelectorAll(POPUP_SEL)).filter((e) => {
      const id = popupIds.get(e);
      return id !== undefined && avoidIds.includes(id);
    });
    const dlg = topDialog(true);
    const avoid = popupEls.filter((p) => p !== dlg && !(dlg && p.contains(dlg)));
    const keepFor = (x: number, y: number): number[] => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return [];
      const ids: number[] = [];
      for (const el of Array.from(document.querySelectorAll(POPUP_SEL))) {
        const id = popupIds.get(el);
        if (id !== undefined && el.contains(hit)) ids.push(id);
      }
      return ids;
    };
    const plan = (kind: OutsidePlan['kind'], x: number, y: number, r?: string): OutsidePlan => ({ kind, x, y, ref: r, keep: keepFor(x, y) });
    if (dlg) {
      const lb = dlg.getAttribute('aria-labelledby');
      const byId = lb ? document.getElementById(lb.split(/\s+/)[0]) : null;
      const title =
        (byId && dlg.contains(byId) ? byId : null) ??
        Array.from(dlg.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).find((h) => isVisible(h)) ??
        null;
      if (title && isVisible(title)) {
        const c = textRectCentre(title) ?? pointFor(ref(title))!;
        if (c && blankAt(c.x, c.y, avoid)) return plan('dialog-title', c.x, c.y, ref(title));
        const tb = title.getBoundingClientRect();
        for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
          const x = Math.round(tb.left + tb.width * fx);
          const y = Math.round(tb.top + tb.height / 2);
          if (blankAt(x, y, avoid)) return plan('dialog-title', x, y, ref(title));
        }
      }
      // Blank padding inside the dialog, top area first.
      const dr = dlg.getBoundingClientRect();
      for (let fy = 0.04; fy <= 0.5; fy += 0.06) {
        for (let fx = 0.5; fx <= 0.96; fx += 0.08) {
          const x = Math.round(dr.left + dr.width * fx);
          const y = Math.round(dr.top + dr.height * fy);
          const hit = document.elementFromPoint(x, y);
          if (hit && dlg.contains(hit) && blankAt(x, y, avoid)) return plan('blank', x, y);
        }
      }
      return null;
    }
    const pts: PointSpec[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    for (const y of [24, 48, 80, 112, 150, 200]) {
      for (let fx = 0.05; fx <= 0.96; fx += 0.05) pts.push({ x: Math.round(W * fx), y: Math.min(H - 4, y) });
    }
    for (let fy = 0.3; fy <= 0.95; fy += 0.1) for (let fx = 0.05; fx <= 0.96; fx += 0.1) pts.push({ x: Math.round(W * fx), y: Math.round(H * fy) });
    const dist = (p: PointSpec) => Math.hypot(p.x - near.x, p.y - near.y);
    const top = pts.slice(0, 6 * 19).filter((p) => blankAt(p.x, p.y, avoid));
    const pool = top.length ? top : pts.filter((p) => blankAt(p.x, p.y, avoid));
    if (!pool.length) return null;
    pool.sort((a, b) => dist(a) - dist(b));
    return plan('blank', pool[0].x, pool[0].y);
  }

  function restPoint(where: 'side' | 'centre' = 'side'): PointSpec {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cands: Array<[number, number]> =
      where === 'centre'
        ? [[0.5, 0.5], [0.5, 0.42], [0.44, 0.5], [0.56, 0.5], [0.5, 0.58], [0.42, 0.42], [0.58, 0.42], [0.42, 0.58], [0.58, 0.58]]
        : [[0.8, 0.5], [0.84, 0.44], [0.76, 0.58], [0.88, 0.52], [0.72, 0.46], [0.82, 0.66], [0.9, 0.36], [0.66, 0.62]];
    for (const [fx, fy] of cands) {
      const x = Math.round(W * fx);
      const y = Math.round(H * fy);
      const hit = document.elementFromPoint(x, y);
      if (!hit || isInteractive(hit)) continue;
      const cur = getComputedStyle(hit).cursor;
      if (cur === 'pointer' || cur === 'text') continue;
      return { x, y };
    }
    return where === 'centre' ? { x: Math.round(W * 0.5), y: Math.round(H * 0.5) } : { x: Math.round(W * 0.8), y: Math.round(H * 0.5) };
  }

  /** Box covered by the drawn cursor when its hotspot is at (x, y): the arrow extends right and down. */
  function cursorBox(x: number, y: number): { l: number; t: number; r: number; b: number } {
    const size = Math.max(12, config.cursor.size || 26);
    return { l: x - 6, t: y - 6, r: x + size * 0.8 + 4, b: y + size + 6 };
  }
  function restNear(box: BBox): { x: number; y: number; side: string } {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const EDGE = 28;
    const CLEAR = 14;
    const R = box.x + box.w;
    const B = box.y + box.h;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    // Natural resting spots a hand would leave the pointer at: below-right first, then around the target.
    const cands: Array<[string, number, number]> = [
      ['below-right', R + 56, B + 44],
      ['right', R + 84, cy + 18],
      ['below', cx + 36, B + 64],
      ['below-left', box.x - 64, B + 44],
      ['above-right', R + 56, box.y - 72],
      ['above', cx + 36, box.y - 92],
      ['left', box.x - 96, cy + 18],
      ['above-left', box.x - 72, box.y - 72],
    ];
    const inside = (x: number, y: number) => x >= EDGE && y >= EDGE && x <= W - EDGE - 20 && y <= H - EDGE - 28;
    const covers = (x: number, y: number) => {
      const c = cursorBox(x, y);
      return c.r > box.x - CLEAR && c.l < R + CLEAR && c.b > box.y - CLEAR && c.t < B + CLEAR;
    };
    const neutral = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit) return true;
      if (isInteractive(hit) || hit.closest('a[href],button,input,select,textarea,[role=button],[role=link]')) return false;
      const cur = getComputedStyle(hit).cursor;
      return cur !== 'pointer' && cur !== 'text';
    };
    const ok = cands.filter(([, x, y]) => inside(x, y) && !covers(x, y)).map(([side, x, y]) => ({ side, x: Math.round(x), y: Math.round(y) }));
    const best = ok.find((p) => neutral(p.x, p.y)) ?? ok[0];
    if (best) return best;
    return { ...restPoint(), side: 'fallback' };
  }

  // ───────────────────────────── widgets ─────────────────────────────
  const TRIGGER_NAME = /\b(actions?|more|menu|options|manage|settings|row actions)\b|…|⋯|⋮|•••|\.\.\./i;
  function menuTrigger(rowId: string): string | null {
    const row = deref(rowId);
    if (!row) return null;
    const vis = (sel: string) => Array.from(row.querySelectorAll(sel)).filter((e) => isVisible(e));
    const popupTriggers = vis('[aria-haspopup=menu],[aria-haspopup=true]');
    const named = (e: Element) => TRIGGER_NAME.test(`${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''} ${textOf(e)}`);
    const pick = popupTriggers.find(named) ?? popupTriggers[popupTriggers.length - 1];
    if (pick) return ref(pick);
    const buttons = vis('button,[role=button]');
    const byName = buttons.find(named);
    if (byName) return ref(byName);
    const last = buttons[buttons.length - 1];
    return last ? ref(last) : null;
  }
  function fieldTriggerEl(label: string, root: Element): Element | null {
    const q = norm(label);
    const labels = Array.from(root.querySelectorAll('label,legend,[id],div,span,p,dt,th')).filter(
      (e) => e.children.length <= 3 && tierOf(norm(e.textContent), q, false) >= 0 && isVisible(e),
    );
    const best = bestTier(labels, (e) => norm(e.textContent), q, false);
    const TRIG = '[role=combobox],[aria-haspopup]:not([aria-haspopup=false]),button,[role=button],input:not([type=hidden]),select,textarea';
    for (const lab of best) {
      if (lab instanceof HTMLLabelElement) {
        const c = lab.control;
        if (c && isVisible(c)) return c;
        const f = lab.getAttribute('for');
        const byFor = f ? document.getElementById(f) : null;
        if (byFor && isVisible(byFor)) return byFor;
      }
      if (lab.id) {
        const lb = Array.from(document.querySelectorAll(`[aria-labelledby~="${cssEscape(lab.id)}"]`)).find((e) => isVisible(e));
        if (lb) return lb;
      }
      for (let p = lab.parentElement, depth = 0; p && depth < 4 && p !== document.body; p = p.parentElement, depth++) {
        const cands = Array.from(p.querySelectorAll(TRIG)).filter((e) => e !== lab && !lab.contains(e) && isVisible(e));
        if (cands.length) {
          return cands.find((e) => e.matches('[role=combobox],[aria-haspopup]:not([aria-haspopup=false])')) ?? cands[0];
        }
      }
    }
    return null;
  }
  const CANCEL = /^(cancel|close|dismiss|back|no|not now|keep|annuler|fermer|non|abbrechen|cancelar|annulla)$/i;
  function confirmButton(text: string | null): string | null {
    const dlg = topDialog(true);
    if (!dlg) return null;
    const buttons = Array.from(dlg.querySelectorAll('button,[role=button],input[type=submit],input[type=button]')).filter((e) => isVisible(e));
    if (text !== null) {
      const best = bestTier(buttons, (e) => accessibleName(e), text, false);
      return best.length ? ref(best[0]) : null;
    }
    const ok = buttons.find((b) => !CANCEL.test(accessibleName(b)) && accessibleName(b) !== '');
    return ok ? ref(ok) : null;
  }
  function fileInputFor(id: string): string | null {
    const zone = deref(id);
    if (!zone) return null;
    const isFile = (e: Element | null): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === 'file';
    if (isFile(zone)) return ref(zone);
    const inside = zone.querySelector('input[type=file]');
    if (inside) return ref(inside);
    const lab = zone.closest('label');
    if (lab && isFile(lab.control)) return ref(lab.control);
    for (let p = zone.parentElement, d = 0; p && d < 3 && p !== document.body; p = p.parentElement, d++) {
      const all = p.querySelectorAll('input[type=file]');
      if (all.length === 1) return ref(all[0]);
      if (all.length > 1) break;
    }
    return null;
  }
  function selectNative(id: string, option: string): { ok: boolean; label?: string; options: string[] } {
    const el = deref(id);
    if (!(el instanceof HTMLSelectElement)) return { ok: false, options: [] };
    const opts = Array.from(el.options);
    const labels = opts.map((o) => norm(o.label || o.text));
    const best = bestTier(opts, (o) => norm(o.label || o.text), option, false);
    const o = best[0] ?? opts.find((x) => x.value === option);
    if (!o) return { ok: false, options: labels };
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, o.value);
    else el.value = o.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: norm(o.label || o.text), options: labels };
  }
  function isTextInput(id: string | null): boolean {
    const el = id ? deref(id) : document.activeElement;
    if (!el) return false;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type);
    }
    return (el as HTMLElement).isContentEditable === true;
  }

  // ───────────────────────────── synthetic clicks ─────────────────────────────
  function innerTarget(el: Element, x: number, y: number): Element {
    const hit = document.elementFromPoint(x, y);
    return hit && el.contains(hit) ? hit : el;
  }
  function flashPress(): void {
    cursorApi.press(true);
    setTimeout(() => cursorApi.press(false), 110);
  }
  function domClick(id: string, x: number, y: number): void {
    const el = deref(id);
    if (!el) throw new Error('element is gone');
    const t = innerTarget(el, x, y);
    cursorApi.ripple(x, y);
    flashPress();
    if (t instanceof HTMLElement) t.click();
    else t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, detail: 1 }));
  }
  function pointerSequence(id: string, x: number, y: number): void {
    const el = deref(id);
    if (!el) throw new Error('element is gone');
    const t = innerTarget(el, x, y);
    cursorApi.ripple(x, y);
    flashPress();
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window, detail: 1, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1 };
    t.dispatchEvent(new PointerEvent('pointerover', { ...ptr, buttons: 0 }));
    t.dispatchEvent(new MouseEvent('mouseover', { ...base, buttons: 0 }));
    const downOk = t.dispatchEvent(new PointerEvent('pointerdown', { ...ptr, buttons: 1, pressure: 0.5 }));
    let mdOk = true;
    if (downOk) mdOk = t.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (downOk && mdOk) {
      const focusable = t.closest(
        'button,a[href],input,select,textarea,[tabindex],[contenteditable=""],[contenteditable=true]',
      ) as HTMLElement | null;
      focusable?.focus?.({ preventScroll: true });
    }
    t.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0, pressure: 0 }));
    if (downOk) t.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    t.dispatchEvent(new MouseEvent('click', { ...base, buttons: 0 }));
  }

  // ───────────────────────────── file drag ─────────────────────────────
  let drag: { dt: DataTransfer; current: Element | null; accepted: boolean } | null = null;
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
  const fileDrag = {
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

  // ───────────────────────────── cursor overlay ─────────────────────────────
  const S = Math.max(12, config.cursor.size || 26);
  const k = S / 24;
  const light = config.cursor.style === 'arrow-light';
  const debug = config.cursor.style === 'debug';
  const arrowFill = light ? '#fff' : '#111';
  const arrowStroke = light ? '#111' : '#fff';
  const svg = (cls: string, hx: number, hy: number, body: string) =>
    `<svg class="${cls}" width="${S}" height="${S}" viewBox="0 0 24 24" style="left:${-hx * k}px;top:${-hy * k}px">${body}</svg>`;
  const arrowSvg = svg(
    'arrow',
    4,
    2,
    `<path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.3 L11.6 13.6 L17.8 13.6 Z" fill="${arrowFill}" stroke="${arrowStroke}" stroke-width="1.4" stroke-linejoin="round"/>`,
  );
  const fingers: Array<[number, number, number, number, number]> = [
    [9.6, 3.0, 9.6, 13.0, 2.8],
    [12.35, 9.5, 12.35, 14.0, 2.7],
    [15.0, 10.4, 15.0, 14.5, 2.6],
    [17.5, 11.6, 17.5, 15.0, 2.4],
    [8.7, 17.4, 5.7, 14.2, 2.6],
  ];
  const palm = 'M8.25 12.2 H18.7 V16.6 C18.7 19.7 16.7 21.7 13.7 21.7 H12.6 C10.9 21.7 9.8 21 8.9 19.8 L8.25 18.9 Z';
  const capsules = (color: string, extra: number) =>
    fingers
      .map(([x1, y1, x2, y2, wd]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${wd + extra}" stroke-linecap="round"/>`)
      .join('');
  const handSvg = svg(
    'hand',
    9.6,
    1.9,
    `${capsules('#111', 2.2)}<path d="${palm}" fill="#111" stroke="#111" stroke-width="2.2" stroke-linejoin="round"/>` +
      `${capsules('#fff', 0)}<path d="${palm}" fill="#fff"/>` +
      `<path d="M11 11.9 V13.8 M13.68 12.3 V14.3 M16.25 12.9 V14.6" stroke="#111" stroke-width=".7" stroke-linecap="round"/>`,
  );
  const ibeamPath = 'M9.6 4.6 C11 4.6 12 5.1 12 6.4 C12 5.1 13 4.6 14.4 4.6 M12 6.4 V17.6 M9.6 19.4 C11 19.4 12 18.9 12 17.6 C12 18.9 13 19.4 14.4 19.4 M10.4 12 H13.6';
  const ibeamSvg = svg(
    'ibeam',
    12,
    12,
    `<path d="${ibeamPath}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="${ibeamPath}" fill="none" stroke="#111" stroke-width="1.3" stroke-linecap="round"/>`,
  );

  const host = document.createElement('demo-studio-cursor');
  /** The overlay's look (also handed to the raw export's cursor layer, L2.13: `api.cursorLook`). */
  const lookCss = `
    :host{all:initial}
    .c{position:absolute;left:0;top:0;display:none;will-change:transform}
    .c.on{display:block}
    .s{position:absolute;left:0;top:0;transform-origin:0 0;transition:transform 90ms ease-out}
    .s.p{transform:scale(.9)}
    .c svg{position:absolute;display:none;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}
    .c[data-k=arrow] svg.arrow,.c[data-k=hand] svg.hand,.c[data-k=ibeam] svg.ibeam{display:block}
    .dbg{position:absolute;left:-3px;top:-3px;width:6px;height:6px;background:#FF00FF}
    .rp{position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
        background:${config.cursor.ripple_color};pointer-events:none;
        box-shadow:0 0 0 1.1px rgba(255,255,255,.95),0 0 0 2px rgba(17,17,17,.3);
        animation:dsr-t 500ms cubic-bezier(.2,.7,.2,1) forwards,dsr-o 550ms ease-out forwards}
    @keyframes dsr-t{from{transform:var(--p) scale(.4)}to{transform:var(--p) scale(5.5)}}
    @keyframes dsr-o{from{opacity:1}to{opacity:0}}
    .g{position:absolute;left:0;top:0;display:flex;align-items:center;gap:12px;padding:10px 16px 10px 10px;
       background:#fff;border:1px solid rgba(31,20,19,.12);border-radius:12px;
       box-shadow:0 16px 36px rgba(31,20,19,.22),0 2px 6px rgba(31,20,19,.08);
       font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;
       opacity:0;transition:opacity .25s ease-out;white-space:nowrap;transform-origin:30px 22px}
    .g.on{opacity:1}
    .g .b{position:relative;width:36px;height:44px;flex:none}
    .g .b svg{display:block}
    .g .b span{position:absolute;left:0;right:0;bottom:6px;text-align:center;color:#fff;font-size:10px;font-weight:700;letter-spacing:.02em}
    .g .n{font-size:15px;font-weight:600;color:#1f1413;line-height:1.25}
    .g .d{font-size:12px;color:#6b605d;line-height:1.3;margin-top:2px}
  `;
  const lookHtml =
    `<div class="rps"></div><div class="g"></div>` +
    `<div class="c" data-k="arrow"><div class="s">${arrowSvg}${handSvg}${ibeamSvg}</div>${debug ? '<div class="dbg"></div>' : ''}</div>`;
  // Raw capture without the cursor (L2.13): the pointer, its icon, presses and ripples keep working and are reported,
  // nothing of them is drawn (the file-drag ghost card stays: it is the page's content being dragged).
  const css = lookCss + (config.cursor.hidden ? '.c,.rps{display:none!important}' : '');
  /** Report what the cursor shows (icon, press, ripple) to the runner (binding `__demoStudioCursor`), never failing. */
  function effect(type: 'icon' | 'press' | 'release' | 'ripple', extra: { icon?: CursorKind; x?: number; y?: number } = {}): void {
    try {
      const b = (window as unknown as Record<string, unknown>).__demoStudioCursor;
      if (typeof b !== 'function') return;
      const r = (b as (p: unknown) => unknown)({ type, time: Date.now(), ...extra }) as { catch?: (f: () => void) => void } | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch {
      /* the runner is gone */
    }
  }
  let shadow: ShadowRoot | null = null;
  let cursorEl: HTMLElement | null = null;
  let scaleEl: HTMLElement | null = null;
  let ripplesEl: HTMLElement | null = null;
  let ghostEl: HTMLElement | null = null;
  const state: CursorState = { x: 0, y: 0, visible: false, known: false, kind: 'arrow', pressed: false };
  let wantVisible = true;
  let ghostOn = false;

  function buildOverlay(): void {
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute(
      'style',
      [
        'position:fixed', 'inset:0', 'left:0', 'top:0', 'width:100vw', 'height:100vh', 'max-width:none', 'max-height:none',
        'margin:0', 'padding:0', 'border:0', 'background:transparent', 'overflow:visible', 'pointer-events:none',
        'z-index:2147483647', 'display:block', 'opacity:1', 'visibility:visible', 'transform:none', 'filter:none',
        'clip-path:none', 'color-scheme:normal',
      ]
        .map((d) => d + '!important')
        .join(';'),
    );
    if ('popover' in HTMLElement.prototype) host.setAttribute('popover', 'manual');
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${css}</style>${lookHtml}`;
    cursorEl = shadow.querySelector('.c');
    scaleEl = shadow.querySelector('.s');
    ripplesEl = shadow.querySelector('.rps');
    ghostEl = shadow.querySelector('.g');
  }

  const origShowPopover = HTMLElement.prototype.showPopover;
  const origHidePopover = HTMLElement.prototype.hidePopover;
  function popoverOpen(): boolean {
    return isPopoverOpen(host);
  }
  function showLayer(): void {
    if (disposed || !host.isConnected || !host.hasAttribute('popover') || typeof origShowPopover !== 'function') return;
    try {
      if (!popoverOpen()) origShowPopover.call(host);
    } catch {
      /* not allowed right now (e.g. during a fullscreen transition); z-index fallback applies */
    }
  }
  /** Move the overlay to the top of the top layer (above a modal dialog / popover opened after it). */
  function raise(): void {
    if (disposed || !host.isConnected || !host.hasAttribute('popover')) return;
    try {
      if (popoverOpen()) origHidePopover.call(host);
      origShowPopover.call(host);
    } catch {
      /* keep the z-index fallback */
    }
  }
  let raiseQueued = false;
  function queueRaise(): void {
    if (raiseQueued) return;
    raiseQueued = true;
    queueMicrotask(() => {
      raiseQueued = false;
      raise();
    });
  }
  function attach(): void {
    if (disposed) return;
    const root = document.documentElement;
    if (!root) return;
    if (host.parentNode !== root) root.appendChild(host);
    showLayer();
  }

  function render(): void {
    if (!cursorEl) return;
    const on = state.known && wantVisible;
    state.visible = on;
    cursorEl.classList.toggle('on', on);
    cursorEl.style.transform = `translate3d(${state.x}px,${state.y}px,0)`;
    cursorEl.dataset.k = state.kind;
    if (ghostEl && ghostOn) ghostEl.style.transform = `translate3d(${state.x - 30}px,${state.y - 22}px,0) rotate(-3deg)`;
  }
  let lastSave = 0;
  function save(force = false): void {
    const now = Date.now();
    if (!force && now - lastSave < 120) return;
    lastSave = now;
    try {
      sessionStorage.setItem(config.storage_key, JSON.stringify({ x: state.x, y: state.y, v: wantVisible }));
    } catch {
      /* storage unavailable (opaque origin, blocked) */
    }
  }
  function restore(): void {
    try {
      const raw = sessionStorage.getItem(config.storage_key);
      if (!raw) return;
      const p = JSON.parse(raw) as { x: number; y: number; v: boolean };
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        state.x = p.x;
        state.y = p.y;
        state.known = true;
        wantVisible = p.v !== false;
      }
    } catch {
      /* ignore */
    }
  }
  let lastKind = 0;
  function computeKind(): CursorKind {
    const el = document.elementFromPoint(state.x, state.y);
    if (!el) return 'arrow';
    const cur = getComputedStyle(el).cursor;
    if (cur === 'pointer') return 'hand';
    if (cur === 'text' || cur === 'vertical-text') return 'ibeam';
    if (cur === 'auto') {
      const ed = el.closest('input,textarea,[contenteditable=""],[contenteditable=true]');
      if (ed instanceof HTMLInputElement) {
        return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(ed.type) ? 'ibeam' : 'arrow';
      }
      return ed ? 'ibeam' : 'arrow';
    }
    return 'arrow';
  }
  let kindTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last icon reported to the runner (a new document reports its first one). */
  let reportedKind: CursorKind | null = null;
  function updateKind(force: boolean): void {
    const now = performance.now();
    if (!force && now - lastKind < 50) {
      // Throttled: make sure the icon is re-evaluated once the pointer settles.
      kindTimer ??= setTimeout(() => {
        kindTimer = null;
        updateKind(true);
      }, 50 - (now - lastKind));
      return;
    }
    lastKind = now;
    const kd = computeKind();
    if (kd !== state.kind) {
      state.kind = kd;
      render();
    }
    if (kd !== reportedKind) {
      reportedKind = kd;
      effect('icon', { icon: kd });
    }
  }
  function moveTo(x: number, y: number): void {
    state.x = x;
    state.y = y;
    state.known = true;
    render();
    updateKind(false);
    save();
    if (drag) fileDrag.over(x, y);
  }
  function ripple(x: number, y: number): void {
    if (!ripplesEl) return;
    const d = document.createElement('div');
    d.className = 'rp';
    d.style.setProperty('--p', `translate(${x}px,${y}px)`);
    d.style.transform = `translate(${x}px,${y}px)`;
    ripplesEl.appendChild(d);
    effect('ripple', { x, y });
    const kill = () => d.remove();
    d.addEventListener('animationend', (e) => {
      if ((e as AnimationEvent).animationName === 'dsr-o') kill();
    });
    setTimeout(kill, 800);
  }
  function press(down: boolean): void {
    const changed = state.pressed !== down;
    state.pressed = down;
    scaleEl?.classList.toggle('p', down);
    if (changed) effect(down ? 'press' : 'release');
  }
  const cursorApi = {
    set(x: number, y: number, show?: boolean): void {
      if (show !== undefined) wantVisible = show;
      moveTo(x, y);
      save(true);
    },
    show(): void {
      wantVisible = true;
      render();
      save(true);
    },
    hide(): void {
      wantVisible = false;
      render();
      save(true);
    },
    ripple,
    press,
    state: (): CursorState => ({ ...state }),
  };

  const EXT_COLORS: Record<string, string> = {
    xlsx: '#1f8a4c', xls: '#1f8a4c', csv: '#6b7280', tsv: '#6b7280', pdf: '#d93a2b', docx: '#2b5fb8', doc: '#2b5fb8',
    pptx: '#d2602a', ppt: '#d2602a', zip: '#b8892b', png: '#7a4fc9', jpg: '#7a4fc9', jpeg: '#7a4fc9', json: '#4b5563', txt: '#6b7280',
  };
  function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  }
  const ghost = {
    show(name: string, detail: string): void {
      if (!ghostEl) return;
      const ext = (name.includes('.') ? name.split('.').pop() ?? '' : '').toLowerCase().slice(0, 4);
      const color = EXT_COLORS[ext] ?? '#64748b';
      ghostEl.innerHTML =
        `<div class="b"><svg width="36" height="44" viewBox="0 0 36 44"><path d="M4 0 H24 L36 12 V40 A4 4 0 0 1 32 44 H4 A4 4 0 0 1 0 40 V4 A4 4 0 0 1 4 0 Z" fill="${color}"/>` +
        `<path d="M24 0 V8 A4 4 0 0 0 28 12 H36 Z" fill="#fff" fill-opacity=".35"/></svg><span>${esc(ext.toUpperCase())}</span></div>` +
        `<div><div class="n">${esc(name)}</div>${detail ? `<div class="d">${esc(detail)}</div>` : ''}</div>`;
      ghostOn = true;
      render();
      ghostEl.getBoundingClientRect();
      ghostEl.classList.add('on');
    },
    hide(): void {
      if (!ghostEl) return;
      ghostEl.classList.remove('on');
      const el = ghostEl;
      setTimeout(() => {
        if (!el.classList.contains('on')) {
          ghostOn = false;
          el.innerHTML = '';
        }
      }, 300);
    },
  };

  if (isTop) {
    buildOverlay();
    restore();
    if (carried?.known) {
      state.x = carried.x;
      state.y = carried.y;
      state.known = true;
      wantVisible = carried.visible || !carried.known;
    }
    render();
    const onMove = (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      if (m.clientX === state.x && m.clientY === state.y && state.known) return;
      moveTo(m.clientX, m.clientY);
    };
    let downAt = 0;
    const onDown = (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      const now = performance.now();
      if (m.type === 'mousedown' && now - downAt < 80) return;
      downAt = now;
      moveTo(m.clientX, m.clientY);
      press(true);
      ripple(m.clientX, m.clientY);
    };
    const onUp = (e: Event) => {
      if (e.isTrusted) press(false);
    };
    on(window, 'pointermove', onMove);
    on(window, 'mousemove', onMove);
    on(window, 'pointerdown', onDown);
    on(window, 'mousedown', onDown);
    on(window, 'pointerup', onUp);
    on(window, 'mouseup', onUp);
    on(window, 'dragover', (e) => {
      const m = e as DragEvent;
      if (m.isTrusted) moveTo(m.clientX, m.clientY);
    });
    on(window, 'pagehide', () => save(true));
    on(window, 'toggle', (e) => {
      if (e.target !== host && (e as ToggleEvent).newState === 'open') queueRaise();
    });
    const timer = setInterval(() => {
      if (state.visible) updateKind(true);
    }, 250);
    cleanups.push(() => clearInterval(timer));

    const patch = (proto: object, name: string) => {
      const p = proto as Record<string, unknown>;
      const orig = p[name];
      if (typeof orig !== 'function') return;
      p[name] = function (this: Element, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        if (this !== host && !disposed) queueRaise();
        return r;
      };
    };
    patch(HTMLDialogElement.prototype, 'showModal');
    patch(HTMLElement.prototype, 'showPopover');
    patch(HTMLElement.prototype, 'togglePopover');

    const mo = new MutationObserver(() => {
      if (!host.isConnected) attach();
    });
    const start = () => {
      if (disposed || !document.documentElement) return;
      attach();
      mo.observe(document.documentElement, { childList: true });
    };
    const docMo = new MutationObserver(() => {
      if (document.documentElement && !host.isConnected) start();
    });
    docMo.observe(document, { childList: true });
    cleanups.push(() => {
      mo.disconnect();
      docMo.disconnect();
      host.remove();
    });
    start();
  } else {
    // Sub-frames forward real pointer input to the parent, which offsets it by the frame position.
    const fwd = (type: string) => (e: Event) => {
      const m = e as MouseEvent;
      if (!m.isTrusted) return;
      try {
        window.parent.postMessage({ __demoStudioPtr: 1, type, x: m.clientX, y: m.clientY }, '*');
      } catch {
        /* detached */
      }
    };
    on(window, 'pointermove', fwd('move'));
    on(window, 'pointerdown', fwd('down'));
    on(window, 'pointerup', fwd('up'));
  }
  on(window, 'message', (ev: Event) => {
    const e = ev as MessageEvent;
    const d = e.data as { __demoStudioPtr?: number; type?: string; x?: number; y?: number } | null;
    if (!d || d.__demoStudioPtr !== 1 || typeof d.x !== 'number' || typeof d.y !== 'number') return;
    const frame = Array.from(document.querySelectorAll('iframe,frame')).find(
      (f) => (f as HTMLIFrameElement).contentWindow === e.source,
    ) as HTMLIFrameElement | undefined;
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    const cs = getComputedStyle(frame);
    const x = d.x + r.left + frame.clientLeft + parseFloat(cs.paddingLeft || '0');
    const y = d.y + r.top + frame.clientTop + parseFloat(cs.paddingTop || '0');
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

  const api: KitApi = {
    version: VERSION,
    healthy: () => {
      if (disposed) return false;
      pinged = false;
      window.dispatchEvent(new Event('__demo_studio_ping'));
      return pinged && (!isTop || host.isConnected);
    },
    dispose: () => {
      disposed = true;
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
    },
    config,
    cursor: cursorApi,
    cursorLook: { css: lookCss, html: lookHtml },
    ghost,
    fileDrag,
    find,
    el: (id) => deref(id),
    alive: (id) => deref(id) !== null,
    visible: (id) => {
      const el = deref(id);
      return el !== null && isVisible(el);
    },
    point: pointFor,
    scrollPlan,
    scrollContainerFor,
    scrollInfo,
    scrollAnimate,
    popupState,
    expanded: (id) => deref(id)?.getAttribute('aria-expanded') ?? null,
    outsidePlan,
    blankPoint: (near) => {
      const p = outsidePlan(near, popupState().map((e) => e.id));
      return p ? { x: p.x, y: p.y } : null;
    },
    dragGhost: ghost,
    restPoint,
    restNear,
    hasText: textVisible,
    snapshot: (id, max) => {
      const el = id ? deref(id) : document.body;
      let html = el ? el.outerHTML : document.documentElement.outerHTML;
      html = html.replace(/<demo-studio-cursor[\s\S]*?<\/demo-studio-cursor>/g, '');
      if (html.length <= max) return html;
      // Cut after the last complete tag within the cap (a cut inside a tag would be unreadable).
      let cut = html.lastIndexOf('>', max - 1) + 1;
      if (cut < max * 0.75) cut = max;
      return html.slice(0, cut) + `\n<!-- … trimmed to ${cut} of ${html.length} chars -->`;
    },
    domClick,
    pointerSequence,
    rowFor: (text) => {
      const r = rowFor(text);
      return r ? ref(r) : null;
    },
    menuTrigger,
    fieldTrigger: (label) => {
      const el = fieldTriggerEl(label, document.body);
      return el ? ref(el) : null;
    },
    confirmButton,
    fileInputFor,
    selectNative,
    isTextInput,
    describe: (id) => {
      const el = deref(id);
      return el ? describeEl(el) : '(gone)';
    },
    info: (id) => {
      const el = deref(id);
      if (!el) return null;
      const a = el.closest('a[href]') as HTMLAnchorElement | null;
      return {
        desc: describeEl(el),
        tag: el.tagName.toLowerCase(),
        role: roleOf(el),
        text: short(textOf(el)),
        href: a ? a.href : null,
        popup_expected: popupExpected(el),
      };
    },
    textOf: (id) => {
      const el = deref(id);
      return el ? short(textOf(el), 200) : '';
    },
    focused: () => {
      // The focused field (type steps without `into`): its description and box, when it is visible.
      let el: Element | null = document.activeElement;
      while (el && el.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement || !isVisible(el)) return null;
      return { desc: describeEl(el), bbox: bboxOf(el) };
    },
    visibleText: (id) => {
      const el = deref(id);
      if (!el) return '';
      const raw = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el instanceof HTMLElement ? el.innerText : el.textContent;
      return norm(raw).slice(0, 2000);
    },
  };
  Object.defineProperty(window, '__demoStudio', { value: api, configurable: true, enumerable: false, writable: true });
}
