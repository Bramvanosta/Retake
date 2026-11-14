/**
 * Run thumbnails on the scenario screen (L4.2): asked from the Studio server (`run_thumbs`) for the rows on screen only,
 * held in this tab's memory only, shown as `data:image/jpeg;base64,…` (the CSP's `img-src data:`; never a URL from
 * data, never written anywhere).
 *
 * - `imageDataUrl` is the only way to make an image address: always a fixed prefix of its format (`data:image/jpeg`,
 *   L4.7: `data:image/png` for a library poster, `data:image/gif` for a library loop), and the payload must be plain
 *   base64 (alphabet and padding checked) within the cap of its use — a step picture's THUMB_DATA_MAX, a review's contact
 *   sheet's SHEET_DATA_MAX (L4.5 part E), a poster's POSTER_DATA_MAX, a loop's LOOP_DATA_MAX (part C's caps); a PNG or
 *   GIF payload must also decode to its magic bytes (`89 50 4E 47 0D 0A 1A 0A`, `GIF89a`). A format under another
 *   format's cap, or anything else, is refused (null), so no scheme, markup or other kind of file from an answer can
 *   reach an `<img>`. No SVG or WebP ever (critique B9: a theme's logos show in the live frame only, listed by name).
 *   `jpegDataUrl` is the JPEG case (L4.2's rule: no magic check, the server's own ffmpeg JPEGs).
 * - `ThumbLoader`: rows say when they become visible or leave (an IntersectionObserver in Thumb.tsx); every
 *   BATCH_DELAY_MS the keys on screen that are neither known nor asked for go out in calls of at most BATCH_MAX keys of
 *   one run, IN_FLIGHT_MAX calls at a time (the event stream holds one of the browser's 6 connections). A call whose
 *   rows all left the screen is aborted (the server then stops its ffmpeg). Entries are keyed by (run id, the run's own
 *   step key) — never by today's key (critique B4). A key answered `budget` (the answer's size cap) or `cancelled` is
 *   asked again while it is on screen; any other missing reason is kept and said in words.
 * - At most CACHE_MAX pictures are kept (the oldest not on screen leave first); the server keeps its own memory cache.
 */
import type { ThumbAnswer } from './data/ops.js';

export type { ThumbAnswer };

