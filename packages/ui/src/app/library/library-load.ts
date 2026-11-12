/**
 * What the library screen asks the server for, and when (L4.7 part D1; critique B8, B18, C1):
 *
 * - `LibraryImages`: posters and loops as base64 (library_images), for the cards ON SCREEN only (an
 *   IntersectionObserver reports them), at most IMAGES_KEYS_MAX keys and IMAGES_KEYS_MAX committed posters per call,
 *   IMAGES_IN_FLIGHT calls at a time; a call whose cards all left the screen is aborted. Every image is checked here
 *   again: its kind's format (a poster PNG, a loop GIF), the component asked, and `imageDataUrl` (prefix, base64, cap,
 *   magic) — anything else is `unreadable`, said in words. `budget` (the answer's cap) is asked again. Held in this
 *   tab's memory only, at most IMAGES_CHARS_MAX characters of base64 (the oldest off screen leave first).
 * - `RenderPump`: which posters and loops to queue (library_render) — loops the person asked for (Play, the detail,
 *   "Render all loops") first, then the posters of the cards on screen — in chunks of at most RENDER_CHUNK_MAX
 *   components, only while no preview of this library is queued or running (the next chunk goes when that job
 *   finished: a capture submitted meanwhile runs first), RENDER_DEBOUNCE_MS after the last change of what is on screen
 *   or of the theme (a Play goes at once), only while the tab is visible. A key is asked once: a failed one is rendered
 *   again only by an explicit Retry (`retry: true`); a key whose job ended without it (cancelled, or the worker computed
 *   another key, B18) is asked again only by "Render again". A refusal (the disk is nearly full…) stops the pump until
 *   the person tries again.
 */
import type { LibraryImagesAnswer, LibraryItem } from '../../server/library-ops.js';
import { LOOP_DATA_MAX, POSTER_DATA_MAX, imageDataUrl } from '../thumbs.js';

/** Keys (and committed posters) of one library_images call, at most (the op's cap). */
export const IMAGES_KEYS_MAX = 12;
/** library_images calls at a time. */
export const IMAGES_IN_FLIGHT = 2;
/** Cards that came on screen within this delay share a call. */
export const IMAGES_DELAY_MS = 60;
/** Base64 characters of pictures kept in the tab. */
export const IMAGES_CHARS_MAX = 24_000_000;
/** Components of one library_render call, at most (core LIBRARY_JOB_MAX). */
export const RENDER_CHUNK_MAX = 12;
/** Posters are queued this long after the last change of the cards on screen or of the theme. */
export const RENDER_DEBOUNCE_MS = 2000;
/** A loop the person asked for goes after this short delay (clicks in a row share a call). */
export const RENDER_URGENT_MS = 50;

type Timer = (fn: () => void, ms: number) => () => void;
const defaultTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** One picture a card wants: a cached entry by key, or a built-in's committed poster by component. */
export interface ImageWant {
  kind: 'poster' | 'loop';
  component: string;
  /** A cached entry's key; absent: the committed poster of `component`. */
  key?: string;
}

export type ImageMissing = 'missing' | 'too_large' | 'not_builtin' | 'unreadable' | 'failed';
export type ImageEntry = { state: 'ok'; format: 'png' | 'gif'; data: string } | { state: 'missing'; reason: ImageMissing };

export const imageId = (w: ImageWant): string => (w.key !== undefined ? `k:${w.key}` : `c:${w.component}`);

/** One library_images call. A rejection after `signal` aborted is a cancellation. */
export type ImagesFetch = (keys: string[], committed: string[], signal: AbortSignal) => Promise<LibraryImagesAnswer>;

interface ImagesBatch {
  ids: string[];
  ac: AbortController;
}

const IMAGE_MISSING: ReadonlySet<string> = new Set(['missing', 'too_large', 'not_builtin']);

export class LibraryImages {
  private readonly entries = new Map<string, ImageEntry>();
  private readonly wants = new Map<string, ImageWant>();
  private readonly visible = new Map<string, number>();
  private readonly asked = new Set<string>();
  private readonly batches = new Set<ImagesBatch>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private chars = 0;
  private pending = false;
  private closed = false;
  private readonly timer: Timer;
  /** Calls made (tests). */
  calls = 0;

