/**
 * The in-page recorder (`retake record`): serialised like the kit and evaluated, after a passive copy of the kit,
 * in an ISOLATED WORLD of the recording window's page (record-session.ts: CDP `Page.addScriptToEvaluateOnNewDocument`
 * with a world name, a binding scoped to that world). The page's own scripts share the DOM but not this world's
 * globals or prototypes: they cannot see the recorder, its kit, its binding or its memory, nor call any of them.
 *
 * What it sends (one JSON string per message, through the binding) — intent, never coordinates, never a secret:
 * - capture-phase listeners on the window (registered before the page's scripts run), TRUSTED events only;
 * - a press is recorded at pointerdown (before the app reacts: Radix opens on it), a keyboard activation (Enter /
 *   Space on a focused control, its `click` with `detail: 0`) as a press too; the element is described by the kit's
 *   inventory entry for it (`suggestFor`: a verified target, its context, the action it suggests);
 * - typing is committed per field (blur, Enter, the next action elsewhere, the page hiding): what the field shows past
 *   what it held when text was only added at its end; after an edit inside it (a deletion, an insertion before its
 *   end) its whole final value with `clear` — which holds the parts of its initial value that were kept;
 * - secret-class fields are classified per element and STICKY (a password field switched to `text` by a "show" toggle
 *   stays secret): their text is never sent. A secret field's committed values and its current one (≥ SECRET_MIN
 *   characters; a value typed half-way replaces the previous one, so a prefix like a common word is not kept), a
 *   high-entropy paste or drop and an autofilled value are remembered in this world, and every outgoing string is
 *   masked where it contains one (a re-mounted field, a password pasted elsewhere, a revealed password clicked, a path
 *   segment). Committed values are also told to the runner as salted hashes (never the value), so the next documents
 *   of the session mask them too;
 * - keys only from a whitelist (Escape, Enter, Space, arrows, paging, Backspace / Delete outside text fields) and
 *   Control / Meta shortcuts: a PIN pad or a canvas that listens to keydown never leaks a character; Space, Backspace
 *   and Delete are not sent while the focus is inside a closed shadow root (a hidden field: they would count words);
 * - nothing on an origin that is not one of the environment's (the recorder does not even install there); in a
 *   sub-frame only a content-free notice; on a page the runner says is a sign-in page, nothing (held until it answers).
 */
import type { SecretFieldKind } from '@retake/core/run';
import type { InventoryElement, KitApi } from './types.js';

export interface RecorderConfig {
  /** The CDP binding (Runtime.addBinding scoped to the recorder's world). */
  binding: string;
  /** Origins (scheme://host:port) of the environment's pages: the only ones the recorder installs on. */
  origins: string[];
  /** Seed of the secret memory's hashes (random per recording). */
  salt: number;
  /** In-page time budget of one element's suggestion (ms). */
  budget_ms: number;
  /** In-page time budget of an acted-on element's alternative targets (ms; within `budget_ms`; 0: none). */
  alt_budget_ms: number;
  /** Shortest value the secret memory remembers (SECRET_MIN). */
  secret_min: number;
}

/** What the runner learns about secrets: a value's length and its salted hash (never the value). */
export type SecretHash = [length: number, hash: string];

/**
 * The secret memory's hash (cyrb53, 53 bits, base 36): the in-page recorder and the runner share this one function
 * (its source is injected into the page).
 */
export function secretHash(s: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The mask put in place of a remembered secret. */
export const SECRET_MASK = '•••';

/** Shortest value the secret memory remembers (a shorter one, like a 4-digit PIN, would mask dates and words). */
export const SECRET_MIN = 6;

/** A pasted value that looks like a key or a token: ≥ 20 characters, no white space, ≥ 3 classes of characters. */
export function looksLikeToken(s: string): boolean {
  if (s.length < 20 || /\s/.test(s)) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(s)).length >= 3;
}

/** A scroll position and the time stamp of the scroll event that left it (scrollTrail). */
export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