/** Keys of one `run_thumbs` call, at most (the op's own cap). */
export const BATCH_MAX = 24;
/** `run_thumbs` calls at a time, at most. */
export const IN_FLIGHT_MAX = 2;
/** Rows that became visible within this delay share a call. */
export const BATCH_DELAY_MS = 50;
/** Pictures kept in the tab. */
export const CACHE_MAX = 600;
/** One picture's base64, at most (the server's THUMB_BASE64_MAX). */
export const THUMB_DATA_MAX = 200_000;
/** One review contact sheet's base64, at most (L4.5 part E: the server's REVIEW_IMAGE_BASE64_MAX). */
export const SHEET_DATA_MAX = 2_000_000;
/** L4.7: a library poster's base64 (PNG), at most (the server's POSTER_DATA_MAX: every committed poster fits). */
export const POSTER_DATA_MAX = 280_000;
/** L4.7: a library loop's base64 (GIF), at most (the server's LOOP_DATA_MAX). */
export const LOOP_DATA_MAX = 2_000_000;
/** The caps an image may be shown under: a step's picture, a contact sheet, a library poster or loop — no other number. */
export type ImageCap = typeof THUMB_DATA_MAX | typeof SHEET_DATA_MAX | typeof POSTER_DATA_MAX | typeof LOOP_DATA_MAX;
/** The formats an image may be: no SVG, no WebP (critique B9). */
export type ImageFormat = 'jpeg' | 'png' | 'gif';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Each format's fixed prefix, the caps it may be shown under (the first is its default) and its magic bytes. */
const FORMATS: Record<ImageFormat, { prefix: string; caps: readonly number[]; magic: readonly number[] | null }> = {
  jpeg: { prefix: 'data:image/jpeg;base64,', caps: [THUMB_DATA_MAX, SHEET_DATA_MAX], magic: null },
  png: { prefix: 'data:image/png;base64,', caps: [POSTER_DATA_MAX], magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  gif: { prefix: 'data:image/gif;base64,', caps: [LOOP_DATA_MAX], magic: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
};

/** The first bytes of a base64 payload (already checked plain), or null. */
function headBytes(base64: string, n: number): number[] | null {
  try {
    const bin = atob(base64.slice(0, Math.ceil(n / 3) * 4));
    return Array.from(bin.slice(0, n), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The image address of a base64 image from the server, or null: `format` one of jpeg / png / gif, the payload plain
 * base64 within `max` — a cap of that format (a JPEG: THUMB_DATA_MAX, the default, or SHEET_DATA_MAX; a PNG:
 * POSTER_DATA_MAX; a GIF: LOOP_DATA_MAX; another number counts as the format's first cap) — and, for a PNG or a GIF,
 * starting with the format's magic bytes.
 */
export function imageDataUrl(format: ImageFormat, base64: unknown, max?: ImageCap): string | null {
  const f = Object.prototype.hasOwnProperty.call(FORMATS, format) ? FORMATS[format] : null;
  if (!f) return null;
  const cap = max !== undefined && f.caps.includes(max) ? max : f.caps[0];
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > cap || base64.length % 4 !== 0) return null;
  if (!BASE64.test(base64)) return null;
  if (f.magic) {
    const head = headBytes(base64, f.magic.length);
    if (!head || head.length < f.magic.length || f.magic.some((b, i) => head[i] !== b)) return null;
  }
  return f.prefix + base64;
}

/**
 * The image address of a base64 JPEG from the server, or null when it is not plain base64 within the cap — the step
 * pictures' (THUMB_DATA_MAX, the default) or a contact sheet's (SHEET_DATA_MAX); any other cap counts as the first.
 */
export function jpegDataUrl(base64: unknown, max: ImageCap = THUMB_DATA_MAX): string | null {
  return imageDataUrl('jpeg', base64, max);
}

export type MissingReason = 'no_step' | 'not_reached' | 'no_picture' | 'unreadable' | 'too_large' | 'budget' | 'cancelled' | 'failed';

export type ThumbEntry = { state: 'ok'; base64: string; width: number; height: number; from: string } | { state: 'missing'; reason: MissingReason };

/** One `run_thumbs` call. A rejection after `signal` aborted is a cancellation. */
export type ThumbFetch = (run: string, keys: string[], signal: AbortSignal) => Promise<ThumbAnswer>;

export interface ThumbLoaderOptions {
  fetch: ThumbFetch;
  delayMs?: number;
  batchMax?: number;
  inFlightMax?: number;
  cacheMax?: number;
  /** Timer (tests drive it by hand). */
  schedule?: (fn: () => void, ms: number) => void;
}

const sep = '\u0000';
const id = (run: string, key: string) => `${run}${sep}${key}`;
const RETRY: ReadonlySet<string> = new Set(['budget', 'cancelled']);
const REASONS: ReadonlySet<string> = new Set(['no_step', 'not_reached', 'no_picture', 'unreadable', 'too_large']);

interface Batch {
  run: string;
  ids: string[];
  ac: AbortController;
}

export class ThumbLoader {
  private readonly o: Required<Omit<ThumbLoaderOptions, 'schedule'>> & { schedule: (fn: () => void, ms: number) => void };
  private readonly entries = new Map<string, ThumbEntry>();
  /** Rows on screen per entry id (a key can show in more than one row). */
  private readonly visible = new Map<string, number>();
  private readonly asked = new Set<string>();
  private readonly batches = new Set<Batch>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private pending = false;
  private closed = false;
  /** Calls made (tests). */
  calls = 0;

  constructor(o: ThumbLoaderOptions) {
    this.o = {
      fetch: o.fetch,
      delayMs: o.delayMs ?? BATCH_DELAY_MS,
      batchMax: Math.min(o.batchMax ?? BATCH_MAX, BATCH_MAX),
      inFlightMax: o.inFlightMax ?? IN_FLIGHT_MAX,
      cacheMax: o.cacheMax ?? CACHE_MAX,
      schedule: o.schedule ?? ((fn, ms) => void setTimeout(fn, ms)),
    };
  }

  get(run: string, key: string): ThumbEntry | undefined {
    return this.entries.get(id(run, key));
  }

  /** Re-render one row when its entry changes. */
  subscribe(run: string, key: string, fn: () => void): () => void {
    const k = id(run, key);
    let set = this.listeners.get(k);
    if (!set) this.listeners.set(k, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(k);
    };
  }

  /** A row showing (run, key) came on screen (true) or left it (false). */
  setVisible(run: string, key: string, on: boolean): void {
    if (this.closed) return;
    const k = id(run, key);
    const n = (this.visible.get(k) ?? 0) + (on ? 1 : -1);
    if (n > 0) this.visible.set(k, n);
    else this.visible.delete(k);
    if (on) this.kick();
    else this.abortHidden();
  }

  /** Stop: abort every call (the screen went away). */
  close(): void {
    this.closed = true;
    for (const b of this.batches) b.ac.abort();
  }

  /** Calls in flight now (tests). */
  get inFlight(): number {
    return this.batches.size;
  }

  private notify(k: string): void {
    for (const fn of [...(this.listeners.get(k) ?? [])]) fn();
  }

  private kick(): void {
    if (this.pending || this.closed) return;
    this.pending = true;
    this.o.schedule(() => {
      this.pending = false;
      this.pump();
    }, this.o.delayMs);
  }

  /** Abort the calls none of whose rows are on screen any more. */
  private abortHidden(): void {
    for (const b of this.batches) if (!b.ids.some((k) => this.visible.has(k))) b.ac.abort();
  }

  /** The keys on screen that are neither known nor asked for, grouped by run, in the order they came on screen. */
  private wanted(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const k of this.visible.keys()) {
      if (this.entries.has(k) || this.asked.has(k)) continue;
      const run = k.slice(0, k.indexOf(sep));
      let list = out.get(run);
      if (!list) out.set(run, (list = []));
      list.push(k);
    }
    return out;
  }

  private pump(): void {
    if (this.closed) return;
    for (const [run, ids] of this.wanted()) {
      for (let i = 0; i < ids.length; i += this.o.batchMax) {
        if (this.batches.size >= this.o.inFlightMax) return;
        this.send(run, ids.slice(i, i + this.o.batchMax));
      }
    }
  }

  private send(run: string, ids: string[]): void {
    const b: Batch = { run, ids, ac: new AbortController() };
    this.batches.add(b);
    for (const k of ids) this.asked.add(k);
    this.calls++;
    const keys = ids.map((k) => k.slice(k.indexOf(sep) + 1));
    this.o.fetch(run, keys, b.ac.signal).then(
      (a) => this.answer(b, a),
      () => this.done(b, b.ac.signal.aborted ? undefined : 'failed'),
    );
  }

  private set(k: string, e: ThumbEntry): void {
    this.entries.delete(k);
    this.entries.set(k, e);
    this.notify(k);
  }

  private answer(b: Batch, a: ThumbAnswer): void {
    if (b.ac.signal.aborted) return this.done(b, undefined);
    const seen = new Set<string>();
    for (const t of Array.isArray(a?.thumbs) ? a.thumbs : []) {
      const k = id(b.run, String(t.key));
      if (!b.ids.includes(k) || seen.has(k)) continue;
      seen.add(k);
      const w = Number(t.width);
      const h = Number(t.height);
      if (jpegDataUrl(t.base64) !== null && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096)
        this.set(k, { state: 'ok', base64: t.base64, width: w, height: h, from: String(t.from) });
      else this.set(k, { state: 'missing', reason: 'unreadable' });
    }
    let retry = 0;
    for (const m of Array.isArray(a?.missing) ? a.missing : []) {
      const k = id(b.run, String(m.key));
      if (!b.ids.includes(k) || seen.has(k)) continue;
      seen.add(k);
      if (RETRY.has(m.reason)) retry++;
      else this.set(k, { state: 'missing', reason: REASONS.has(m.reason) ? (m.reason as MissingReason) : 'unreadable' });
    }
    // An answer that brought nothing but `budget` / `cancelled` must not loop: those keys are given up on.
    const nothing = retry > 0 && retry === seen.size && seen.size === b.ids.length;
    this.done(b, nothing ? 'failed' : undefined);
  }

  /** The call ended: unanswered keys become `reason` (or are asked again later); the oldest pictures off screen leave. */
  private done(b: Batch, reason: MissingReason | undefined): void {
    this.batches.delete(b);
    for (const k of b.ids) {
      this.asked.delete(k);
      if (reason && !this.entries.has(k)) this.set(k, { state: 'missing', reason });
    }
    this.trim();
    this.kick();
  }

  private trim(): void {
    if (this.entries.size <= this.o.cacheMax) return;
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.o.cacheMax) break;
      if (!this.visible.has(k)) {
        this.entries.delete(k);
        this.notify(k);
      }
    }
  }
}