  constructor(
    private readonly fetch: ImagesFetch,
    o: { timer?: Timer; charsMax?: number } = {},
  ) {
    this.timer = o.timer ?? defaultTimer;
    this.charsMax = o.charsMax ?? IMAGES_CHARS_MAX;
  }
  private readonly charsMax: number;

  get(w: ImageWant): ImageEntry | undefined {
    return this.entries.get(imageId(w));
  }

  subscribe(w: ImageWant, fn: () => void): () => void {
    const k = imageId(w);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(k);
    };
  }

  /** A card showing `w` came on screen (true) or left it (false). */
  setVisible(w: ImageWant, on: boolean): void {
    if (this.closed) return;
    const k = imageId(w);
    this.wants.set(k, w);
    const n = (this.visible.get(k) ?? 0) + (on ? 1 : -1);
    if (n > 0) this.visible.set(k, n);
    else this.visible.delete(k);
    if (on) this.kick();
    else for (const b of this.batches) if (!b.ids.some((id) => this.visible.has(id))) b.ac.abort();
  }

  close(): void {
    this.closed = true;
    for (const b of this.batches) b.ac.abort();
  }

  get inFlight(): number {
    return this.batches.size;
  }

  private notify(k: string): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) fn();
  }

  private kick(): void {
    if (this.pending || this.closed) return;
    this.pending = true;
    this.timer(() => {
      this.pending = false;
      this.pump();
    }, IMAGES_DELAY_MS);
  }

  private pump(): void {
    while (!this.closed && this.batches.size < IMAGES_IN_FLIGHT) {
      const keys: string[] = [];
      const committed: string[] = [];
      const ids: string[] = [];
      for (const k of this.visible.keys()) {
        if (this.entries.has(k) || this.asked.has(k)) continue;
        const w = this.wants.get(k)!;
        if (w.key !== undefined ? keys.length >= IMAGES_KEYS_MAX : committed.length >= IMAGES_KEYS_MAX) continue;
        if (w.key !== undefined) keys.push(w.key);
        else committed.push(w.component);
        ids.push(k);
      }
      if (!ids.length) return;
      this.send(ids, keys, committed);
    }
  }

  private send(ids: string[], keys: string[], committed: string[]): void {
    const b: ImagesBatch = { ids, ac: new AbortController() };
    this.batches.add(b);
    for (const k of ids) this.asked.add(k);
    this.calls++;
    this.fetch(keys, committed, b.ac.signal).then(
      (a) => this.answer(b, a),
      () => this.done(b, b.ac.signal.aborted ? undefined : 'failed'),
    );
  }

  private set(k: string, e: ImageEntry): void {
    const old = this.entries.get(k);
    if (old?.state === 'ok') this.chars -= old.data.length;
    this.entries.delete(k);
    this.entries.set(k, e);
    if (e.state === 'ok') this.chars += e.data.length;
    this.notify(k);
  }

  private answer(b: ImagesBatch, a: LibraryImagesAnswer): void {
    if (b.ac.signal.aborted) return this.done(b, undefined);
    const seen = new Set<string>();
    for (const img of Array.isArray(a?.images) ? a.images : []) {
      const k = typeof img?.key === 'string' ? `k:${img.key}` : `c:${String(img?.component)}`;
      const w = this.wants.get(k);
      if (!w || !b.ids.includes(k) || seen.has(k)) continue;
      seen.add(k);
      // The kind's own format, the component asked, a checked data address — else it is not shown.
      const format = w.kind === 'poster' ? 'png' : 'gif';
      const ok = img.kind === w.kind && img.format === format && img.component === w.component && imageDataUrl(format, img.data, format === 'png' ? POSTER_DATA_MAX : LOOP_DATA_MAX) !== null;
      this.set(k, ok ? { state: 'ok', format, data: img.data } : { state: 'missing', reason: 'unreadable' });
    }
    let budget = 0;
    for (const m of Array.isArray(a?.missing) ? a.missing : []) {
      const k = typeof m?.key === 'string' ? `k:${m.key}` : `c:${String(m?.component)}`;
      if (!b.ids.includes(k) || seen.has(k)) continue;
      seen.add(k);
      if (m.reason === 'budget') budget++;
      else this.set(k, { state: 'missing', reason: IMAGE_MISSING.has(m.reason) ? (m.reason as ImageMissing) : 'unreadable' });
    }
    // An answer of nothing but `budget` must not loop: those are given up on.
    this.done(b, budget > 0 && budget === b.ids.length ? 'failed' : undefined);
  }

  private done(b: ImagesBatch, reason: ImageMissing | undefined): void {
    this.batches.delete(b);
    for (const k of b.ids) {
      this.asked.delete(k);
      if (reason && !this.entries.has(k)) this.set(k, { state: 'missing', reason });
    }
    this.trim();
    if (!this.closed && [...this.visible.keys()].some((k) => !this.entries.has(k) && !this.asked.has(k))) this.kick();
  }

  private trim(): void {
    for (const [k, e] of this.entries) {
      if (this.chars <= this.charsMax) break;
      if (e.state === 'ok' && !this.visible.has(k)) {
        this.entries.delete(k);
        this.chars -= e.data.length;
        this.notify(k);
      }
    }
  }
}