/**
 * The positions scroll events left each container at, time-stamped: the recorder's scroll baseline is where a container
 * was before the input's time stamp (`before`). A passive wheel listener runs after the compositor scrolled (Chromium),
 * so the position it reads is already the scrolled one: a wheel scroll from rest was lost, and the app's own scroll
 * right after (a route's scroll to the top) recorded in its place. Installed with the document (before it has an
 * element), it sees every scroll: a container no scroll event moved yet is at its origin.
 * Self-contained: evaluated in the page, before the recorder, as `__retakeRecTrail` (recorderSource).
 */
export function scrollTrail(win: Pick<EventTarget, 'addEventListener'>, doc: Document) {
  const trail = new WeakMap<object, TrailPoint[]>();
  const seen = (key: EventTarget | null, c: Element | null, t: number): void => {
    if (!key || typeof c?.scrollTop !== 'number') return;
    trail.set(key, [...(trail.get(key) ?? []).slice(-7), { x: c.scrollLeft, y: c.scrollTop, t }]);
  };
  win.addEventListener('scroll', (e) => seen(e.target, e.target === doc ? (doc.scrollingElement ?? doc.documentElement) : (e.target as Element), e.timeStamp), { capture: true, passive: true });
  const before = (key: EventTarget, stamp: number): { x: number; y: number } => {
    const p = (trail.get(key) ?? []).filter((q) => q.t < stamp).at(-1);
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  };
  return { before };
}

declare const __retakeRecHash: typeof secretHash;
declare const __retakeRecToken: typeof looksLikeToken;
declare const __retakeRecTrail: ReturnType<typeof scrollTrail>;

/**
 * The in-page recorder (see the file comment). Self-contained: serialised with `toString()`. Its state comes first,
 * then the steps that install it (in the order the listeners are registered), then its helpers, by section.
 */
