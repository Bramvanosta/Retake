/**
 * The in-page kit, installed as `window.__retake` in every page and frame.
 *
 * `demoKit` MUST stay self-contained: it is serialised with `Function.prototype.toString()` and evaluated
 * in the page (see source.ts), so it may not reference anything outside its own body at runtime
 * (type-only imports are fine, they are erased).
 */
import type { BBox, PointSpec, ScopeSpec, SecretFieldKind, TargetObject } from '@retake/core';
import type {
  CalendarInfo,
  CursorKind,
  CursorState,
  DropOutcome,
  FieldState,
  FileSpec,
  FindOptions,
  FragileFlag,
  InventoryContext,
  InventoryElement,
  InventoryOptions,
  InventoryPopup,
  InventoryScroller,
  KitActionHint,
  KitApi,
  KitInventory,
  KitSuggestion,
  KitTargetCheck,
  KitTargetChecks,
  KitConfig,
  NearElement,
  OutsidePlan,
  PointInfo,
  PopupEntry,
  ResolveMissing,
  ResolveResult,
  ScrollInfo,
  ScrollOp,
} from './types.js';

export function demoKit(config: KitConfig): void {
  const VERSION = '1.6.0';
  // ── Time sources (L1.7): the kit's timers, frames and clocks are the browser's real ones, captured once — also under
  // a product clock (`clock:`: product-clock.ts replaces `Date` in every document). The kit's init script runs before
  // the clock's in each new document, so `Date` is still real there; evaluated later (KitClient.install), it takes the
  // real `Date` the clock kept. Cursor effects are stamped on the real clock (the runner maps them to capture time); a
  // notification's time and a dropped file's date stay the product's.
  const RT = (() => {
    const g = globalThis as unknown as Record<string | symbol, unknown>;
    const clock = g[Symbol.for('retake.clock')] as { Date?: DateConstructor } | undefined;
    const saved: Record<string, unknown> = clock?.Date ? { Date: clock.Date } : {};
    const pick = <T,>(name: string, bind: boolean): T => {
      const v = saved[name] ?? g[name];
      return (bind && typeof v === 'function' && saved[name] === undefined ? (v as (...a: unknown[]) => unknown).bind(g) : v) as T;
    };
    return {
      setTimeout: pick<typeof setTimeout>('setTimeout', true),
      clearTimeout: pick<typeof clearTimeout>('clearTimeout', true),
      setInterval: pick<typeof setInterval>('setInterval', true),
      clearInterval: pick<typeof clearInterval>('clearInterval', true),
      requestAnimationFrame: pick<typeof requestAnimationFrame>('requestAnimationFrame', true),
      performance: pick<Performance>('performance', false),
      Date: pick<DateConstructor>('Date', false),
    };
  })();
  // ── Web notifications (R-NTF-03): report every `new Notification(…)` and ServiceWorkerRegistration#showNotification
  // to the runner (binding `__retakeNotification`, else queued in `__retakeNotifications`, at most 50), then let the
  // page's call proceed unchanged. Patched once per window (a re-installed kit keeps the first patch). Only a page's own
  // document reports (the runner ignores a frame inside it); each text is sent one character past the runner's limit
  // (session.ts NOTIFICATION_TEXT_MAX, NOTIFICATION_ICON_URL_MAX), which cuts or drops what is longer.
  (() => {
    const TEXT_SENT = 2049;
    const ICON_SENT = 1_500_001;
    type Reported = { via: string; title: string; body: string; tag?: string; icon?: string; time: number; url: string; origin: string };
    const g = window as unknown as Record<string, unknown> & { __retakeNotifications?: Reported[] };
    if (config.passive || g.__retakeNotifyPatched) return;
    let top = true;
    try {
      top = window.top === window;
    } catch {
      top = false;
    }
    if (!top) return;
    g.__retakeNotifyPatched = true;
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
          title: String(title ?? '').slice(0, TEXT_SENT),
          body: o.body === undefined || o.body === null ? '' : String(o.body).slice(0, TEXT_SENT),
          time: Date.now(),
          url: location.href.slice(0, TEXT_SENT),
          origin: location.origin,
        };
        if (o.tag !== undefined && o.tag !== null && String(o.tag) !== '') payload.tag = String(o.tag).slice(0, TEXT_SENT);
        if (icon) payload.icon = icon.slice(0, ICON_SENT);
        const binding = g.__retakeNotification;
        if (typeof binding === 'function') (binding as (p: Reported) => unknown)(payload);
        else if ((g.__retakeNotifications ??= []).length < 50) g.__retakeNotifications.push(payload);
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
  const w = window as unknown as Window & { __retake?: KitApi };
  const prev = w.__retake;
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
  on(window, '__retake_ping', () => {
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
    // A frame that navigated or was removed keeps its old elements connected to a document without a window: gone.
    return el && el.isConnected && el.ownerDocument.defaultView ? el : null;
  }

  // ─────────────────────── per-call memo (L3.3) ───────────────────────
  // An inspection (`inventory`, `checkTargets`) runs many resolver lookups in one synchronous call: the DOM cannot change
  // during it, so the trees, selector queries, visibility, names, label pairs, texts and rows are computed once each.
  // Set only for the length of such a call (null otherwise: every other kit call sees the live DOM).
  interface Memo {
    trees: Map<Element, { list: Array<Element | ShadowRoot>; cross: number }>;
    qsa: Map<string, Map<Element, Element[]>>;
    vis: Map<Element, boolean>;
    names: Map<Element, string>;
    labels: Map<Element, Array<{ control: Element; text: string }>>;
    low: Map<Node, string>;
    rows: Map<string, Element | null>;
  }
  let memo: Memo | null = null;
  function withMemo<T>(fn: () => T): T {
    if (memo) return fn();
    memo = { trees: new Map(), qsa: new Map(), vis: new Map(), names: new Map(), labels: new Map(), low: new Map(), rows: new Map() };
    try {
      return fn();
    } finally {
      memo = null;
    }
  }

  // ─────────────────────── trees: open shadow roots and same-origin frames (R-ISS-07) ───────────────────────
  // This kit (the top one) searches, hit-tests, scrolls and clicks inside open shadow roots and same-origin frames
  // itself. Every coordinate crossing the kit boundary is in TOP-LEVEL viewport CSS px: an element in a frame is offset
  // by the frames' content-box positions. Elements of a frame belong to another realm: no `instanceof`, no bare
  // getComputedStyle, no top-realm constructors for them (isA, styleOf, winOf).
  type Tree = Element | ShadowRoot;
  const winOf = (n: Node): Window => (n.ownerDocument ?? (n as Document)).defaultView ?? window;
  const styleOf = (el: Element): CSSStyleDeclaration => winOf(el).getComputedStyle(el);
  /** Realm-safe `instanceof HTMLxxxElement`. */
  function isA<K extends keyof HTMLElementTagNameMap>(el: unknown, name: K): el is HTMLElementTagNameMap[K] {
    return !!el && (el as Node).nodeType === 1 && (el as Element).localName === name && (el as Element).namespaceURI === 'http://www.w3.org/1999/xhtml';
  }
  /** The document of a same-origin iframe/frame (null when cross-origin, sandboxed or not created yet). Never throws. */
  function frameDoc(el: Element): Document | null {
    if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
    try {
      const d = (el as HTMLIFrameElement).contentDocument;
      return d && d.documentElement ? d : null;
    } catch {
      return null;
    }
  }
  /** The frame element holding a (non-top) document. */
  function frameElOf(doc: Document): Element | null {
    if (doc === document) return null;
    try {
      return doc.defaultView?.frameElement ?? null;
    } catch {
      return null;
    }
  }
  /** The host of the node's shadow root, else the frame element of its document; null in the top document. */
  function outerOf(n: Node): Element | null {
    const root = n.getRootNode();
    if (root.nodeType === 11) return (root as ShadowRoot).host;
    return root.nodeType === 9 ? frameElOf(root as Document) : null;
  }
  /** Parent in the flat (rendered) tree within one document: a slotted element's slot, else its parent or host. */
  function flatParent(el: Element): Element | null {
    const slot = el.assignedSlot;
    if (slot) return slot;
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode;
    return p && p.nodeType === 11 ? (p as ShadowRoot).host : null;
  }
  /** Parent or shadow host (no slot hop): the composed DOM parent within one document. */
  function hostParent(el: Element): Element | null {
    if (el.parentElement) return el.parentElement;
    const p = el.parentNode;
    return p && p.nodeType === 11 ? (p as ShadowRoot).host : null;
  }
  /** Flat-tree parent, going out of a frame document to its frame element. */
  function upOf(el: Element): Element | null {
    return flatParent(el) ?? (el === el.ownerDocument.documentElement ? frameElOf(el.ownerDocument) : null);
  }
  /** `outer` holds `inner`, through shadow roots, slots and frames. */
  function deepContains(outer: Element, inner: Element | null): boolean {
    if (!inner) return false;
    if (outer.contains(inner)) return true;
    for (let n: Element | null = upOf(inner), i = 0; n && i < 4096; n = upOf(n), i++) if (n === outer) return true;
    return false;
  }
  /** `closest` along the flat tree, going out through shadow hosts, slots and frame elements. */
  function deepClosest(el: Element | null, sel: string): Element | null {
    for (let n = el, i = 0; n && i < 4096; n = upOf(n), i++) if (n.matches(sel)) return n;
    return null;
  }
  /**
   * The trees to search under `root`: the root itself, then every open shadow root and same-origin frame document
   * (its body) found inside, recursively. Closed shadow roots (the kit's own overlay included) are invisible; frames
   * that cannot be entered are counted (`cross`) for the not-found message.
   */
  function trees(root: Element): { list: Tree[]; cross: number } {
    const cached = memo?.trees.get(root);
    if (cached) return cached;
    const list: Tree[] = [root];
    let cross = 0;
    const scan = (scope: Tree, depth: number) => {
      const one = (el: Element) => {
        const sr = el.shadowRoot;
        if (sr && el !== host && depth < 16) {
          list.push(sr);
          scan(sr, depth + 1);
        }
        if (el.localName === 'iframe' || el.localName === 'frame') {
          const d = frameDoc(el);
          const b = d ? (d.body ?? d.documentElement) : null;
          if (b && depth < 16) {
            list.push(b);
            scan(b, depth + 1);
          } else if (!d) {
            const src = el.getAttribute('src') ?? '';
            if (src && !/^about:/i.test(src)) cross++;
          }
        }
      };
      if (scope.nodeType === 1) one(scope as Element);
      const all = scope.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) one(all[i]);
    };
    scan(root, 0);
    const out = { list, cross };
    memo?.trees.set(root, out);
    return out;
  }
  /** Anchors of an element from the top document down: [outermost host/frame, …, el]. */
  function anchors(el: Element): Element[] {
    const out = [el];
    for (let o = outerOf(el), i = 0; o && i < 64; o = outerOf(o), i++) out.unshift(o);
    return out;
  }
  /** Composed visual order: a host or frame precedes what it holds (its shadow content before its slotted content). */
  function deepCompare(a: Element, b: Element): number {
    if (a === b) return 0;
    if (a.getRootNode() !== b.getRootNode()) {
      const ca = anchors(a);
      const cb = anchors(b);
      let i = 0;
      while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
      if (i === ca.length) return -1;
      if (i === cb.length) return 1;
      a = ca[i];
      b = cb[i];
    }
    const pos = a.compareDocumentPosition(b);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
  }
  /** querySelectorAll in every tree under `root` (and `root` itself when `withRoot`), in composed order. */
  function deepQsa(root: Element | Document, sel: string, withRoot = false): Element[] {
    const start = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
    if (!start) return [];
    if (memo) {
      const key = `${withRoot ? '1' : '0'}${sel}`;
      let bySel = memo.qsa.get(key);
      if (!bySel) memo.qsa.set(key, (bySel = new Map()));
      let hit = bySel.get(start);
      if (!hit) bySel.set(start, (hit = deepQsaLive(start, sel, withRoot)));
      return hit.slice();
    }
    return deepQsaLive(start, sel, withRoot);
  }
  function deepQsaLive(start: Element, sel: string, withRoot: boolean): Element[] {
    const { list } = trees(start);
    const out: Element[] = withRoot && start.matches(sel) ? [start] : [];
    if (list.length === 1) {
      out.push(...Array.from(start.querySelectorAll(sel)));
      return out;
    }
    for (const t of list) {
      if (t !== start && t.nodeType === 1 && (t as Element).matches(sel)) out.push(t as Element);
      out.push(...Array.from(t.querySelectorAll(sel)));
    }
    return out.sort(deepCompare);
  }
  /** Position of a frame's content box in its own document's viewport. */
  function contentOffset(f: Element): { x: number; y: number } {
    const r = f.getBoundingClientRect();
    const cs = styleOf(f);
    return { x: r.left + f.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + f.clientTop + (parseFloat(cs.paddingTop) || 0) };
  }
  /** Offset of a node's document viewport in the top viewport (0 in the top document). */
  function frameOffset(n: Node): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let doc = n.ownerDocument ?? (n as Document);
    for (let i = 0; doc !== document && i < 16; i++) {
      const f = frameElOf(doc);
      if (!f) break;
      const o = contentOffset(f);
      x += o.x;
      y += o.y;
      doc = f.ownerDocument;
    }
    return { x, y };
  }
  interface Rect {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }
  /** getBoundingClientRect in top-level viewport px. */
  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    if (el.ownerDocument === document) return r;
    const o = frameOffset(el);
    return { left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.width, height: r.height };
  }
  /** elementFromPoint (top px) that pierces open shadow roots and same-origin frames: the innermost element. */
  function deepHit(x: number, y: number): Element | null {
    let hit = document.elementFromPoint(x, y);
    let lx = x;
    let ly = y;
    for (let i = 0; hit && i < 32; i++) {
      const sr = hit.shadowRoot;
      if (sr && hit !== host) {
        const inner = sr.elementFromPoint(lx, ly);
        // Inside the shadow tree, or a slotted light descendant of the host.
        if (inner && inner !== hit && (sr.contains(inner) || hit.contains(inner))) {
          hit = inner;
          continue;
        }
        break;
      }
      const d = frameDoc(hit);
      if (!d) break;
      const o = contentOffset(hit);
      const inner = d.elementFromPoint(lx - o.x, ly - o.y);
      if (!inner) break; // on the frame's border or padding
      lx -= o.x;
      ly -= o.y;
      hit = inner;
    }
    return hit;
  }
  /** The focused element, through open shadow roots and same-origin frames. */
  function deepActive(): Element | null {
    let el: Element | null = document.activeElement;
    for (let i = 0; el && i < 32; i++) {
      const inner = el.shadowRoot?.activeElement ?? frameDoc(el)?.activeElement ?? null;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ───────────────────────────── text helpers ─────────────────────────────
  const norm = (s: string | null | undefined): string =>
    (s ?? '').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  const lc = (s: string): string => s.toLowerCase();
  /** Lower-cased normalised textContent (memoised during an inspection). */
  function lowText(n: Node): string {
    if (!memo) return lc(norm(n.textContent));
    let v = memo.low.get(n);
    if (v === undefined) memo.low.set(n, (v = lc(norm(n.textContent))));
    return v;
  }
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'RETAKE-CURSOR']);
  const BUTTON_INPUT = 'input[type=button],input[type=submit],input[type=reset]';

  function textOf(el: Element): string {
    if (isA(el, 'input')) {
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
  /**
   * Keep the best non-empty tier (exact first, then case-insensitive, then substring). With `own` (items of the
   * searched document, not of a frame inside it), the tier is the best one of those items when there are any: an exact
   * match in a widget frame does not beat a partial one on the page (the frame's matches of that tier still count).
   */
  function bestTier<T>(items: T[], text: (t: T) => string, q: string, exactOnly: boolean, own?: (t: T) => boolean): T[] {
    const tiers: T[][] = [[], [], []];
    const mine = [false, false, false];
    const qn = norm(q);
    for (const it of items) {
      const t = tierOf(text(it), qn, exactOnly);
      if (t < 0) continue;
      tiers[t].push(it);
      if (own?.(it)) mine[t] = true;
    }
    const k = mine.includes(true) ? mine.indexOf(true) : tiers.findIndex((t) => t.length > 0);
    return k >= 0 ? tiers[k] : [];
  }

  // ───────────────────────────── visibility ─────────────────────────────
  function isScrollable(el: Element): boolean {
    const cs = styleOf(el);
    const oy = cs.overflowY;
    const ox = cs.overflowX;
    const sy = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    const sx = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && el.scrollWidth > el.clientWidth + 1;
    return sy || sx;
  }
  function clipsContent(el: Element): boolean {
    const cs = styleOf(el);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
  }
  function docScroller(): Element {
    return document.scrollingElement ?? document.documentElement;
  }
  function docScrollerOf(doc: Document): Element {
    return doc.scrollingElement ?? doc.documentElement;
  }

  function isVisible(el: Element): boolean {
    if (!memo) return isVisibleLive(el);
    let v = memo.vis.get(el);
    if (v === undefined) memo.vis.set(el, (v = isVisibleLive(el)));
    return v;
  }
  function isVisibleLive(el: Element): boolean {
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
      const cs = styleOf(el);
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0') return false;
    }
    // Outside the scrollable area of the document (e.g. left:-9999px).
    const win = winOf(el);
    const sx = win.scrollX;
    const sy = win.scrollY;
    if (r.right + sx <= 0 || r.bottom + sy <= 0) return false;
    // Clipped away by a non-scrolling overflow ancestor (carousels, collapsed panels).
    const doc = el.ownerDocument;
    for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
      if (!clipsContent(p)) continue;
      const cs = styleOf(p);
      const scrolls = /(auto|scroll|overlay)/.test(cs.overflowX + cs.overflowY);
      if (scrolls) continue;
      const pr = p.getBoundingClientRect();
      if (r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return false;
    }
    // In a frame: the frame element must be visible too.
    const f = frameElOf(doc);
    return !f || isVisible(f);
  }

  /** Product of the computed opacities of an element and its ancestors (animations included), frames included. */
  function effectiveOpacity(el: Element): number {
    let o = 1;
    for (let p: Element | null = el; p && o > 0; p = upOf(p)) o *= parseFloat(styleOf(p).opacity) || 0;
    return o;
  }

  /** Text of a node's own text children (text placed directly in a shadow root). */
  function directText(n: Node): string {
    return norm(
      Array.from(n.childNodes)
        .filter((c) => c.nodeType === 3)
        .map((c) => c.textContent)
        .join(' '),
    );
  }

  /**
   * Whether `text` is visible to a viewer: the innermost elements containing it must be visible and at least half
   * opaque. `innerText` alone also counts text that is laid out but still transparent (staggered reveals, fade-ins).
   * `body.innerText` leaves out open shadow roots and frames: each of them is searched the same way.
   */
  function textVisible(text: string): boolean {
    const needle = lc(norm(text));
    const body = document.body as HTMLElement | null;
    if (!needle) return true;
    if (!body) return false;
    const has = (el: Element) => lc(norm(el.textContent ?? '')).includes(needle);
    const seen = (el: Element) =>
      isVisible(el) && effectiveOpacity(el) >= 0.5 && lc(norm((el as HTMLElement).innerText ?? el.textContent ?? '')).includes(needle);
    const innermost = (from: Element): Element[] => {
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
      visit(from);
      return hits;
    };
    if (lc(norm(body.innerText ?? '')).includes(needle) && innermost(body).some(seen)) return true;
    for (const t of trees(body).list.slice(1)) {
      if (t.nodeType === 1) {
        // A frame's body.
        if (lc(norm((t as HTMLElement).innerText ?? '')).includes(needle) && innermost(t as Element).some(seen)) return true;
        continue;
      }
      const sr = t as ShadowRoot;
      if (!lc(norm(sr.textContent)).includes(needle)) continue;
      let deeper = false;
      for (const c of Array.from(sr.children)) {
        if (SKIP_TAGS.has(c.tagName) || !has(c)) continue;
        deeper = true;
        if (innermost(c).some(seen)) return true;
      }
      // Text placed directly in the shadow root: its host shows it.
      if (!deeper && lc(directText(sr)).includes(needle) && isVisible(sr.host) && effectiveOpacity(sr.host) >= 0.5) return true;
    }
    return false;
  }

  function bboxOf(el: Element): BBox {
    const r = rectOf(el);
    const rd = (n: number) => Math.round(n * 100) / 100;
    return { x: rd(r.left), y: rd(r.top), w: rd(r.width), h: rd(r.height) };
  }

  /** Visible part of an element (top px): rect ∩ viewport ∩ every clipping/scrolling ancestor ∩ its frames' parts. */
  function visibleRect(el: Element): { l: number; t: number; r: number; b: number } {
    const doc = el.ownerDocument;
    const win = winOf(el);
    const rc = el.getBoundingClientRect();
    let l = Math.max(rc.left, 0);
    let t = Math.max(rc.top, 0);
    let r = Math.min(rc.right, win.innerWidth);
    let b = Math.min(rc.bottom, win.innerHeight);
    for (let p = flatParent(el); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
      if (!clipsContent(p)) continue;
      const pr = p.getBoundingClientRect();
      l = Math.max(l, pr.left + p.clientLeft);
      t = Math.max(t, pr.top + p.clientTop);
      r = Math.min(r, pr.left + p.clientLeft + p.clientWidth);
      b = Math.min(b, pr.top + p.clientTop + p.clientHeight);
    }
    const f = frameElOf(doc);
    if (!f) return { l, t, r, b };
    // In a frame: into top px, clipped by the frame element's own visible part (top px too).
    const o = frameOffset(el);
    const fv = visibleRect(f);
    return { l: Math.max(l + o.x, fv.l), t: Math.max(t + o.y, fv.t), r: Math.min(r + o.x, fv.r), b: Math.min(b + o.y, fv.b) };
  }
  function inView(el: Element): boolean {
    const rc = el.getBoundingClientRect();
    const v = visibleRect(el);
    const vw = v.r - v.l;
    const vh = v.b - v.t;
    if (vw <= 0 || vh <= 0) return false;
    const win = winOf(el);
    const W = Math.min(window.innerWidth, win.innerWidth);
    const H = Math.min(window.innerHeight, win.innerHeight);
    return vw >= Math.min(rc.width, W * 0.8) - 1 && vh >= Math.min(rc.height, H * 0.8) - 1;
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
    const sel = sels.join(',');
    const out: Element[] = [];
    for (const el of deepQsa(root, sel, true)) if (hasRole(el, role)) out.push(el);
    return out;
  }
  /** The tree (document or shadow root) of a node: ids resolve there. */
  function treeOf(n: Node): Document | ShadowRoot {
    const r = n.getRootNode();
    return r.nodeType === 9 || r.nodeType === 11 ? (r as Document | ShadowRoot) : n.ownerDocument ?? document;
  }
  /** What a field holds (its value, its options, what was typed into it): never part of a name or a label. */
  const FIELD_CONTENT =
    'textarea,select,option,optgroup,datalist,script,style,template,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=listbox],[role=combobox]';
  /** Fields drawn without a form control whose content is a value: never their name. */
  const TYPED_SEL = '[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider]';
  /**
   * The text of a label or of an element `aria-labelledby` points at, as a name computation reads it: without the
   * content of a field inside it (a textarea's text, a select's options, an edited region) and without `self` (the
   * element named — `aria-labelledby` may include it).
   */
  function nameText(node: Element, self: Element | null = null): string {
    if (node === self || node.matches(FIELD_CONTENT)) return '';
    if (!(self && node.contains(self)) && !node.querySelector(FIELD_CONTENT)) return node.textContent ?? '';
    let out = '';
    for (const c of Array.from(node.childNodes)) {
      if (c.nodeType === 3) out += c.textContent ?? '';
      else if (c.nodeType === 1) out += nameText(c as Element, self);
    }
    return out;
  }
  function idsText(ids: string, from: Node = document, self: Element | null = null): string {
    const tree = treeOf(from);
    return norm(
      ids
        .split(/\s+/)
        .map((id) => {
          const ref = id ? tree.getElementById(id) : null;
          return ref ? nameText(ref, self) : '';
        })
        .join(' '),
    );
  }
  function accessibleName(el: Element): string {
    if (!memo) return accessibleNameLive(el);
    let v = memo.names.get(el);
    if (v === undefined) memo.names.set(el, (v = accessibleNameLive(el)));
    return v;
  }
  function accessibleNameLive(el: Element): string {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = idsText(lb, el, el);
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && norm(al)) return norm(al);
    if (isA(el, 'input') || isA(el, 'select') || isA(el, 'textarea')) {
      const labels = el.labels ? Array.from(el.labels).map((l) => norm(nameText(l, el))).filter(Boolean) : [];
      if (labels.length) return labels.join(' ');
      if (isA(el, 'input') && el.matches(BUTTON_INPUT)) return norm(el.value);
      const t = el.getAttribute('title') ?? el.getAttribute('placeholder');
      return norm(t);
    }
    if (isA(el, 'img')) return norm(el.alt);
    // A text field drawn with ARIA or contenteditable is not named by what it holds (that is its value).
    if (el.matches(TYPED_SEL)) return norm(el.getAttribute('title') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('placeholder'));
    // Named from its content: what a field inside it holds is not part of it (a label wrapping a textarea).
    const t = norm(nameText(el));
    if (t) return t;
    return norm(el.getAttribute('title'));
  }

  const INTERACTIVE =
    'button,a[href],input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=spinbutton],[role=slider],[role=treeitem],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
  function promote(el: Element, root: Element): Element {
    let cur: Element | null = el;
    for (let i = 0; cur && i <= 6; i++) {
      if (cur.matches(INTERACTIVE)) return cur;
      if (cur === root) break;
      // Out of a shadow root to its host, never out of a frame.
      cur = hostParent(cur);
    }
    return el;
  }
  function isInteractive(el: Element): boolean {
    return deepClosest(el, INTERACTIVE) !== null;
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
  function topDialog(preferAlert: boolean, skip?: (e: Element) => boolean): Element | null {
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
  function topPopover(): Element | null {
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
  const ROW_SEL = '[role=row],tr,[role=listitem],li';
  function rowFor(text: string): Element | null {
    if (!memo) return rowForLive(text);
    let v = memo.rows.get(text);
    if (v === undefined) memo.rows.set(text, (v = rowForLive(text)));
    return v;
  }
  function rowForLive(text: string): Element | null {
    const q = norm(text);
    const ql = lc(q);
    const rows = deepQsa(document, ROW_SEL).filter(
      (r) => lowText(r).includes(ql) && isVisible(r),
    );
    // Innermost rows only (a row containing a matching nested row is dropped).
    const inner = rows.filter((r) => !rows.some((o) => o !== r && r.contains(o)));
    if (inner.length) {
      const exactCell = inner.find((r) =>
        Array.from(r.querySelectorAll('*')).some((c) => c.children.length === 0 && lowText(c) === ql),
      );
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
  function resolveScope(s: ScopeSpec | undefined): Element | null {
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
  function labelTarget(lab: Element): Element | null {
    let control: Element | null = (lab as HTMLLabelElement).control;
    if (!control) {
      const f = lab.getAttribute('for');
      if (f) control = treeOf(lab).getElementById(f);
    }
    return control ?? lab.querySelector('input,select,textarea,button,[role=combobox],[role=textbox],[contenteditable]');
  }
  function labelPairs(root: Element): Array<{ control: Element; text: string }> {
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
  function cssEscape(s: string): string {
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
      let best = bestTier(pairs, (p) => p.text, t.label, exact, (p) => own(p.control)).map((p) => p.control);
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
  function find(t: TargetObject, opts: FindOptions = {}): ResolveResult {
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

  // ───────────────────────────── points & hit testing ─────────────────────────────
  function hitInside(el: Element, x: number, y: number): boolean {
    const hit = deepHit(x, y);
    if (!hit) return false;
    if (deepContains(el, hit)) return true;
    // A <label> forwarding to its control, or a control that sits inside a label we hit.
    return isA(hit, 'label') && hit.control === el;
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
  /**
   * The next scroll that brings `id` into view, innermost container first: the scrollable ancestors in the element's
   * document, then that document's scroller; then the same from its frame element in the parent document. The
   * container is '' only for the top document's scroller (a frame document's scroller is a ref).
   */
  function scrollPlan(id: string, margin: number, centre = false): ScrollOp | null {
    const el = deref(id);
    if (!el) return null;
    let from = el;
    let r: Rect = el.getBoundingClientRect();
    for (let layer = 0; layer < 16; layer++) {
      const doc = from.ownerDocument;
      const win = winOf(from);
      const scroller = docScrollerOf(doc);
      const containers: Element[] = [];
      for (let p = flatParent(from); p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
        if (isScrollable(p)) containers.push(p);
      }
      containers.push(scroller);
      for (const c of containers) {
        const isDoc = c === scroller;
        let vt: number;
        let vb: number;
        let vl: number;
        let vr: number;
        if (isDoc) {
          vt = 0;
          vb = win.innerHeight;
          vl = 0;
          vr = win.innerWidth;
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
        } else if (centre && r.height <= viewH - 2 * m) {
          // In view but covered (a sticky footer or header of the container): towards the middle of the container.
          dy = r.top + r.height / 2 - (vt + viewH * 0.42);
          if (Math.abs(dy) < 24) dy = 0;
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
          return { container: isDoc && doc === document ? '' : ref(c), top, left, from_top: fromTop, from_left: fromLeft };
        }
      }
      // In view in this document: bring its frame into view in the parent document.
      const f = frameElOf(doc);
      if (!f) return null;
      const o = contentOffset(f);
      r = { left: r.left + o.x, right: r.right + o.x, top: r.top + o.y, bottom: r.bottom + o.y, width: r.width, height: r.height };
      from = f;
    }
    return null;
  }
  function scrollContainerFor(id: string | null, fromParent = false): string {
    const el = deref(id);
    if (el) {
      // An <iframe> itself designates its document's scroller, when that scrolls.
      const fd = fromParent ? null : frameDoc(el);
      const fs = fd ? docScrollerOf(fd) : null;
      if (fs && (fs.scrollHeight > fs.clientHeight + 1 || fs.scrollWidth > fs.clientWidth + 1)) return ref(fs);
      let doc = el.ownerDocument;
      let from: Element | null = fromParent ? flatParent(el) : el;
      for (let layer = 0; layer < 16; layer++) {
        for (let p = from; p && p !== doc.body && p !== doc.documentElement; p = flatParent(p)) {
          if (isScrollable(p)) return ref(p);
        }
        if (doc === document) return '';
        // A frame's document scroller, else the containers around the frame.
        const se = docScrollerOf(doc);
        if (se.scrollHeight > se.clientHeight + 1) return ref(se);
        const f = frameElOf(doc);
        if (!f) return '';
        from = flatParent(f);
        doc = f.ownerDocument;
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
      const cs = styleOf(c);
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
      const tr = rectOf(t);
      // Top of the container's viewport in top px: its frame's position for a document scroller.
      const top = c === docScrollerOf(c.ownerDocument) ? frameOffset(c).y : rectOf(c).top + c.clientTop;
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
    RT.requestAnimationFrame(go);
    RT.setTimeout(go, 17);
  }
  function scrollAnimate(id: string, top: number, left: number, ms: number): Promise<{ top: number; left: number }> {
    const c = containerEl(id);
    if (!c) return Promise.reject(new Error('scroll container is gone'));
    const styleEl = (c === docScrollerOf(c.ownerDocument) ? c.ownerDocument.documentElement : c) as HTMLElement;
    const prev = styleEl.style.scrollBehavior;
    styleEl.style.scrollBehavior = 'auto';
    const fromTop = c.scrollTop;
    const fromLeft = c.scrollLeft;
    const t0 = RT.performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const u = ms <= 0 ? 1 : Math.min(1, (RT.performance.now() - t0) / ms);
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
    for (const el of deepQsa(document, POPUP_SEL)) {
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
    const hit = deepHit(x, y);
    if (!hit) return false;
    // A click inside a frame never reaches this document's outside-click handlers.
    if (hit.ownerDocument !== document || hit.localName === 'iframe' || hit.localName === 'frame') return false;
    if (isInteractive(hit)) return false;
    if (avoid.some((a) => deepContains(a, hit))) return false;
    if (deepClosest(hit, POPUP_SEL.replace(',[role=dialog],[role=alertdialog],dialog[open]', ''))) return false;
    return true;
  }
  /** Box of an element's text (a Range over its contents), top px; null when it has none. */
  function textBox(el: Element): BBox | null {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const o = frameOffset(el);
    return { x: Math.round(r.left + o.x), y: Math.round(r.top + o.y), w: Math.round(r.width), h: Math.round(r.height) };
  }
  function textRectCentre(el: Element): PointSpec | null {
    const b = textBox(el);
    return b ? { x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } : null;
  }
  function outsidePlan(near: PointSpec, avoidIds: number[]): OutsidePlan | null {
    const allPopups = deepQsa(document, POPUP_SEL);
    const popupEls = allPopups.filter((e) => {
      const id = popupIds.get(e);
      return id !== undefined && avoidIds.includes(id);
    });
    let dlg = topDialog(true);
    // A floating dialog being closed (a date popover with role=dialog) holds nothing: the dialog under it holds the
    // click, else a blank spot. Not when something else is being closed too (a listbox it opened, portaled out of it):
    // then it holds that pick and stays open.
    const closing = (e: Element) => popupEls.some((p) => p === e || deepContains(p, e));
    if (dlg && isFloating(dlg) && closing(dlg)) {
      const d = dlg;
      if (popupEls.every((p) => p === d || deepContains(p, d) || deepContains(d, p))) dlg = topDialog(true, (e) => e === d || closing(e));
    }
    const avoid = popupEls.filter((p) => p !== dlg && !(dlg && deepContains(p, dlg)));
    const keepFor = (x: number, y: number): number[] => {
      const hit = deepHit(x, y);
      if (!hit) return [];
      const ids: number[] = [];
      for (const el of allPopups) {
        const id = popupIds.get(el);
        if (id !== undefined && deepContains(el, hit)) ids.push(id);
      }
      return ids;
    };
    const plan = (kind: OutsidePlan['kind'], x: number, y: number, r?: string): OutsidePlan => ({ kind, x, y, ref: r, keep: keepFor(x, y) });
    if (dlg) {
      const lb = dlg.getAttribute('aria-labelledby');
      const byId = lb ? treeOf(dlg).getElementById(lb.split(/\s+/)[0]) : null;
      const title =
        (byId && dlg.contains(byId) ? byId : null) ??
        Array.from(dlg.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')).find((h) => isVisible(h)) ??
        null;
      if (title && isVisible(title)) {
        const c = textRectCentre(title) ?? pointFor(ref(title))!;
        if (c && blankAt(c.x, c.y, avoid)) return plan('dialog-title', c.x, c.y, ref(title));
        const tb = rectOf(title);
        for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
          const x = Math.round(tb.left + tb.width * fx);
          const y = Math.round(tb.top + tb.height / 2);
          if (blankAt(x, y, avoid)) return plan('dialog-title', x, y, ref(title));
        }
      }
      // Blank padding inside the dialog, top area first.
      const dr = rectOf(dlg);
      for (let fy = 0.04; fy <= 0.5; fy += 0.06) {
        for (let fx = 0.5; fx <= 0.96; fx += 0.08) {
          const x = Math.round(dr.left + dr.width * fx);
          const y = Math.round(dr.top + dr.height * fy);
          const hit = deepHit(x, y);
          if (hit && deepContains(dlg, hit) && blankAt(x, y, avoid)) return plan('blank', x, y);
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

  /** The drawn cursor at (x, y) overlaps one of `boxes` (with a `clear` margin). */
  function coversAny(x: number, y: number, boxes: BBox[] | undefined, clear = 14): boolean {
    if (!boxes || !boxes.length) return false;
    const c = cursorBox(x, y);
    return boxes.some((b) => c.r > b.x - clear && c.l < b.x + b.w + clear && c.b > b.y - clear && c.t < b.y + b.h + clear);
  }
  function restPoint(where: 'side' | 'centre' = 'side', avoid?: BBox[]): PointSpec {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cands: Array<[number, number]> =
      where === 'centre'
        ? [[0.5, 0.5], [0.5, 0.42], [0.44, 0.5], [0.56, 0.5], [0.5, 0.58], [0.42, 0.42], [0.58, 0.42], [0.42, 0.58], [0.58, 0.58]]
        : [[0.8, 0.5], [0.84, 0.44], [0.76, 0.58], [0.88, 0.52], [0.72, 0.46], [0.82, 0.66], [0.9, 0.36], [0.66, 0.62]];
    for (const [fx, fy] of cands) {
      const x = Math.round(W * fx);
      const y = Math.round(H * fy);
      if (coversAny(x, y, avoid)) continue;
      const hit = deepHit(x, y);
      if (!hit || isInteractive(hit)) continue;
      const cur = styleOf(hit).cursor;
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
  function restNear(box: BBox, at: { point?: PointSpec; ref?: string; avoid?: BBox[] } = {}): { x: number; y: number; side: string } {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const EDGE = 28;
    const CLEAR = 14;
    // A wide target is clicked at one point: rest next to that point, not next to the far corner of its box.
    const NEAR_SPAN = 80;
    const R0 = box.x + box.w;
    const B = box.y + box.h;
    const px = at.point ? Math.min(R0, Math.max(box.x, at.point.x)) : box.x + box.w / 2;
    const L = Math.max(box.x, px - NEAR_SPAN);
    const R = Math.min(R0, px + NEAR_SPAN);
    const cx = (L + R) / 2;
    const cy = box.y + box.h / 2;
    // Natural resting spots a hand would leave the pointer at: below-right first, then around the target.
    const cands: Array<[string, number, number]> = [
      ['below-right', R + 56, B + 44],
      ['right', R + 84, cy + 18],
      ['below', cx + 36, B + 64],
      ['below-left', L - 64, B + 44],
      ['above-right', R + 56, box.y - 72],
      ['above', cx + 36, box.y - 92],
      ['left', L - 96, cy + 18],
      ['above-left', L - 72, box.y - 72],
    ];
    // Inside the dialog that holds the target: never out on its backdrop (the arrow extends right and down).
    const at0 = at.ref ? deref(at.ref) : null;
    const host = at0 ? deepClosest(at0, '[role=dialog],[role=alertdialog],dialog,[aria-modal=true]') : null;
    const hr = host ? rectOf(host) : null;
    const inHost = (x: number, y: number) => !hr || (x >= hr.left + 12 && y >= hr.top + 12 && x <= hr.right - 12 - 20 && y <= hr.bottom - 12 - 28);
    const inside = (x: number, y: number) => x >= EDGE && y >= EDGE && x <= W - EDGE - 20 && y <= H - EDGE - 28;
    const covers = (x: number, y: number) => {
      const c = cursorBox(x, y);
      return (c.r > box.x - CLEAR && c.l < R0 + CLEAR && c.b > box.y - CLEAR && c.t < B + CLEAR) || coversAny(x, y, at.avoid, CLEAR);
    };
    const neutral = (x: number, y: number) => {
      const hit = deepHit(x, y);
      if (!hit) return true;
      if (isInteractive(hit) || deepClosest(hit, 'a[href],button,input,select,textarea,[role=button],[role=link]')) return false;
      const cur = styleOf(hit).cursor;
      return cur !== 'pointer' && cur !== 'text';
    };
    const ok = cands.filter(([, x, y]) => inside(x, y) && !covers(x, y)).map(([side, x, y]) => ({ side, x: Math.round(x), y: Math.round(y) }));
    const usual = ok.find((p) => inHost(p.x, p.y) && neutral(p.x, p.y));
    if (usual) return usual;
    // No usual spot is free (a form in a dialog: fields all around): look closer to the click point, below-right
    // first — the gap between two rows of fields, a label — before settling on something interactive.
    const DIRS: Array<[string, number]> = [['below-right', 0.25], ['below', 0.5], ['right', 0], ['below-left', 0.75], ['above-right', -0.25], ['above', -0.5], ['left', 1], ['above-left', -0.75]];
    for (const r of [40, 56, 72, 96, 128, 160]) {
      for (const [side, turn] of DIRS) {
        const x = Math.round(px + r * Math.cos(turn * Math.PI));
        const y = Math.round(cy + r * Math.sin(turn * Math.PI));
        if (inside(x, y) && !covers(x, y) && inHost(x, y) && neutral(x, y)) return { side: `near-${side}`, x, y };
      }
    }
    const best = ok.find((p) => inHost(p.x, p.y)) ?? ok.find((p) => neutral(p.x, p.y)) ?? ok[0];
    if (best) return best;
    return { ...restPoint('side', at.avoid), side: 'fallback' };
  }

  // ───────────────────────────── changes (parking, R-CHO-21) ─────────────────────────────
  // What changed on the page since an action started: elements added, removed from, re-texted or restyled (top
  // document; the cursor overlay ignored). Boxes are measured when asked; one over 40 % of the viewport (a page, an
  // opened dialog) is not a "changed area" the cursor could stay clear of.
  let watch: { obs: MutationObserver; els: Set<Element>; take: (list: MutationRecord[]) => void } | null = null;
  const WATCH_ATTRS = ['class', 'style', 'hidden', 'open', 'disabled', 'value', 'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed', 'data-state'];
  cleanups.push(() => watch?.obs.disconnect());
  function watchChanges(): void {
    watch?.obs.disconnect();
    const els = new Set<Element>();
    // The 500 most recent elements: a change after a large re-render (a toast after a table) still counts.
    const add = (n: Node | null) => {
      const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
      if (!el || el === host) return;
      els.delete(el);
      els.add(el);
      if (els.size > 500) els.delete(els.values().next().value as Element);
    };
    const take = (list: MutationRecord[]) => {
      for (const m of list) {
        if (m.type === 'childList') {
          m.addedNodes.forEach(add);
          if (m.removedNodes.length) add(m.target);
        } else {
          add(m.target);
        }
      }
    };
    const obs = new MutationObserver(take);
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: WATCH_ATTRS });
    watch = { obs, els, take };
  }
  function changedBoxes(): { watching: boolean; boxes: BBox[] } {
    if (!watch) return { watching: false, boxes: [] };
    watch.take(watch.obs.takeRecords());
    const W = window.innerWidth;
    const H = window.innerHeight;
    const rects: Array<{ l: number; t: number; r: number; b: number }> = [];
    for (const el of watch.els) {
      if (!el.isConnected || el === host || el === document.body || el === document.documentElement) continue;
      const rc = el.getBoundingClientRect();
      const l = Math.max(0, rc.left);
      const t = Math.max(0, rc.top);
      const r = Math.min(W, rc.right);
      const b = Math.min(H, rc.bottom);
      if (r - l < 1 || b - t < 1 || (r - l) * (b - t) > 0.4 * W * H || !isVisible(el)) continue;
      rects.push({ l, t, r, b });
    }
    // Merge overlapping boxes; keep the 12 largest.
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = 0; i < rects.length && !merged; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const c = rects[j];
          if (a.l <= c.r && c.l <= a.r && a.t <= c.b && c.t <= a.b) {
            rects[i] = { l: Math.min(a.l, c.l), t: Math.min(a.t, c.t), r: Math.max(a.r, c.r), b: Math.max(a.b, c.b) };
            rects.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    rects.sort((a, c) => (c.r - c.l) * (c.b - c.t) - (a.r - a.l) * (a.b - a.t));
    return {
      watching: true,
      boxes: rects.slice(0, 12).map((x) => ({ x: Math.round(x.l), y: Math.round(x.t), w: Math.round(x.r - x.l), h: Math.round(x.b - x.t) })),
    };
  }

  // ───────────────────────────── widgets ─────────────────────────────
  const TRIGGER_NAME = /\b(actions?|more|menu|options|manage|settings|row actions)\b|…|⋯|⋮|•••|\.\.\./i;
  /**
   * The menu trigger of a row (R-CHO-13): an [aria-haspopup] element (a menu-like name first, else the last one), a
   * button with a menu-like name, else the row's last button. When that last button is laid out but hidden (opacity or
   * visibility: actions shown on hover) and the row was not hovered yet, `hover` asks the runner to hover the row and
   * ask again (`hovered`), instead of taking a visible button of an earlier cell.
   */
  function menuTrigger(rowId: string, hovered = false): { ref: string | null; hover: boolean } {
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
  const CELL_SEL = 'td,th,[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]';
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
  function positionalTrigger(rowId: string): { ref: string; where: string } | null {
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
  function fieldTriggerEl(label: string, root: Element): Element | null {
    const q = norm(label);
    const labels = deepQsa(root, 'label,legend,[id],div,span,p,dt,th').filter(
      (e) => e.children.length <= 3 && tierOf(norm(nameText(e)), q, false) >= 0 && isVisible(e),
    );
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
  const CANCEL = /^(cancel|close|dismiss|back|no|not now|keep|annuler|fermer|non|abbrechen|cancelar|annulla)$/i;
  function confirmButton(text: string | null): string | null {
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
  function fileInputFor(id: string): string | null {
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
  function selectNative(id: string, option: string): { ok: boolean; label?: string; options: string[] } {
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
  function textField(el: Element): boolean {
    if (isA(el, 'textarea')) return true;
    if (isA(el, 'input')) {
      return ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type);
    }
    return (el as HTMLElement).isContentEditable === true;
  }
  function isTextInput(id: string | null): boolean {
    const el = id ? deref(id) : deepActive();
    return !!el && textField(el);
  }
  /** Words of a field's name, id, placeholder, label or title that make it a search field (camelCase / snake_case split). */
  const SEARCH_WORDS = /\b(search|filter|find|look ?up|recherche[r]?|filtrer|such(e|en)|buscar|cerca)\b/i;
  /** The body of a document edited in place (contenteditable or designMode: the rich-text editors drawn in a frame). */
  function editableBody(el: Element): boolean {
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
  function fieldState(id: string | null): FieldState | null {
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
  function clearField(id: string | null): 'setter' | 'editor' | null {
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
  function calendar(): CalendarInfo | null {
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
  function setNativeValue(id: string, value: string): boolean {
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
  function domClick(id: string, x: number, y: number): void {
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
  function pointerSequence(id: string, x: number, y: number): void {
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

  const host = document.createElement('retake-cursor');
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
  /** Report what the cursor shows (icon, press, ripple) to the runner (binding `__retakeCursor`), never failing. */
  function effect(type: 'icon' | 'press' | 'release' | 'ripple', extra: { icon?: CursorKind; x?: number; y?: number } = {}): void {
    try {
      const b = (window as unknown as Record<string, unknown>).__retakeCursor;
      if (typeof b !== 'function') return;
      const r = (b as (p: unknown) => unknown)({ type, time: RT.Date.now(), ...extra }) as { catch?: (f: () => void) => void } | undefined;
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
  /**
   * A new document draws its cursor only once the page painted content of its own (R-ISS-08): the cursor's SVG would
   * otherwise be the document's first contentful paint — a cursor restored from sessionStorage drawn on an empty page
   * ends Chromium's paint holding and the recorder's hold of the load, and the empty page is filmed. The runner reveals
   * it after a load it waited for (`cursor.reveal`); a page that never paints content (no text, image or SVG) nobody
   * waits for shows it REVEAL_FALLBACK_MS after its load (the recorder's longest hold: an app's empty shell may wait
   * that long for its data). Only the drawing waits: the cursor's state is unchanged.
   */
  let revealed = true;
  const REVEAL_FALLBACK_MS = 10_000;

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
    cursorEl.classList.toggle('on', on && revealed);
    cursorEl.style.transform = `translate3d(${state.x}px,${state.y}px,0)`;
    cursorEl.dataset.k = state.kind;
    if (ghostEl && ghostOn) ghostEl.style.transform = `translate3d(${state.x - 30}px,${state.y - 22}px,0) rotate(-3deg)`;
  }
  function reveal(): void {
    if (revealed || disposed) return;
    revealed = true;
    render();
  }
  /** Hide the cursor until the document's first contentful paint (see `revealed`), when it has not happened yet. */
  function awaitFirstPaint(): void {
    try {
      if (RT.performance.getEntriesByName('first-contentful-paint').length > 0) return;
      const po = new PerformanceObserver((list) => {
        if (list.getEntriesByName('first-contentful-paint').length === 0) return;
        po.disconnect();
        reveal();
      });
      po.observe({ type: 'paint', buffered: true });
      cleanups.push(() => po.disconnect());
    } catch {
      return; // no paint timing: draw at once
    }
    revealed = false;
    const fallback = () => {
      const t = RT.setTimeout(reveal, REVEAL_FALLBACK_MS);
      cleanups.push(() => RT.clearTimeout(t));
    };
    if (document.readyState === 'complete') fallback();
    else on(window, 'load', fallback);
  }
  let lastSave = 0;
  function save(force = false): void {
    const now = RT.Date.now();
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
    // The innermost element under the pointer, through open shadow roots and same-origin frames.
    const el = deepHit(state.x, state.y);
    if (!el) return 'arrow';
    const cur = styleOf(el).cursor;
    if (cur === 'pointer') return 'hand';
    if (cur === 'text' || cur === 'vertical-text') return 'ibeam';
    if (cur === 'auto') {
      const ed = deepClosest(el, 'input,textarea,[contenteditable=""],[contenteditable=true]');
      if (isA(ed, 'input')) {
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
    const now = RT.performance.now();
    if (!force && now - lastKind < 50) {
      // Throttled: make sure the icon is re-evaluated once the pointer settles.
      kindTimer ??= RT.setTimeout(() => {
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
    RT.setTimeout(kill, 800);
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
    reveal,
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
      RT.setTimeout(() => {
        if (!el.classList.contains('on')) {
          ghostOn = false;
          el.innerHTML = '';
        }
      }, 300);
    },
  };

  if (config.passive) {
    // The recorder's copy (L3.4): in an isolated world, it draws nothing, patches nothing and listens to nothing.
  } else if (isTop) {
    buildOverlay();
    awaitFirstPaint();
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
      const now = RT.performance.now();
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
    const timer = RT.setInterval(() => {
      if (state.visible) updateKind(true);
    }, 250);
    cleanups.push(() => RT.clearInterval(timer));

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
        window.parent.postMessage({ __retakePtr: 1, type, x: m.clientX, y: m.clientY }, '*');
      } catch {
        /* detached */
      }
    };
    on(window, 'pointermove', fwd('move'));
    on(window, 'pointerdown', fwd('down'));
    on(window, 'pointerup', fwd('up'));
  }
  // The frame element a forwarding window lives in (also inside open shadow roots), cached per source window.
  const frameFor = new WeakMap<object, Element>();
  function sourceFrame(src: MessageEventSource | null): Element | null {
    if (!src) return null;
    const known = frameFor.get(src);
    if (known && known.isConnected && (known as HTMLIFrameElement).contentWindow === src) return known;
    const isSrc = (f: Element) => (f as HTMLIFrameElement).contentWindow === src;
    const f = Array.from(document.querySelectorAll('iframe,frame')).find(isSrc) ?? deepQsa(document, 'iframe,frame').find(isSrc) ?? null;
    if (f) frameFor.set(src, f);
    return f;
  }
  if (!config.passive) on(window, 'message', (ev: Event) => {
    const e = ev as MessageEvent;
    const d = e.data as { __retakePtr?: number; type?: string; x?: number; y?: number } | null;
    if (!d || d.__retakePtr !== 1 || typeof d.x !== 'number' || typeof d.y !== 'number') return;
    const frame = sourceFrame(e.source);
    if (!frame) return;
    const o = contentOffset(frame);
    const x = d.x + o.x;
    const y = d.y + o.y;
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

  // ───────────────────────────── inspection (L3.3) ─────────────────────────────
  // `inventory` lists the visible interactive elements with one suggested target each. Candidates come from a ladder
  // (text, role + name, then the same scoped `in` dialog / menu / listbox / popover / row, testid, aria, css for a stable
  // id; fields: label, placeholder, role + name first); counts from in-memory indexes skip the obviously ambiguous ones,
  // and every suggestion kept was verified once with `find` itself: it resolves to this element with count 1 (or with
  // its `nth`). All of it inside one synchronous call with the per-call memo, under a time budget.
  const KNOWN_ROLES = new Set([
    ...Object.keys(IMPLICIT),
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'treeitem', 'gridcell', 'menu', 'tooltip', 'tabpanel',
  ]);
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
  /** Alternatives (L4.8): extra verifications per element, the default time budget, and the suggestion time (ms) and the
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
      if (c.children.length > 0 || SKIP_TAGS.has(c.tagName) || (skip && skip.contains(c))) continue;
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

  function inventory(opts: InventoryOptions = {}): KitInventory {
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
    const headings: KitInventory['headings'] = [];
    for (const h of deepQsa(body, 'h1,h2,h3,[role=heading]')) {
      if (headings.length >= 20) break;
      if (!isVisible(h) || (scope && !deepContains(scope, h))) continue;
      const lvl = /^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level')) || 2;
      if (lvl > 3) continue;
      const text = short(accessibleName(h), 120);
      if (text) headings.push({ level: lvl, text });
    }
    const popups: InventoryPopup[] = [];
    for (const el of deepQsa(document, POPUP_SEL)) {
      if (el === host || (el.hasAttribute('popover') && !isPopoverOpen(el)) || !isVisible(el)) continue;
      const role = explicitRole(el);
      const kind: InventoryPopup['kind'] =
        role === 'dialog' || role === 'alertdialog' || role === 'menu' || role === 'listbox'
          ? role
          : el.tagName === 'DIALOG'
            ? 'dialog'
            : el.hasAttribute('popover')
              ? 'popover'
              : 'other';
      popups.push({ kind, bbox: bboxOf(el), name: short(norm(el.getAttribute('aria-label')) || (el.getAttribute('aria-labelledby') ? idsText(el.getAttribute('aria-labelledby') ?? '', el) : ''), 80) });
    }
    const scrollers: InventoryScroller[] = [];
    const se = docScroller();
    if (se.scrollHeight > se.clientHeight + 1) {
      scrollers.push({ document: true, bbox: { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, scroll_top: Math.round(se.scrollTop), scroll_height: se.scrollHeight, client_height: se.clientHeight });
    }
    for (const c of deepQsa(scope ?? body, '*')) {
      if (scrollers.length >= 10) break;
      if (c === host || c.scrollHeight <= c.clientHeight + 1 || c.clientHeight < 60 || c.clientWidth < 100) continue;
      if (!isScrollable(c) || !isVisible(c)) continue;
      scrollers.push({ document: false, bbox: bboxOf(c), scroll_top: Math.round(c.scrollTop), scroll_height: c.scrollHeight, client_height: c.clientHeight });
    }
    const base = {
      origin: location.origin,
      title: short(norm(document.title), 120),
      headings,
      popups,
      scrollers,
    };
    if (!scope) return { ...base, elements: [], within_found: false, counts, partial: false, ms: Math.round(RT.performance.now() - t0) };

    // The universe: every visible interactive element of the page (indexes count over it), labels merged into a
    // visible control, an interactive element inside a button / link / option dropped (part of it).
    const raw = deepQsa(body, INTERACTIVE, true).filter((e) => e !== host && isVisible(e));
    const rawSet = new Set(raw);
    const universe = raw.filter((e) => {
      if (isA(e, 'label')) {
        const c = labelTarget(e);
        if (c && rawSet.has(c)) return false;
      }
      for (let p = hostParent(e), i = 0; p && i < 6; p = hostParent(p), i++) if (rawSet.has(p) && p.matches(CONTAINER_SEL)) return false;
      return true;
    });
    const labelOf = new Map<Element, string>();
    for (const p of labelPairs(body)) if (p.text && !labelOf.has(p.control)) labelOf.set(p.control, p.text);
    for (const e of universe) {
      if (isA(e, 'label') && !labelOf.has(e)) {
        const t = norm(nameText(e));
        if (t) labelOf.set(e, t);
      }
    }
    const isField = (e: Element) => e.matches(FIELD_SEL);
    /** A field, or a value drawn with ARIA (a spin button, a slider): what it shows is a value. */
    const holdsValue = (e: Element) => isField(e) || e.matches('[role=spinbutton],[role=slider]');
    /** Text an element shows (never a field's content, nor that of a field inside a label). */
    const ownText = (e: Element) => (isA(e, 'label') ? norm(nameText(e)) : textOf(e));
    const shown = (e: Element) => (holdsValue(e) ? '' : ownText(e));
    const nameOf = (e: Element) => {
      const n = accessibleName(e);
      // A contenteditable without a label is named by its content: a field value, never reported.
      return holdsValue(e) && !isA(e, 'input') && !isA(e, 'select') && !isA(e, 'textarea') && n === textOf(e) ? '' : n;
    };
    // Indexes: lower-cased key → elements of the universe carrying it.
    type Index = Map<string, number>;
    const idx: Record<'text' | 'name' | 'rn' | 'role' | 'label' | 'placeholder' | 'aria' | 'testid' | 'id', Index> = {
      text: new Map(), name: new Map(), rn: new Map(), role: new Map(), label: new Map(), placeholder: new Map(), aria: new Map(), testid: new Map(), id: new Map(),
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
    /** Another key of the index contains this one (a broader text tier would match if this one went away). */
    const broader = (m: Index, q: string) => {
      const ql = lc(q);
      for (const k of m.keys()) if (k !== ql && k.includes(ql)) return true;
      return false;
    };
    const listedAll = universe.filter((e) => scope === body || scope === e || deepContains(scope, e));
    counts.interactive = listedAll.length;

    const menuEl = lastVisible(deepQsa(document, '[role=menu]'));
    const listEl = lastVisible(deepQsa(document, '[role=listbox]'));
    const dlg = topDialog(false);
    const pop = topPopover();
    const top = pop ?? dlg;
    const contextOf = (e: Element): { ctx: InventoryContext; row: Element | null } => {
      if (menuEl && deepContains(menuEl, e)) return { ctx: 'menu', row: null };
      if (listEl && deepContains(listEl, e)) return { ctx: 'listbox', row: null };
      if (dlg && deepContains(dlg, e)) return { ctx: 'dialog', row: null };
      if (pop && deepContains(pop, e)) return { ctx: 'popover', row: null };
      const row = e.matches(ROW_SEL) ? null : rowOf(e);
      return row ? { ctx: 'row', row } : { ctx: 'page', row: null };
    };
    // Order: the top popup layer first, then what is in view, then the rest (document order within each group).
    const views = new Map<Element, boolean>();
    for (const e of listedAll) views.set(e, inView(e));
    const group = (e: Element) => (top && deepContains(top, e) ? 0 : views.get(e) ? 1 : 2);
    const ordered = listedAll.map((e, i) => ({ e, i, g: group(e) })).sort((a, b) => a.g - b.g || a.i - b.i).map((x) => x.e);
    counts.in_view = listedAll.filter((e) => views.get(e)).length;
    const listed = ordered.slice(0, limit);
    counts.listed = listed.length;

    const verify = (t: TargetObject, el: Element): number => {
      counts.verifications++;
      let r: ResolveResult;
      try {
        r = find(t, {});
      } catch {
        return -1;
      }
      if (r.count === 0 || !('ref' in r) || deref(r.ref) !== el) return -1;
      if (t.nth === undefined && !t.last_visible && r.count !== 1) return -1;
      return r.count;
    };
    const rowKeyOf = (row: Element, el: Element): string | null => {
      for (const k of leafTexts(row, 6, el)) if (k.length >= 2 && rowFor(k) === row) return k;
      return null;
    };
    const elements: InventoryElement[] = [];
    let partial = false;
    for (const el of listed) {
      const role = roleOf(el);
      const known = role !== null && KNOWN_ROLES.has(role) ? role : null;
      const name = nameOf(el);
      const field = isField(el);
      const valued = holdsValue(el);
      const label = labelOf.get(el) ?? null;
      const ph = norm(el.getAttribute('placeholder')) || null;
      const testid = el.getAttribute('data-testid');
      const ariaLabel = norm(el.getAttribute('aria-label')) || null;
      const { ctx, row } = contextOf(el);
      const fits = (s: string | null): s is string => !!s && s.length <= SUGGEST_MAX;
      let suggested: KitSuggestion | null = null;
      let alternatives: KitSuggestion[] | undefined;
      let alternativesPartial = false;
      let rowKey: string | null = null;
      if (RT.performance.now() - t0 > budget) partial = true;
      else {
        // `noisy` (L4.8 review): a text an alternative never offers — mostly digits (a price, a count, a date) or pieces run
        // together without a space ("5 kg€36.40 / kg"). The suggestion ignores the flag.
        const plain: Array<{ t: TargetObject; m: Index | null; k: string; noisy?: boolean }> = [];
        const numeric = (t: string) => (t.match(/\p{N}/gu)?.length ?? 0) >= (t.match(/\p{L}/gu)?.length ?? 0);
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
        // A name of symbols only ("↻"): after testid, aria and a stable id.
        const symbolic = known && fits(name) && !WORDY.test(name) ? [{ t: { role: known, name } as TargetObject, m: idx.rn, k: `${role}\n${lc(name)}` }] : [];
        let scopeSpec: ScopeSpec | null = null;
        if (ctx === 'row' && row) {
          rowKey = rowKeyOf(row, el);
          if (rowKey) scopeSpec = { row: rowKey };
        } else if (ctx !== 'page' && ctx !== 'row') scopeSpec = ctx;
        const ladder: Array<{ t: TargetObject; m: Index | null; k: string; noisy?: boolean }> = [
          ...plain,
          ...(scopeSpec ? plain.map((c) => ({ t: { ...c.t, in: scopeSpec } as TargetObject, m: null, k: '', noisy: c.noisy })) : []),
          ...(testid ? [{ t: { testid }, m: idx.testid, k: testid }] : []),
          ...(fits(ariaLabel) ? [{ t: { aria: ariaLabel }, m: idx.aria, k: lc(ariaLabel) }] : []),
          ...(el.id && !GENERATED_ID.test(el.id) ? [{ t: { css: `#${cssEscape(el.id)}` }, m: idx.id, k: el.id }] : []),
          ...symbolic,
          ...(scopeSpec ? symbolic.map((c) => ({ t: { ...c.t, in: scopeSpec } as TargetObject, m: null, k: '' })) : []),
        ];
        let tries = 0;
        let at = -1;
        // The budget is checked before each lookup too: on a page of many identical elements one lookup is long.
        const spent = () => {
          if (RT.performance.now() - t0 > budget) partial = true;
          return partial;
        };
        for (const [k, c] of ladder.entries()) {
          // The index knows another element with the same key: `find` would see at least as many.
          if (c.m && (c.m.get(c.k) ?? 0) > 1) continue;
          if (tries++ >= VERIFY_MAX || spent()) break;
          if (verify(c.t, el) === 1) {
            suggested = { target: c.t, matches: 1, fragile: [] };
            at = k;
            break;
          }
        }
        if (!suggested && !spent()) {
          // No unique target: the most specific candidate with the element's position among its matches.
          // An unscoped candidate shared by more than NTH_MAX elements is not offered with an `nth` (a poor target, and
          // one lookup over them all can outlast the whole budget).
          const fewEnough = (c: { m: Index | null; k: string }) => !c.m || (c.m.get(c.k) ?? 0) <= NTH_MAX;
          const bases: TargetObject[] = [
            ...(scopeSpec ? plain.map((c) => ({ ...c.t, in: scopeSpec }) as TargetObject) : []),
            ...plain.filter(fewEnough).map((c) => c.t),
            ...(known && (scopeSpec || (idx.role.get(known) ?? 0) <= NTH_MAX) ? [scopeSpec ? ({ role: known, in: scopeSpec } as TargetObject) : { role: known }] : []),
          ];
          for (const b of bases.slice(0, 3)) {
            if (spent()) break;
            const root = resolveScope(b.in);
            if (!root) continue;
            let m: Matched;
            try {
              m = match(b, root, {});
            } catch {
              continue;
            }
            const i = m.visible.indexOf(el);
            if (i < 0 || spent()) continue;
            const t = { ...b, nth: i };
            const n = verify(t, el);
            if (n > 0) {
              suggested = { target: t, matches: n, fragile: ['nth'] };
              counts.ambiguous++;
              break;
            }
          }
        }
        const flag = (t: TargetObject, fragile: FragileFlag[]): FragileFlag[] => {
          const q = t.text ?? t.name ?? t.label ?? t.placeholder ?? t.aria;
          const kindIdx = t.text !== undefined ? idx.text : t.name !== undefined ? idx.name : t.label !== undefined ? idx.label : t.placeholder !== undefined ? idx.placeholder : t.aria !== undefined ? idx.aria : null;
          if (t.css !== undefined) fragile.push('css');
          const rk = t.in && typeof t.in === 'object' && 'row' in t.in ? (t.in as { row: string }).row : '';
          if ((q && /\d/.test(q)) || /\d/.test(rk)) fragile.push('dynamic_text');
          if (q && kindIdx && broader(kindIdx, q)) fragile.push('broader');
          return fragile;
        };
        if (suggested) flag(suggested.target, suggested.fragile);
        // Alternatives (the recorder, L4.8): the rest of the ladder past the suggestion, inside a press — so a small
        // budget of their own, none on a large page or after a slow suggestion. Never positional, never a key the
        // indexes know is shared, each verified to resolve once to this very element.
        const want = Math.max(0, Math.min(3, Math.floor(opts.alternatives ?? 0)));
        if (want > 0 && suggested && at >= 0) {
          alternatives = [];
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
              if (verify(c.t, el) === 1) alternatives.push({ target: c.t, matches: 1, fragile: flag(c.t, []) });
            }
          }
        }
      }
      // The action: through the helper the runner's action uses, else the target's own verification.
      let action: KitActionHint = { kind: field ? 'type' : 'click', verified: suggested !== null };
      const fileInput = isA(el, 'input') && el.type === 'file' ? el : el.querySelector('input[type=file]') ?? (isA(el, 'label') ? labelTarget(el) : null);
      if (fileInput && isA(fileInput, 'input') && fileInput.type === 'file') {
        action = { kind: 'drop_file', verified: suggested !== null && fileInputFor(ref(el)) !== null };
      } else if (isA(el, 'select') || role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') {
        action = fits(label) && !partial && verify({ label }, el) === 1 ? { kind: 'select', field: label, verified: true } : { kind: 'select', verified: suggested !== null };
      } else if (row && !field && (/^(menu|true)$/.test(el.getAttribute('aria-haspopup') ?? '') || TRIGGER_NAME.test(`${ariaLabel ?? ''} ${el.getAttribute('title') ?? ''} ${textOf(el)}`))) {
        const key = rowKey ?? (RT.performance.now() - t0 > budget ? null : rowKeyOf(row, el));
        const trig = key ? menuTrigger(ref(row)) : null;
        if (key && trig?.ref && deref(trig.ref) === el) action = { kind: 'menu', row: key, verified: true };
      }
      if (suggested) counts.suggested++;
      else counts.unsuggested++;
      elements.push({
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
      });
    }
    return { ...base, elements, within_found: true, counts, partial, ms: Math.round(RT.performance.now() - t0) };
  }
  // ───────────────────────────── recorder (L3.4) ─────────────────────────────
  /**
   * The inventory's entry for the interactive element a person acted on (`target`: the event's element, or a ref): the
   * element itself when it is interactive, else its nearest interactive ancestor — a label's control first, a hidden
   * file input's label or zone. Null when nothing interactive holds it. One `inventory({within, limit: 1})` per try
   * (at most 4), each with the per-call memo and the time budget (default 150 ms).
   */
  function suggestFor(target: Element | string, opts: { budget_ms?: number; alternatives?: number; alternatives_budget_ms?: number } = {}): InventoryElement | null {
    const el = typeof target === 'string' ? deref(target) : target;
    if (!el || !el.isConnected) return null;
    const tries: Element[] = [];
    const add = (e: Element | null) => {
      if (e && !tries.includes(e)) tries.push(e);
    };
    if (isA(el, 'label')) add(labelTarget(el));
    if (isA(el, 'input') && el.type === 'file' && !isVisible(el)) {
      add(el.closest('label'));
      if (el.id) add(treeOf(el).querySelector(`label[for="${cssEscape(el.id)}"]`));
    }
    for (let n: Element | null = deepClosest(el, INTERACTIVE), i = 0; n && i < 4; n = deepClosest(upOf(n), INTERACTIVE), i++) add(n);
    const budget = Math.max(20, opts.budget_ms ?? 150);
    const t0 = RT.performance.now();
    for (const c of tries.slice(0, 4)) {
      const left = budget - (RT.performance.now() - t0);
      if (left <= 0) break;
      const inv = inventory({
        within: ref(c),
        limit: 1,
        budget_ms: Math.max(20, left),
        ...(opts.alternatives ? { alternatives: opts.alternatives, alternatives_budget_ms: opts.alternatives_budget_ms } : {}),
      });
      if (inv.elements[0]) return inv.elements[0];
    }
    return null;
  }
  /** Words of a field that make it a secret one (camelCase / snake_case split first), and the kind each names. */
  const SECRET_WORDS: Array<[RegExp, SecretFieldKind]> = [
    [/\b(one ?time|otp|totp|2fa|mfa|verification code)\b/, 'one_time_code'],
    [/\b(cvc|cvv|csc|cvc2|cvv2|security code|card code)\b/, 'card_code'],
    [/\b(card ?number|cc ?number|cc ?num|credit ?card|pan)\b/, 'card_number'],
    [/\biban\b/, 'iban'],
    [/\b(ssn|social security|national id|tax id)\b/, 'national_id'],
    [/pass ?(word|code|phrase)|\bpasswd\b|\bpwd\b/, 'password'],
    [/\bpin\b/, 'pin'],
    [/\b(api ?key|access ?key|secret ?key|private ?key|client ?secret)\b|\btoken\b/, 'api_key'],
    [/\bsecret\b/, 'secret'],
  ];
  /**
   * The kind of secret a field holds (null: not a secret-class field): a password input; autocomplete current- /
   * new-password, one-time-code, cc-*; a name, id, label, aria-label, placeholder, title or test id naming a password,
   * code, card number, CVC, IBAN, PIN, token or key; one of ≥ 4 adjacent one-character inputs (one-time-code boxes).
   * Never reads a value.
   */
  function secretKind(el: Element): SecretFieldKind | null {
    const input = isA(el, 'input') ? el : null;
    if (input) {
      if (!['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(input.type)) return null;
    } else if (!isA(el, 'textarea') && (el as HTMLElement).isContentEditable !== true && !el.matches('[role=textbox],[role=searchbox]')) return null;
    const ac = lc(el.getAttribute('autocomplete') ?? '');
    if (/\bone-time-code\b/.test(ac)) return 'one_time_code';
    if (input?.type === 'password' || /\b(current|new)-password\b/.test(ac)) return 'password';
    if (/\bcc-number\b/.test(ac)) return 'card_number';
    if (/\bcc-csc\b/.test(ac)) return 'card_code';
    if (/\bcc-exp/.test(ac)) return 'card_expiry';
    if (/\bcc-/.test(ac)) return 'card_number';
    let label = '';
    for (const p of labelPairs(el.ownerDocument.body ?? el.ownerDocument.documentElement)) if (p.control === el) label += ` ${p.text}`;
    const words = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('data-testid'), label]
      .filter(Boolean)
      .join(' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-.:]+/g, ' ')
      .toLowerCase();
    for (const [re, kind] of SECRET_WORDS) if (re.test(words)) return kind;
    // One-time-code boxes: this one-character input and ≥ 3 more of them in its parent or grandparent.
    if (input && input.maxLength === 1) {
      for (let box: Element | null = input.parentElement, i = 0; box && i < 2; box = box.parentElement, i++) {
        const n = Array.from(box.querySelectorAll('input')).filter((x) => (x as HTMLInputElement).maxLength === 1).length;
        if (n >= 4) return 'one_time_code';
      }
    }
    return null;
  }

  function checkTargets(list: TargetObject[]): KitTargetChecks {
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
  function closest(list: TargetObject[]): Array<{ count: number; near: NearElement[] }> {
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
  function focusCheck(id: string): { ok: boolean; desc: string | null; field: string | null } {
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
  function fieldValue(id: string | null): string | null {
    const el = id ? deref(id) : deepActive();
    if (!el) return null;
    if (isA(el, 'input') || isA(el, 'textarea')) return el.value;
    if ((el as HTMLElement).isContentEditable === true || editableBody(el)) {
      const t = (el as HTMLElement).innerText;
      return typeof t === 'string' ? t.replace(/\n$/, '') : (el.textContent ?? '');
    }
    return null;
  }
  // What a click caused (R-FLD-12): DOM changes in every tree (the cursor overlay ignored) and the events of a page that
  // reacts (input, change, submit, scroll, toggle, media). Counted from the press on.
  const EFFECT_EVENTS = ['input', 'change', 'submit', 'reset', 'scroll', 'toggle', 'beforetoggle', 'play', 'pause', 'copy', 'cut', 'hashchange', 'popstate'];
  let effects: { obs: MutationObserver[]; dom: number; first: string; events: Set<string>; take: (list: MutationRecord[]) => void; off: () => void } | null = null;
  cleanups.push(() => effects?.off());
  function effectWatch(): void {
    effects?.off();
    const obs: MutationObserver[] = [];
    const events = new Set<string>();
    // The kit's own cursor overlay (raised to the top of the page now and then) is never an effect.
    const own = (n: Node) => n === host;
    // A screenshot hides the text caret with an inline `caret-color` (Playwright's caret: hide): not the page's doing.
    const caretOnly = (m: MutationRecord) => {
      if (m.attributeName !== 'style') return false;
      const bare = (v: string | null) => (v ?? '').replace(/caret-color\s*:[^;]*;?/gi, '').replace(/[\s;]+/g, '');
      return bare(m.oldValue) === bare((m.target as Element).getAttribute('style'));
    };
    const take = (list: MutationRecord[]) => {
      for (const m of list) {
        if (m.target === host || caretOnly(m)) continue;
        if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(own) && m.addedNodes.length + m.removedNodes.length > 0) continue;
        if (state.dom++ === 0) {
          const t = m.target.nodeType === 1 ? (m.target as Element) : m.target.parentElement;
          state.first = `${m.type}${m.attributeName ? ` ${m.attributeName}` : ''} on ${t ? `${t.localName}${t.id ? `#${t.id}` : ''}` : 'text'}`;
        }
      }
    };
    const docs = new Set<Document>([document]);
    for (const tree of trees(document.documentElement).list) {
      const o = new MutationObserver(take);
      o.observe(tree, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true });
      obs.push(o);
      if (tree.nodeType === 1) docs.add((tree as Element).ownerDocument);
    }
    const onEvent = (e: Event) => {
      // A text field fires `change` when it loses the focus (the field typed into before this click): not the click's doing.
      const t = e.composedPath()[0] as Element | undefined;
      if (e.type === 'change' && t && t.nodeType === 1 && textField(t)) return;
      events.add(e.type);
    };
    // A field taking the focus is what clicking it does (a button taking it is not).
    const onFocus = (e: Event) => {
      const t = e.composedPath()[0] as Element | undefined;
      if (t && t.nodeType === 1 && (isA(t, 'input') || isA(t, 'textarea') || isA(t, 'select') || (t as HTMLElement).isContentEditable === true || editableBody(t))) events.add('focus');
    };
    const wins = [...docs].map((d) => d.defaultView).filter((w): w is Window & typeof globalThis => w !== null);
    for (const w of wins) {
      for (const type of EFFECT_EVENTS) w.addEventListener(type, onEvent, true);
      w.addEventListener('focusin', onFocus, true);
    }
    const off = () => {
      for (const o of obs) o.disconnect();
      for (const w of wins) {
        for (const type of EFFECT_EVENTS) w.removeEventListener(type, onEvent, true);
        w.removeEventListener('focusin', onFocus, true);
      }
    };
    const state = { obs, dom: 0, first: '', events, take, off };
    effects = state;
  }
  function effectSeen(): { watching: boolean; dom: number; first: string; events: string[] } {
    if (!effects) return { watching: false, dom: 0, first: '', events: [] };
    for (const o of effects.obs) effects.take(o.takeRecords());
    return { watching: true, dom: effects.dom, first: effects.first, events: [...effects.events] };
  }
  function effectStop(): void {
    effects?.off();
    effects = null;
  }

  const api: KitApi = {
    version: VERSION,
    healthy: () => {
      if (disposed) return false;
      pinged = false;
      window.dispatchEvent(new Event('__retake_ping'));
      return pinged && (!isTop || config.passive === true || host.isConnected);
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
    afterPaint: () =>
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        RT.setTimeout(finish, 150);
        RT.requestAnimationFrame(() => RT.requestAnimationFrame(finish));
      }),
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
    watchChanges,
    changedBoxes,
    textBox: (id) => {
      const el = deref(id);
      return el ? textBox(el) : null;
    },
    hasText: textVisible,
    snapshot: (id, max) => {
      const el = id ? deref(id) : document.body;
      let html = el ? el.outerHTML : document.documentElement.outerHTML;
      html = html.replace(/<retake-cursor[\s\S]*?<\/retake-cursor>/g, '');
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
    positionalTrigger,
    fieldTrigger: (label) => {
      const el = fieldTriggerEl(label, document.body);
      return el ? ref(el) : null;
    },
    confirmButton,
    fileInputFor,
    selectNative,
    isTextInput,
    fieldState,
    clearField,
    calendar,
    setNativeValue,
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
        input_type: isA(el, 'input') ? el.type : null,
      };
    },
    textOf: (id) => {
      const el = deref(id);
      return el ? short(textOf(el), 200) : '';
    },
    focused: () => {
      // The focused field (type steps without `into`): its description and box, when it is visible; `input_type` tells
      // a password field (its text shows as bullets) from a field that shows what is typed.
      let el = deepActive();
      let edited = el !== null && editableBody(el);
      // The body of a frame (an editor drawn in a frame, or a frame holding the focus): the frame is what is seen.
      if (el && el.ownerDocument !== document && (el === el.ownerDocument.body || el === el.ownerDocument.documentElement)) el = frameElOf(el.ownerDocument);
      if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement || !isVisible(el)) return null;
      edited ||= (el as HTMLElement).isContentEditable === true;
      const input_type = isA(el, 'input') ? el.type : edited ? 'contenteditable' : el.tagName.toLowerCase();
      return { desc: describeEl(el), bbox: bboxOf(el), input_type };
    },
    visibleText: (id) => {
      const el = deref(id);
      if (!el) return '';
      const raw = isA(el, 'input') || isA(el, 'textarea') ? el.value : typeof (el as HTMLElement).innerText === 'string' ? (el as HTMLElement).innerText : el.textContent;
      return norm(raw).slice(0, 2000);
    },
    inventory,
    checkTargets,
    closest,
    focusCheck,
    fieldValue,
    effectWatch,
    effectSeen,
    effectStop,
    suggestFor,
    secretField: (target) => {
      const el = typeof target === 'string' ? deref(target) : target;
      return el ? secretKind(el) : null;
    },
  };
  Object.defineProperty(window, '__retake', { value: api, configurable: true, enumerable: false, writable: true });
}