/** What the pump needs of an item. */
export type PumpItem = Pick<LibraryItem, 'component' | 'poster' | 'loop'>;

/** One library_render call. */
export interface RenderRequest {
  items: Array<{ component: string; poster?: string; loop?: string }>;
  retry?: true;
}

/** A key this tab asked for: `pending` (the call not answered), `asked` (answered), `queued` (a view showed it), `ended` (its job ended without it). */
export type AskedState = 'pending' | 'asked' | 'queued' | 'ended';

/**
 * The next library_render call (pure): loops wanted first, then posters of the cards on screen — keys missing, not
 * queued, never asked — at most `max` components; a component's missing poster rides along with its loop.
 */
export function nextChunk(items: readonly PumpItem[], o: { visible: ReadonlySet<string>; loops: ReadonlySet<string>; asked: ReadonlyMap<string, AskedState>; max?: number }): RenderRequest['items'] {
  const max = Math.min(o.max ?? RENDER_CHUNK_MAX, RENDER_CHUNK_MAX);
  const free = (p: PumpItem['poster'] | PumpItem['loop']) => p.state === 'missing' && !p.queued && !o.asked.has(p.key);
  const out: RenderRequest['items'] = [];
  const add = (i: PumpItem, loop: boolean) => {
    if (out.length >= max || out.some((x) => x.component === i.component)) return;
    const poster = free(i.poster) && (o.visible.has(i.component) || loop);
    const l = loop && free(i.loop);
    if (poster || l) out.push({ component: i.component, ...(poster ? { poster: i.poster.key } : {}), ...(l ? { loop: i.loop.key } : {}) });
  };
  for (const i of items) if (o.loops.has(i.component)) add(i, true);
  for (const i of items) add(i, false);
  return out;
}

export interface RenderPumpOptions {
  /** library_render (the screen re-reads its view once it answers). Rejects with the refusal's words. */
  send: (req: RenderRequest) => Promise<void>;
  timer?: Timer;
  debounceMs?: number;
}

export class RenderPump {
  private items: readonly PumpItem[] = [];
  private theme = '';
  private busy = true;
  private active = true;
  private sending = false;
  private readonly visible = new Set<string>();
  /** Components whose loop the person asked for (Play, the detail, Render all), and the ones asked just now. */
  private readonly loops = new Set<string>();
  private readonly urgent = new Set<string>();
  private readonly asked = new Map<string, AskedState>();
  private cancel: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly timer: Timer;
  private readonly debounceMs: number;
  /** The last refusal's words: the pump stays still until `clearError`. */
  error: string | null = null;
  /** Calls made (tests). */
  readonly sent: RenderRequest[] = [];