export function pageRecorder(cfg: RecorderConfig): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.__retakeRecInstalled) return;
  g.__retakeRecInstalled = true;
  const send0 = g[cfg.binding] as ((payload: string) => void) | undefined;
  const kit = g.__retake as KitApi | undefined;
  if (typeof send0 !== 'function' || !kit) return;
  if (!cfg.origins.includes(location.origin)) return;
  const MASK = '•••';
  const TEXT_MAX = 2000;
  const raw = (m: Record<string, unknown>): void => {
    try {
      send0(JSON.stringify(m));
    } catch {
      /* the window is closing */
    }
  };
  const now = (): number => performance.now();
  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  const on = (type: string, fn: (e: Event) => void): void => addEventListener(type, fn, { capture: true, passive: true });
  if (!isTop) {
    noticeFrame();
    return;
  }

  // Secret memory.
  const values = new Set<string>();
  let sorted: string[] | null = null;
  const hashed = new Map<number, Set<string>>();
  /** The value a secret field holds while it is typed in (each new one replaces the last: never a prefix kept). */
  const partials = new Map<Element, string>();
  /** Shortest start of a remembered secret that makes typed text secret (the first part of a split typing). */
  const SECRET_PREFIX_MIN = 4;
  // Sign-in pages: the runner says where recording is allowed.
  type Msg = { path: string; at: number; e: Record<string, unknown> };
  let armed: string | null = null;
  const denied = new Set<string>();
  const asked = new Set<string>();
  let queue: Array<{ url: string; m: Msg }> = [];
  // What changed on the page.
  let added = new WeakSet<Node>();
  let lastMutation = now();
  // Elements.
  const secretEls = new WeakSet<Element>();
  const secretKinds = new WeakMap<Element, SecretFieldKind>();
  const TEXT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  // Typing.
  interface Field {
    el: Element;
    v0: string;
    last: string;
    info: Record<string, unknown> | null;
    keyed: number;
    pasted: boolean;
    autofill: boolean;
  }
  let field: Field | null = null;
  const focusValue = new WeakMap<Element, string>();
  // Keys.
  let pendingKey: { key: string; mods: string[]; el: Element; info: Record<string, unknown> | null; timer: ReturnType<typeof setTimeout> } | null = null;
  // Scroll: what the person scrolled (wheel, keys, scrollbar), net per container after a pause.
  let userScrollAt = -1e9;
  /** Baselines: a container's position before the person's scroll (dropped 1.2 s after, when it did not move). */
  const starts = new Map<EventTarget, { x: number; y: number; el: Element | null; at: number }>();
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;

  g.__retakeRecVerdict = verdict;
  observeMutations();
  listenTyping();
  listenKeys();
  listenPointer();
  listenScroll();
  g.__retakeRecFlush = flushAll;
  on('pagehide', flushAll);
  raw({ k: 'hello', url: here(), w: innerWidth, h: innerHeight });

  /** A frame is not recorded: a content-free notice per second of interaction. */
  function noticeFrame(): void {
    let last = -1e9;
    const note = (e: Event): void => {
      if (!e.isTrusted || now() - last < 1000) return;
      last = now();
      raw({ k: 'frame' });
    };
    on('pointerdown', note);
    on('keydown', note);
  }
  function flushAll(): void {
    commit(false);
    flushKey();
    flushScroll();
  }

  // ── Secret memory ──────────────────────────────────────────────────────────
  function addHash(n: number, h: string): void {
    let set = hashed.get(n);
    if (!set) hashed.set(n, (set = new Set()));
    set.add(h);
  }
  function remember(v: string): void {
    if (v.length < cfg.secret_min || values.has(v) || values.size >= 4000) return;
    values.add(v);
    sorted = null;
  }
  function partial(el: Element, v: string): void {
    if (v.length >= cfg.secret_min) partials.set(el, v);
    else partials.delete(el);
  }
  /** Does `text` end with the start (SECRET_PREFIX_MIN characters or more) of a value the memory knows? */
  function secretPrefix(text: string): boolean {
    if (text.length < SECRET_PREFIX_MIN) return false;
    for (const v of [...values, ...partials.values()]) {
      for (let n = Math.min(v.length, text.length); n >= SECRET_PREFIX_MIN; n--) if (text.endsWith(v.slice(0, n))) return true;
    }
    return false;
  }
  /** A final secret value: remembered here, and told to the runner as its salted hash. */
  function share(v: string): void {
    remember(v);
    if (v.length < cfg.secret_min) return;
    const h = __retakeRecHash(v, cfg.salt);
    if (hashed.get(v.length)?.has(h)) return;
    addHash(v.length, h);
    raw({ k: 'secret', n: v.length, h });
  }
  function mask(s: string): { s: string; hit: boolean } {
    let out = s;
    let hit = false;
    if (values.size || partials.size) {
      sorted ??= [...values].sort((a, b) => b.length - a.length);
      const list = partials.size ? [...sorted, ...partials.values()].sort((a, b) => b.length - a.length) : sorted;
      for (const v of list) {
        if (out.includes(v)) {
          out = out.split(v).join(MASK);
          hit = true;
        }
      }
    }
    for (const [n, set] of hashed) {
      if (out.length < n) continue;
      let res = '';
      let from = 0;
      for (let i = 0; i + n <= out.length; ) {
        if (set.has(__retakeRecHash(out.slice(i, i + n), cfg.salt))) {
          res += out.slice(from, i) + MASK;
          i += n;
          from = i;
          hit = true;
        } else i++;
      }
      if (from > 0) out = res + out.slice(from);
    }
    return { s: out, hit };
  }
  function maskDeep(v: unknown, count: { n: number }): unknown {
    if (typeof v === 'string') {
      const r = mask(v);
      if (r.hit) count.n++;
      return r.s;
    }
    if (Array.isArray(v)) return v.map((x) => maskDeep(x, count));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = maskDeep(x, count);
      return out;
    }
    return v;
  }

  // ── Sign-in pages: the runner says where recording is allowed ──────────────
  function here(): string {
    return location.origin + location.pathname;
  }
  function ask(url: string): void {
    if (asked.has(url)) return;
    asked.add(url);
    raw({ k: 'where', url });
  }
  function deliver(m: Msg): void {
    const count = { n: 0 };
    const e = maskDeep(m.e, count) as Record<string, unknown>;
    const path = mask(m.path).s;
    raw({ k: 'ev', age: Math.max(0, Math.round(now() - m.at)), path, e, ...(count.n ? { redacted: count.n } : {}) });
  }
  /** The runner's answer for a page: record it (the events held for it delivered) or not (they are dropped). */
  function verdict(url: string, ok: boolean, hashes: SecretHash[]): void {
    for (const [n, h] of hashes ?? []) addHash(n, h);
    if (ok) {
      armed = url;
      denied.delete(url);
    } else {
      denied.add(url);
      if (armed === url) armed = null;
    }
    let dropped = 0;
    const keep: typeof queue = [];
    for (const q of queue) {
      if (q.url !== url) keep.push(q);
      else if (ok) deliver(q.m);
      else dropped++;
    }
    queue = keep;
    if (dropped) raw({ k: 'discarded', reason: 'sign_in', count: dropped });
  }
  function emit(e: Record<string, unknown>, flush = true): void {
    if (flush) flushScroll();
    if (e.kind === 'pointer' || e.kind === 'type' || e.kind === 'key' || e.kind === 'select_native' || e.kind === 'file') added = new WeakSet();
    const url = here();
    if (denied.has(url)) {
      raw({ k: 'discarded', reason: 'sign_in', count: 1 });
      return;
    }
    const m: Msg = { path: location.pathname, at: now(), e };
    if (url === armed) deliver(m);
    else {
      if (queue.length < 500) queue.push({ url, m });
      ask(url);
    }
  }

  // ── What changed on the page ──────────────────────────────────────────────
  function observeMutations(): void {
    new MutationObserver((records) => {
      lastMutation = now();
      for (const r of records) for (const n of Array.from(r.addedNodes)) added.add(n);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  function appeared(el: Element | null): boolean {
    for (let n: Node | null = el, i = 0; n && i < 4096; i++) {
      if (added.has(n)) return true;
      n = n.nodeType === 11 ? (n as ShadowRoot).host : n.parentNode;
    }
    return false;
  }

  // ── Elements ──────────────────────────────────────────────────────────────
  /** Sticky: once secret, always secret (a "show password" toggle, a value moved to another field). */
  function secretOf(el: Element | null, fallback?: SecretFieldKind): SecretFieldKind | null {
    if (!el) return null;
    let kind: SecretFieldKind | null = null;
    try {
      kind = kit!.secretField(el);
    } catch {
      kind = null;
    }
    if (kind) {
      secretEls.add(el);
      if (!secretKinds.has(el)) secretKinds.set(el, kind);
    } else if (fallback && !secretEls.has(el)) {
      secretEls.add(el);
      secretKinds.set(el, fallback);
    }
    return secretEls.has(el) ? (secretKinds.get(el) ?? 'secret') : null;
  }
  /**
   * The element acted on, as the kit's inventory entry describes it. `alts`: an action whose step targets this element
   * (a press, a keyboard activation, typing, a native select, a file): up to three alternative targets too —
   * never for a secret field.
   */
  function info(target: Element | null, alts = false): Record<string, unknown> | null {
    if (!target) return null;
    let e: InventoryElement | null = null;
    try {
      e = kit!.suggestFor(target, { budget_ms: cfg.budget_ms, ...(alts ? { alternatives: 3, alternatives_budget_ms: cfg.alt_budget_ms } : {}) });
    } catch {
      e = null;
    }
    if (!e) return fallback(target);
    const el = kit!.el(e.ref);
    const out: Record<string, unknown> = {
      target: e.suggested?.target ?? null,
      matches: e.suggested?.matches ?? 0,
      fragile: e.suggested?.fragile ?? [],
      in: e.in,
      action: e.action,
      role: e.role,
      tag: e.tag,
      input_type: e.input_type,
      name: e.name,
      text: e.text,
      label: e.label,
      placeholder: e.placeholder,
      testid: e.testid,
      href_path: e.href_path,
      in_view: e.in_view,
      state: e.state,
      appeared: appeared(el),
      secret: secretOf(el) !== null,
    };
    if (!e.suggested) out.desc = kit!.describe(e.ref);
    if (alts && out.secret === false && e.suggested) {
      const list = (e.alternatives ?? []).filter((a) => a.target.nth === undefined && !a.target.last_visible).slice(0, 3);
      if (list.length > 0) out.alternatives = list.map((a) => ({ target: a.target, fragile: a.fragile.filter((f) => f !== 'nth') }));
      if (e.alternatives_partial) out.alternatives_partial = true;
    }
    return out;
  }
  /**
   * No inventory entry (an element still fading in, a time budget spent): the interactive element's description only,
   * without a target (the draft's check replay resolves it, or flags it).
   */
  function fallback(target: Element): Record<string, unknown> | null {
    const el = target.closest('button,a[href],input,select,textarea,label,summary,[role],[tabindex],[contenteditable]');
    if (!el) return null;
    const role = el.getAttribute('role');
    const tag = el.localName;
    const text = editable(el) ? '' : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const scope = el.closest('[role=listbox]') ? 'listbox' : el.closest('[role=menu]') ? 'menu' : el.closest('[role=dialog],[role=alertdialog],dialog') ? 'dialog' : 'page';
    const off = { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false };
    return {
      target: null,
      matches: 0,
      fragile: [],
      in: scope,
      action: { kind: 'click', verified: false },
      role,
      tag,
      input_type: tag === 'input' ? (el as HTMLInputElement).type : null,
      name: '',
      text,
      label: null,
      placeholder: null,
      testid: el.getAttribute('data-testid'),
      href_path: null,
      in_view: false,
      state: off,
      appeared: appeared(el),
      secret: secretOf(el) !== null,
      desc: `${role ?? tag}${text ? ` "${text.slice(0, 50)}"` : ''}`,
    };
  }
  function deepTarget(e: Event): Element | null {
    const t = e.composedPath()[0] as Node | undefined;
    if (t && t.nodeType === 1) return t as Element;
    const u = e.target as Node | null;
    return u && u.nodeType === 1 ? (u as Element) : null;
  }
  /** The text field an event happened in: an input of a text type, a textarea, a contenteditable's editing host. */
  function editable(t: Element | null): Element | null {
    if (!t) return null;
    if (t.localName === 'input') return TEXT_TYPES.includes((t as HTMLInputElement).type) ? t : null;
    if (t.localName === 'textarea') return t;
    if ((t as HTMLElement).isContentEditable) {
      let host: Element = t;
      for (let p = t.parentElement; p && (p as HTMLElement).isContentEditable; p = p.parentElement) host = p;
      return host;
    }
    return null;
  }
  function fieldText(el: Element): string {
    return el.localName === 'input' || el.localName === 'textarea' ? (el as HTMLInputElement).value : ((el as HTMLElement).innerText ?? el.textContent ?? '');
  }

  // ── Typing ────────────────────────────────────────────────────────────────
  function begin(el: Element, fromInput = false): Field {
    if (field && field.el === el) return field;
    commit(false);
    const v0 = focusValue.get(el) ?? (fromInput ? '' : fieldText(el));
    if (secretOf(el)) remember(v0);
    field = { el, v0, last: fieldText(el), info: info(el, true), keyed: fromInput ? -1e9 : now(), pasted: false, autofill: false };
    return field;
  }
  /** Commit the field being typed in; false when nothing changed (nothing sent). */
  function commit(enter: boolean): boolean {
    const f = field;
    if (!f) return false;
    field = null;
    const v = f.el.isConnected ? fieldText(f.el) : f.last;
    focusValue.set(f.el, v);
    partials.delete(f.el);
    if (v === f.v0) return false;
    let kind = secretOf(f.el, f.autofill ? 'secret' : undefined);
    const clear = f.v0 !== '' && !v.startsWith(f.v0);
    const text = clear ? v : v.slice(f.v0.length);
    // A value the memory knows (a re-mounted field, a password pasted into a plain one): secret too — and so is typed
    // text that ends with the first SECRET_PREFIX_MIN or more characters of one (its typing was split by a blur, a visit
    // to the Studio: the rest would come as a secret, this part in clear). Once secret, the field stays secret.
    if (!kind && (mask(v).hit || secretPrefix(text))) kind = secretOf(f.el, 'secret');
    if (kind) share(v);
    const el = f.info ? { ...f.info, secret: kind !== null } : null;
    const tag = f.el.localName;
    const plain =
      tag === 'textarea' ? 'multiline' : tag === 'input' ? (/^(search)$/.test((f.el as HTMLInputElement).type) || f.el.getAttribute('role') === 'combobox' ? 'search' : 'text') : 'contenteditable';
    emit({
      kind: 'type',
      el,
      secret: kind !== null,
      field_kind: kind ?? plain,
      ...(kind ? {} : { text: text.slice(0, TEXT_MAX) }),
      clear,
      enter,
      pasted: f.pasted,
      autofill: f.autofill,
    });
    return true;
  }
  /** Text pasted or dropped into a field: a value that looks like a key or a token makes the field secret. */
  function inserted(el: Element, text: string): void {
    const f = begin(el);
    f.keyed = now();
    f.pasted = true;
    if (__retakeRecToken(text.trim())) {
      secretOf(el, 'api_key');
      share(text.trim());
    }
  }
  function listenTyping(): void {
    on('focusin', (e) => {
      const el = editable(deepTarget(e));
      if (!el || (field && field.el === el)) return;
      const v = fieldText(el);
      focusValue.set(el, v);
      if (secretOf(el)) remember(v);
    });
    on('focusout', (e) => {
      const t = deepTarget(e);
      if (field && t && (field.el === t || field.el.contains(t))) commit(false);
    });
    on('paste', (e) => {
      if (!e.isTrusted) return;
      const el = editable(deepTarget(e));
      if (!el) return;
      inserted(el, (e as ClipboardEvent).clipboardData?.getData('text') ?? '');
    });
    on('drop', (e) => {
      if (!e.isTrusted) return;
      const t = deepTarget(e);
      const el = editable(t);
      if (el) {
        let text = '';
        try {
          text = (e as DragEvent).dataTransfer?.getData('text') ?? '';
        } catch {
          text = '';
        }
        inserted(el, text);
        return;
      }
      const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
      if (!files.length) return;
      commit(false);
      emit({ kind: 'file', el: info(t, true), via: 'drop', names: files.slice(0, 20).map((f) => f.name.slice(0, 200)) });
    });
    on('input', (e) => {
      if (!e.isTrusted) return;
      const el = editable(deepTarget(e));
      if (!el) return;
      const f = begin(el, true);
      // A value that changed with no key, paste or drop before it: the browser's autofill (kept as a secret).
      if (now() - f.keyed > 1000) f.autofill = true;
      f.last = fieldText(el);
      if (secretOf(el)) partial(el, f.last);
    });
  }

  // ── Keys ──────────────────────────────────────────────────────────────────
  /**
   * The focus is inside a closed shadow root: the event's deepest target is its host, which has the focus without being
   * focusable itself (a closed root's field cannot be seen from here, so it may be a secret one).
   */
  function hiddenFocus(t: Element | null): boolean {
    if (!t || t !== document.activeElement || t === document.body || t === document.documentElement || t.shadowRoot) return false;
    return !t.matches('a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]:not([contenteditable="false"])');
  }
  function modsOf(e: KeyboardEvent): string[] {
    return [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[];
  }
  function flushKey(): void {
    const p = pendingKey;
    if (!p) return;
    pendingKey = null;
    clearTimeout(p.timer);
    emit({ kind: 'key', key: p.key, modifiers: p.mods, el: p.info });
  }
  function listenKeys(): void {
    const NAMED = ['Escape', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'Delete'];
    /** Keys sent from inside a text field (they say nothing of its text). */
    const IN_FIELD = ['Escape', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];
    const SCROLL_KEYS = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '];
    /** Keys that would tell how a hidden field's text is made (words, corrections). */
    const HIDDEN_FIELD_KEYS = [' ', 'Backspace', 'Delete'];
    on('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (!e.isTrusted || e.isComposing) return;
      const t = deepTarget(e);
      const mods = modsOf(e);
      const k = e.key;
      const ed = editable(t);
      if (!ed && SCROLL_KEYS.includes(k)) noteUserScroll(t, e.timeStamp);
      if (ed) {
        const f = begin(ed);
        f.keyed = now();
        if (e.repeat) return;
        const multi = ed.localName !== 'input';
        if (k === 'Enter' && !multi && !mods.length) {
          if (!commit(true)) emit({ kind: 'key', key: 'Enter', modifiers: [], el: info(ed) });
          return;
        }
        if (IN_FIELD.includes(k) && !mods.some((m) => m === 'Control' || m === 'Meta')) {
          commit(false);
          emit({ kind: 'key', key: k, modifiers: mods, el: info(ed) });
        }
        return;
      }
      if (e.repeat) return;
      const shortcut = (mods.includes('Control') || mods.includes('Meta')) && /^[a-z0-9]$/i.test(k);
      if (!shortcut && !NAMED.includes(k)) return;
      if (!shortcut && HIDDEN_FIELD_KEYS.includes(k) && hiddenFocus(t)) return;
      flushKey();
      commit(false);
      const focusEl = t && t !== document.body && t !== document.documentElement ? t : null;
      const activation = !shortcut && (k === 'Enter' || k === ' ') && focusEl !== null;
      const what = focusEl ? info(focusEl, activation) : null;
      if (activation && focusEl) {
        // A keyboard activation: its click (detail 0) makes it a press; else it stays a key.
        pendingKey = { key: k, mods, el: focusEl, info: what, timer: setTimeout(flushKey, 1000) };
        return;
      }
      emit({ kind: 'key', key: shortcut ? k.toLowerCase() : k, modifiers: mods, el: what });
    });
    on('keyup', (ev) => {
      const e = ev as KeyboardEvent;
      if (pendingKey && e.key === pendingKey.key) {
        clearTimeout(pendingKey.timer);
        pendingKey.timer = setTimeout(flushKey, 50);
      }
    });
  }

  // ── Pointer ───────────────────────────────────────────────────────────────
  function listenPointer(): void {
    on('pointerdown', (ev) => {
      const e = ev as PointerEvent;
      if (!e.isTrusted) return;
      const t = deepTarget(e);
      // A press on a scrollbar (the document's, or an element's beyond its client box) starts a scroll.
      const scrollable = (n: Element) => n.clientWidth > 0 && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1);
      if (t && (t === document.documentElement || (scrollable(t) && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)))) noteUserScroll(t, e.timeStamp);
      if (field && !(t && (field.el === t || field.el.contains(t)))) commit(false);
      flushKey();
      const t0 = now();
      const quiet = Math.max(0, Math.round(t0 - lastMutation));
      const el = info(t, true);
      emit({ kind: 'pointer', button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', via: 'pointer', el, quiet_ms: quiet, ms: Math.round(now() - t0) });
    });
    on('click', (ev) => {
      const e = ev as MouseEvent;
      if (!e.isTrusted || e.detail !== 0 || !pendingKey) return;
      const t = deepTarget(e);
      const p = pendingKey;
      pendingKey = null;
      clearTimeout(p.timer);
      const same = t && (t === p.el || p.el.contains(t) || t.contains(p.el));
      emit({ kind: 'pointer', button: 'left', via: 'keyboard', el: same ? p.info : info(t, true), quiet_ms: Math.max(0, Math.round(now() - lastMutation)), ms: 0 });
    });
    on('dblclick', (e) => {
      if (e.isTrusted) emit({ kind: 'dblclick' });
    });
    on('change', (e) => {
      if (!e.isTrusted) return;
      const t = deepTarget(e);
      if (!t) return;
      if (t.localName === 'select') {
        commit(false);
        const s = t as HTMLSelectElement;
        const opt = s.selectedOptions[0];
        emit({ kind: 'select_native', el: info(t, true), option: (opt ? opt.label || opt.text : '').trim().slice(0, 200) });
      } else if (t.localName === 'input' && (t as HTMLInputElement).type === 'file') {
        commit(false);
        const files = Array.from((t as HTMLInputElement).files ?? []);
        emit({ kind: 'file', el: info(t, true), via: 'input', names: files.slice(0, 20).map((f) => f.name.slice(0, 200)) });
      }
    });
  }

  // ── Scroll: what the person scrolled (wheel, keys, scrollbar), net per container after a pause ──
  function docEl(): Element {
    return document.scrollingElement ?? document.documentElement;
  }
  function posOf(c: Element): { x: number; y: number } {
    return { x: c.scrollLeft, y: c.scrollTop };
  }
  /** Before a scroll the person starts (its input's time stamp): where the document and the target's scrolling ancestors were. */
  function noteUserScroll(t: Element | null, stamp: number): void {
    userScrollAt = now();
    const d = docEl();
    const base = (key: EventTarget, c: Element, el: Element | null): void => {
      const s = starts.get(key);
      const p = posOf(c);
      // A baseline that has not moved is refreshed (the app may have scrolled it since); one that moved is kept.
      if (!s || (s.x === p.x && s.y === p.y)) starts.set(key, { ...__retakeRecTrail.before(key, stamp), el, at: now() });
    };
    base(document, d, null);
    for (let n: Element | null = t, i = 0; n && i < 32 && n !== d && n !== document.body; n = n.parentElement, i++) {
      if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) base(n, n, n);
    }
  }
  function flushScroll(): void {
    clearTimeout(scrollTimer);
    for (const [key, s] of [...starts]) {
      const c = key === document ? docEl() : (s.el as Element);
      if (!c?.isConnected) {
        starts.delete(key);
        continue;
      }
      const p = posOf(c);
      const dx = Math.round(p.x - s.x);
      const dy = Math.round(p.y - s.y);
      if (dx === 0 && dy === 0) {
        if (now() - s.at > 1200) starts.delete(key);
        continue;
      }
      starts.delete(key);
      emit({ kind: 'scroll', container: key === document ? 'document' : 'element', el: key === document ? null : info(c), dx, dy }, false);
    }
  }
  function listenScroll(): void {
    on('wheel', (e) => {
      if (e.isTrusted) noteUserScroll(deepTarget(e), e.timeStamp);
    });
    on('scroll', () => {
      if (now() - userScrollAt > 1000) return;
      userScrollAt = now();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(flushScroll, 400);
    });
  }
}

/** The recorder's script, evaluated after the kit in its isolated world. */
export function recorderSource(cfg: RecorderConfig): string {
  return `(() => { var __name = (f) => f; var __retakeRecHash = (${secretHash.toString()}); var __retakeRecToken = (${looksLikeToken.toString()}); var __retakeRecTrail = (${scrollTrail.toString()})(window, document); (${pageRecorder.toString()})(${JSON.stringify(cfg)}); })();`;
}