  constructor(private readonly o: RenderPumpOptions) {
    this.timer = o.timer ?? defaultTimer;
    this.debounceMs = o.debounceMs ?? RENDER_DEBOUNCE_MS;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** A key's state for the words of its card. */
  askedOf(key: string): AskedState | undefined {
    return this.asked.get(key);
  }

  /** A new view of the library: its items and how many of its keys are queued or running. */
  setView(theme: string, items: readonly PumpItem[], queued: number): void {
    const themeChanged = theme !== this.theme;
    if (themeChanged) {
      this.theme = theme;
      this.asked.clear();
      this.urgent.clear();
    }
    this.items = items;
    this.busy = queued > 0;
    for (const i of items) {
      for (const p of [i.poster, i.loop]) {
        const a = this.asked.get(p.key);
        if (!a || a === 'pending') continue;
        if (p.queued) this.asked.set(p.key, 'queued');
        else if (p.state === 'missing') this.asked.set(p.key, 'ended');
        else this.asked.delete(p.key);
      }
    }
    this.plan(themeChanged);
    this.notify();
  }

  setVisible(component: string, on: boolean): void {
    const had = this.visible.has(component);
    if (on) this.visible.add(component);
    else this.visible.delete(component);
    if (had !== on) this.plan(true);
  }

  /** The tab became visible or hidden (nothing is queued while hidden). */
  setActive(on: boolean): void {
    this.active = on;
    this.plan(true);
  }

  /** The person asked for these components' loops (Play, the detail, Render all). */
  wantLoops(components: Iterable<string>, urgent = true): void {
    for (const c of components) {
      this.loops.add(c);
      if (urgent) this.urgent.add(c);
    }
    this.plan(false);
  }

  /** "Render again": the keys of `component` whose job ended without them may be asked once more. */
  again(component: string): void {
    const i = this.items.find((x) => x.component === component);
    if (!i) return;
    for (const p of [i.poster, i.loop]) if (this.asked.get(p.key) === 'ended') this.asked.delete(p.key);
    this.urgent.add(component);
    this.plan(false);
  }

  /** An explicit Retry of a failed poster or loop: sent now with `retry: true`. */
  retry(component: string, kind: 'poster' | 'loop'): Promise<void> {
    const i = this.items.find((x) => x.component === component);
    if (!i || i[kind].state !== 'failed') return Promise.resolve();
    const key = i[kind].key;
    return this.call({ items: [{ component, [kind]: key }], retry: true });
  }

  clearError(): void {
    this.error = null;
    this.notify();
    this.plan(false);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
    this.active = false;
  }

  /** Schedule the next chunk: at once for something asked just now, else `debounceMs` after the last change (`restart`). */
  private plan(restart: boolean): void {
    const chunk = this.active && !this.busy && !this.sending && !this.error ? nextChunk(this.items, { visible: this.visible, loops: this.loops, asked: this.asked }) : [];
    if (!chunk.length) {
      this.cancel?.();
      this.cancel = null;
      return;
    }
    const now = chunk.some((c) => this.urgent.has(c.component));
    // A pending debounce keeps its time unless something changed on screen or was asked just now.
    if (this.cancel && !restart && !now) return;
    this.cancel?.();
    this.cancel = this.timer(
      () => {
        this.cancel = null;
        this.fire();
      },
      now ? RENDER_URGENT_MS : this.debounceMs,
    );
  }

  /** The debounce ran out (plan cancels it whenever the pump may not send: hidden, busy, sending, refused). */
  private fire(): void {
    const chunk = nextChunk(this.items, { visible: this.visible, loops: this.loops, asked: this.asked });
    if (!chunk.length) return;
    for (const c of chunk) this.urgent.delete(c.component);
    void this.call({ items: chunk });
  }

  private call(req: RenderRequest): Promise<void> {
    const keys = req.items.flatMap((i) => [i.poster, i.loop].filter((k): k is string => k !== undefined));
    for (const k of keys) this.asked.set(k, 'pending');
    // One call at a time: a pending debounce is dropped (planned again once this one answered).
    this.cancel?.();
    this.cancel = null;
    this.sending = true;
    this.sent.push(req);
    this.notify();
    return this.o.send(req).then(
      () => {
        this.sending = false;
        for (const k of keys) if (this.asked.get(k) === 'pending') this.asked.set(k, 'asked');
        // The screen re-reads its view now: the next chunk waits for it (busy until the job ends).
        this.busy = true;
        this.notify();
      },
      (e: unknown) => {
        this.sending = false;
        for (const k of keys) if (this.asked.get(k) === 'pending') this.asked.delete(k);
        this.error = e instanceof Error ? e.message : String(e);
        this.notify();
      },
    );
  }
}
