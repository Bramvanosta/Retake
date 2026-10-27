/**
 * The Comments screen's words and rules (L4.6 part D1; R-UI-27, R-UI-29; plan D3–D5 as amended by the critique), pure —
 * no React, no call: channel and status words, the anchor chips, the region a drag or the four % fields make (critique
 * B11: rounded to 4 decimals, then clamped inside the frame; a click is no region), a typed timecode as a frame (the
 * CLI's `--at` rule), the keys of the viewer, and the frame requests (FrameRequests: one in flight per tab, the newest
 * frame wins, a 429 backs off, a 409 `cancelled` is ignored).
 *
 * Every word made here is the tool's own or a trusted field (ids checked by pattern on the server: core trustedAnchor,
 * "unknown" for any other shape); text a person or an agent wrote never passes through here — the screen shows it
 * through Txt. A channel (`via`) says how an entry was written, never who typed it: `studio` is the Studio page, which
 * any program holding its session token could drive.
 */
import type { FrameCommentAnchor } from '@demo-studio/core';
import type { KeyTarget } from './timeline-words.js';

export type Via = 'cli' | 'studio' | 'mcp';

/** A channel in words: Terminal / Studio / Agent · MCP (an unknown value: "unknown channel"). */
export function channelWords(via: string | undefined): string {
  return via === 'cli' ? 'Terminal' : via === 'studio' ? 'Studio' : via === 'mcp' ? 'Agent · MCP' : 'unknown channel';
}

/** What a channel means, said once on the screen (honest wording: a channel, not a proof of a person). */
export const CHANNEL_NOTE = 'Terminal, Studio and Agent · MCP name how an entry was written, not who typed it: Studio means this Studio page (or a program holding its session token).';

/** A thread's status as a word. */
export function statusWords(status: string): 'Open' | 'Resolved' {
  return status === 'resolved' ? 'Resolved' : 'Open';
}

/** An entry's kind as a verb. */
export function entryWords(kind: string): string {
  switch (kind) {
    case 'reply':
      return 'replied';
    case 'resolve':
      return 'resolved it';
    case 'reopen':
      return 'reopened it';
    case 'apply':
      return 'applied a proposal';
    default:
      return 'wrote';
  }
}

/** A proposal's state as a badge's words (B4: undone is actionable again). */
export function proposalWords(state: string): string {
  switch (state) {
    case 'pending':
      return 'Proposal pending';
    case 'undone':
      return 'Applied, then undone';
    case 'applied':
      return 'Applied';
    case 'superseded':
      return 'Proposal superseded';
    case 'stale':
      return 'Proposal stale';
    default:
      return 'Proposal';
  }
}

/** "v3", "v3 vertical" of a render id (the id itself when it is not one). */
export function renderWords(renderId: string): string {
  const m = /-v(\d+)(?:-(vertical|square))?$/.exec(renderId);
  return m ? `v${m[1]}${m[2] ? ` ${m[2]}` : ''}` : renderId;
}

// ── Regions ─────────────────────────────────────────────────────────────────

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drag shorter than this (a share of the frame) on either side is a click: no region. */
export const REGION_MIN = 0.005;

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * A region as the server takes it (critique B11): each value rounded to 4 decimals, the corner kept inside the frame,
 * then the width and height clamped after rounding so x + w ≤ 1 and y + h ≤ 1 — or null when nothing is left (a side
 * of 0, a value that is not a number).
 */
export function clampRegion(r: Region): Region | null {
  if (![r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const x = round4(clamp01(r.x));
  const y = round4(clamp01(r.y));
  const w = Math.min(round4(clamp01(r.w)), round4(1 - x));
  const h = Math.min(round4(clamp01(r.h)), round4(1 - y));
  if (!(w > 0) || !(h > 0)) return null;
  return { x, y, w, h };
}

/** A point of the pointer as a share of the image's box (getBoundingClientRect: the picture itself), clamped to it. */
export function pointIn(box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): { x: number; y: number } {
  if (!(box.width > 0) || !(box.height > 0)) return { x: 0, y: 0 };
  return { x: clamp01((clientX - box.left) / box.width), y: clamp01((clientY - box.top) / box.height) };
}

/** The region of a drag from `a` to `b` (shares of the frame, any direction), or null for a click (a side under REGION_MIN). */
export function regionOfDrag(a: { x: number; y: number }, b: { x: number; y: number }): Region | null {
  const x0 = clamp01(Math.min(a.x, b.x));
  const y0 = clamp01(Math.min(a.y, b.y));
  const w = clamp01(Math.max(a.x, b.x)) - x0;
  const h = clamp01(Math.max(a.y, b.y)) - y0;
  if (w < REGION_MIN || h < REGION_MIN) return null;
  return clampRegion({ x: x0, y: y0, w, h });
}

/** Two regions with the same numbers (or both none). */
export function sameRegion(a: Region | null, b: Region | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** The four % fields (left, top, width, height) of a region, to 2 decimals. */
export interface RegionFields {
  x: string;
  y: string;
  w: string;
  h: string;
}

const pct = (v: number) => String(Math.round(v * 10_000) / 100);

export function fieldsOf(r: Region | null): RegionFields {
  return r ? { x: pct(r.x), y: pct(r.y), w: pct(r.w), h: pct(r.h) } : { x: '', y: '', w: '', h: '' };
}

/** The region the four % fields say, clamped (B11), or null (a field empty or not a number, a side of 0). */
export function regionOfFields(f: RegionFields): Region | null {
  const vals = [f.x, f.y, f.w, f.h].map((s) => (s.trim() === '' ? NaN : Number(s)));
  if (!vals.every(Number.isFinite)) return null;
  const [x, y, w, h] = vals.map((v) => v / 100) as [number, number, number, number];
  return clampRegion({ x, y, w, h });
}

/** "from 12 % left, 30 % top, 40 % × 20 % of the frame". */
export function regionWords(r: Region | undefined | null): string {
  if (!r) return 'the whole frame';
  const p = (v: number) => `${Math.round(v * 1000) / 10} %`;
  return `from ${p(r.x)} left, ${p(r.y)} top, ${p(r.w)} × ${p(r.h)} of the frame`;
}

// ── Anchor chips ────────────────────────────────────────────────────────────

export interface Chip {
  /** What the chip names (Frame, Segment, Step…), also its test id. */
  kind: 'frame' | 'segment' | 'step' | 'component' | 'marker' | 'page' | 'transition' | 'overlays';
  label: string;
  words: string;
  /** A second line (where the step is today), when it says something. */
  note?: string;
}

/**
 * The chips of an anchor (plan D3): frame and timecode, segment, step (and where it is in today's file), component,
 * marker, page, transition, overlays — trusted fields only (the server checked each id: "unknown" otherwise).
 * `step_now`: null = not in today's file; undefined = the frame shows no step.
 */
export function anchorChips(a: { frame: number; timecode: string; anchor: FrameCommentAnchor; step_now?: string | null }): Chip[] {
  const n = a.anchor;
  const chips: Chip[] = [{ kind: 'frame', label: 'Frame', words: `${a.frame.toLocaleString('en')} · ${a.timecode}` }];
  chips.push({ kind: 'segment', label: 'Segment', words: `${n.kind} ${n.segment}` });
  if (n.scene !== undefined && n.step !== undefined) {
    const ref = n.step_ref ?? `${n.scene}.${n.step}`;
    const note = a.step_now === null ? "not in today's file" : a.step_now !== undefined && a.step_now !== ref ? `now ${a.step_now}` : undefined;
    chips.push({ kind: 'step', label: 'Step', words: `${ref}${n.action ? ` · ${n.action}` : ''}`, ...(note ? { note } : {}) });
  }
  if (n.area !== undefined || n.component !== undefined) {
    chips.push({ kind: 'component', label: 'Component', words: [n.area ? `area ${n.area}` : '', n.component ?? ''].filter(Boolean).join(' · ') });
  }
  if (n.marker !== undefined) chips.push({ kind: 'marker', label: 'Marker', words: n.marker });
  if (n.page !== undefined) chips.push({ kind: 'page', label: 'Page', words: n.page });
  if (n.transition) chips.push({ kind: 'transition', label: 'Transition', words: `${n.transition.kind} ${n.transition.from ?? '?'} → ${n.transition.to ?? '?'}` });
  if (n.overlays?.length) chips.push({ kind: 'overlays', label: 'Overlays', words: n.overlays.join(', ') });
  return chips;
}

/** Where a thread points, in a few words (a list item): its step, else its segment. */
export function whereWords(a: FrameCommentAnchor): string {
  if (a.scene !== undefined && a.step !== undefined) return `step ${a.step_ref ?? `${a.scene}.${a.step}`}`;
  return `${a.kind} ${a.segment}`;
}

// ── Time ────────────────────────────────────────────────────────────────────

/** "00:12.40" of a frame: minutes and seconds to 1/100 s, as the engine writes a thread's timecode. */
export function frameTime(frame: number, fps: number): string {
  const cs = Math.max(0, Math.round((frame / (fps > 0 ? fps : 30)) * 100));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/**
 * The time field's example: a time inside the render shown (two thirds in, to 1/10 s, in frameTime's format) — never a
 * time past its end, which the field would refuse.
 */
export function timeExample(frames: number, fps: number): string {
  const f = fps > 0 ? fps : 30;
  const tenths = Math.floor(((Math.max(0, frames - 1) / f) * 2 * 10) / 3);
  return frameTime((tenths / 10) * f, f);
}

/**
 * A typed time as a frame of the render (the CLI's `--at` rule: the frame on screen at that time — floor of time × fps;
 * the very end of the video is its last frame): "12.4", "0:12.40", "00:12.40", "1:02:03.5". Null with why otherwise.
 */
export function parseTimecode(text: string, fps: number, frames: number): { frame: number } | { error: string } {
  const t = text.trim();
  const m = /^(?:(?:(\d{1,3}):)?(\d{1,3}):)?(\d+(?:\.\d+)?|\.\d+)$/.exec(t);
  if (!m) return { error: 'a time like 12.4 or 0:12.40' };
  const h = m[1] !== undefined && m[2] !== undefined ? Number(m[1]) : 0;
  const min = m[2] !== undefined ? Number(m[2]) : 0;
  const s = Number(m[3]);
  if (m[2] !== undefined && s >= 60) return { error: 'seconds under 60 after the minutes' };
  if (m[1] !== undefined && min >= 60) return { error: 'minutes under 60 after the hours' };
  const seconds = h * 3600 + min * 60 + s;
  let frame = Math.floor(seconds * fps + 1e-6);
  const duration = frames / fps;
  if (frame >= frames && seconds <= Math.max(duration, Number(duration.toFixed(2))) + 1e-9) frame = frames - 1;
  if (frame < 0 || frame >= frames) return { error: `the render is ${frameTime(frames, fps)} long` };
  return { frame };
}

// ── Keys ────────────────────────────────────────────────────────────────────

/** Typing (an input but the slider, a text area, a select, an editable element) or in a radio group: no screen key. */
function typing(t: KeyTarget, rangeIsTyping: boolean): boolean {
  const tag = t.tag.toLowerCase();
  if (t.editable || tag === 'textarea' || tag === 'select' || t.inRadioGroup) return true;
  if (tag === 'input') return rangeIsTyping || t.type !== 'range';
  return false;
}

/**
 * The viewer's keys: ← / → one frame, Shift+← / → one second — never while typing or in a radio group, and not on the
 * slider (its own arrows move it: no double step). The frames to move by, or null.
 */
export function viewerKey(e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, t: KeyTarget, fps: number): number | null {
  if (e.altKey || e.ctrlKey || e.metaKey || typing(t, true)) return null;
  const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!dir) return null;
  return e.shiftKey ? dir * Math.max(1, Math.round(fps)) : dir;
}

/** The timeline's C (comment at the playhead): never while typing or in a radio group, no modifier. */
export function commentKey(e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, t: KeyTarget): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return (e.key === 'c' || e.key === 'C') && !typing(t, false);
}

// ── Frame requests ──────────────────────────────────────────────────────────

/** A frame of a render as the page shows it (its id and created_at: a reused id is another render). */
export interface FrameAsk {
  render_id: string;
  created_at: string;
  frame: number;
}

export interface FrameFailure {
  status: number;
  code: string;
  message: string;
}

export type FrameOutcome<T> = { ask: FrameAsk; ok: true; data: T } | { ask: FrameAsk; ok: false; error: FrameFailure };

export interface FrameRequestsOptions<T> {
  /** One render_frame call (rejects with a FrameFailure-like error: status and code). */
  fetch(ask: FrameAsk, signal: AbortSignal): Promise<T>;
  /** The newest frame asked, answered (an older answer is dropped). */
  onResult(r: FrameOutcome<T>): void;
  /** Timer (tests drive it by hand); returns a cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The first wait after a 429 (the server's Retry-After: 1 s); doubled up to BACKOFF_MAX_MS. */
  backoffMs?: number;
}

export const BACKOFF_MAX_MS = 8000;
/**
 * Waits before a frame that keeps failing is said (review B L3): a full queue (429) is asked again this many times
 * (1 + 2 + 4 + 8 s), a timeout (503, reason `timeout`: the frame took the server's whole 15 s) once.
 */
export const FRAME_RETRIES = { busy: 4, timeout: 1 } as const;

const sameAsk = (a: FrameAsk | null, b: FrameAsk | null) => !!a && !!b && a.render_id === b.render_id && a.created_at === b.created_at && a.frame === b.frame;

/**
 * The viewer's frame requests (plan D2, critique B7; part C's contract): at most ONE render_frame call in flight per
 * tab; while it runs only the newest frame asked is kept (the slider moves: no queue), and it is sent when the call
 * ends; an answer for a frame no longer wanted is dropped. A 429 (`busy`: the server's queue is full) waits — 1 s,
 * then longer — and asks the newest frame again, up to FRAME_RETRIES.busy times; a 503 timeout once; then the failure is
 * said (review B L3). A 409 `cancelled` (superseded by this tab's own newer request) is ignored; any other failure is
 * said for the newest frame.
 */
export class FrameRequests<T> {
  private wanted: FrameAsk | null = null;
  private inFlight: FrameAsk | null = null;
  private ac: AbortController | null = null;
  private waiting: (() => void) | null = null;
  private backoff: number;
  /** Waits in a row since the last answer said (FRAME_RETRIES). */
  private retries = 0;
  private closed = false;
  private readonly schedule: (fn: () => void, ms: number) => () => void;

  constructor(private readonly o: FrameRequestsOptions<T>) {
    this.backoff = o.backoffMs ?? 1000;
    this.schedule =
      o.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
  }

  /** Calls in flight now (0 or 1). */
  get busy(): number {
    return this.inFlight ? 1 : 0;
  }

  /** Ask for a frame: it replaces any frame still waiting to be sent. */
  want(ask: FrameAsk): void {
    if (this.closed) return;
    this.wanted = { ...ask };
    this.pump();
  }

  /** Stop: the call in flight is aborted, nothing more is sent or answered. */
  close(): void {
    this.closed = true;
    this.waiting?.();
    this.waiting = null;
    this.ac?.abort();
  }

  private pump(): void {
    if (this.closed || this.inFlight || this.waiting || !this.wanted) return;
    const ask = this.wanted;
    this.inFlight = ask;
    const ac = new AbortController();
    this.ac = ac;
    this.o.fetch(ask, ac.signal).then(
      (data) => this.done(ask, { ask, ok: true, data }),
      (e: unknown) => this.done(ask, { ask, ok: false, error: failureOf(e) }),
    );
  }

  private done(ask: FrameAsk, r: FrameOutcome<T>): void {
    this.inFlight = null;
    this.ac = null;
    if (this.closed) return;
    const retry = !r.ok && (r.error.status === 429 ? FRAME_RETRIES.busy : r.error.status === 503 && r.error.code === 'unavailable' ? FRAME_RETRIES.timeout : 0);
    if (retry && this.retries < retry) {
      // Busy (or too slow once): wait, then ask the newest frame again (it may have moved meanwhile).
      this.retries++;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      this.waiting = this.schedule(() => {
        this.waiting = null;
        this.pump();
      }, wait);
      return;
    }
    // Answered, or failing past its retries: said for the newest frame (a frame that keeps failing is never silent).
    this.backoff = this.o.backoffMs ?? 1000;
    this.retries = 0;
    const current = sameAsk(ask, this.wanted);
    if (current) this.wanted = null;
    // Superseded by this tab's own newer request: nothing to say.
    const cancelled = !r.ok && r.error.status === 409 && r.error.code === 'cancelled';
    if (current && !cancelled) this.o.onResult(r);
    this.pump();
  }
}

function failureOf(e: unknown): FrameFailure {
  const x = e as { status?: unknown; error?: { code?: unknown; message?: unknown }; message?: unknown } | null;
  const status = typeof x?.status === 'number' ? x.status : 0;
  const code = typeof x?.error?.code === 'string' ? x.error.code : 'failed';
  const message = typeof x?.error?.message === 'string' ? x.error.message : typeof x?.message === 'string' ? x.message : 'the frame could not be read';
  return { status, code, message };
}

/** A random session id for render_frame (22 base64url characters; one per tab: its newest request wins on the server). */
export function newSessionId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = random(16);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The comment text's limit (core COMMENT_TEXT_MAX: the server's cap on one untrusted string). */
export const COMMENT_TEXT_MAX = 2000;

/** "12 characters left", said politely (never past the cap: the textarea's maxLength holds it). */
export function charactersLeft(text: string): string {
  const n = COMMENT_TEXT_MAX - text.length;
  return `${n.toLocaleString('en')} ${n === 1 ? 'character' : 'characters'} left`;
}

// ── Proposals (part D2) ─────────────────────────────────────────────────────

/** Past this share of the file a proposal says it is a rewrite (core PROPOSAL_REWRITE_NOTE_PCT; T13 checks they agree). */
export const REWRITE_NOTE_PCT = 25;

/**
 * A piece of a diff line as the screen draws it (critique B1: what the person reads is what Apply writes):
 * - `text`: characters drawn as they are (in a monospace, left-to-right isolated cell; spaces inside kept);
 * - `space`: a run of leading or trailing spaces, drawn one `·` each (YAML's meaning is indentation; a trailing space
 *   changes the bytes) — so an indentation-only or a trailing-space change is two visibly different rows;
 * - `tab`: a tab, drawn `→`;
 * - `char`: a character the eye cannot see or tell from a space, drawn `[U+…]` — controls, format and default-
 *   ignorable characters (core's hidden class: direction controls included, so no line reorders the ones around it),
 *   line / paragraph separators, the Hangul fillers, the braille blank, and every space but U+0020 (a no-break space
 *   looks like a space). A zero-width joiner between two pictographs and a variation selector after an emoji are left
 *   in the text (an emoji sequence, as core's write rules allow); and every combining mark past the
 *   COMBINING_MARKS_SHOWN-th on one character (review A L6: a stack of marks draws as ink over the rows around it, and
 *   hundreds of them read as one letter).
 */
export type LinePiece = { kind: 'text'; text: string } | { kind: 'space'; count: number } | { kind: 'tab' } | { kind: 'char'; code: string };

/** Core's hidden class (scenario-edit.ts HIDDEN_G), and every space separator but U+0020. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\p{Default_Ignorable_Code_Point}ᅟᅠ⠀ㅤﾠ]/u;
const PICTO = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{fe0f}]/u;
const EMOJI = /\p{Emoji}/u;

/** "U+202E" of a character (code point, at least 4 hex digits). */
export function codeOf(c: string): string {
  return `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Combining marks drawn on one character, at most: the next ones are drawn `[U+…]` (review A L6). */
export const COMBINING_MARKS_SHOWN = 3;
const MARK = /\p{M}/u;
/** A strong right-to-left letter (Hebrew, Arabic, Syriac, Thaana, N'Ko… and their presentation forms, the RTL planes). */
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u;

/**
 * A line holds right-to-left letters (review A L6): the diff draws it in byte order, left to right (bidi override), and
 * says so — an editor shows such a line in another order.
 */
export function hasRtl(line: string): boolean {
  return RTL.test(line);
}

/** The pieces of one line of a diff (a stored line, or a line of the file: never with its line break). */
export function linePieces(line: string): LinePiece[] {
  const chars = Array.from(line);
  const out: LinePiece[] = [];
  let lead = 0;
  while (lead < chars.length && chars[lead] === ' ') lead++;
  let trail = 0;
  while (trail < chars.length - lead && chars[chars.length - 1 - trail] === ' ') trail++;
  if (lead) out.push({ kind: 'space', count: lead });
  let text = '';
  const flush = () => {
    if (text) out.push({ kind: 'text', text });
    text = '';
  };
  let marks = 0;
  for (let i = lead; i < chars.length - trail; i++) {
    const c = chars[i];
    marks = MARK.test(c) ? marks + 1 : 0;
    if (marks > COMBINING_MARKS_SHOWN) {
      flush();
      out.push({ kind: 'char', code: codeOf(c) });
      continue;
    }
    if (c === '\t') {
      flush();
      out.push({ kind: 'tab' });
      continue;
    }
    if (c !== ' ' && UNSEEN.test(c)) {
      const prev = chars[i - 1] ?? '';
      const next = chars[i + 1] ?? '';
      // An emoji sequence: a variation selector after an emoji, a joiner between two pictographs.
      const sequence = ((c === '️' || c === '︎') && i > 0 && EMOJI.test(prev)) || (c === '‍' && PICTO.test(prev) && PICTO.test(next));
      if (!sequence) {
        flush();
        out.push({ kind: 'char', code: codeOf(c) });
        continue;
      }
    }
    text += c;
  }
  flush();
  if (trail) out.push({ kind: 'space', count: trail });
  return out;
}

/** The line as the screen draws it, in one string (tests; a title): `·` per edge space, `→` per tab, `[U+…]` per unseen character. */
export function lineShown(line: string): string {
  return linePieces(line)
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'space' ? '·'.repeat(p.count) : p.kind === 'tab' ? '→' : `[${p.code}]`))
    .join('');
}

/** A row of the engine's diff (ProposalRow) and its text (untrusted.rows[i]). */
export interface DiffRowIn {
  kind: 'context' | 'del' | 'add' | 'gap';
  base?: number;
  line?: number;
  count?: number;
}

/** A diff row as the table draws it: the gutter sign, the word a screen reader says, the line numbers, the pieces. */
export interface DiffRowView {
  kind: DiffRowIn['kind'];
  sign: '+' | '−' | '' | '…';
  word: string;
  base: number | null;
  line: number | null;
  pieces: LinePiece[];
  /** The line holds right-to-left letters: drawn in byte order, said so (hasRtl). */
  rtl: boolean;
}

const whole = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null);

/** The table's rows (rows[i] ↔ texts[i]; a missing text is an empty line; a gap says how many unchanged lines it leaves out). */
export function diffRowsView(rows: readonly DiffRowIn[], texts: readonly string[]): DiffRowView[] {
  return rows.map((r, i) => {
    const text = typeof texts[i] === 'string' ? texts[i] : '';
    switch (r.kind) {
      case 'add':
        return { kind: 'add', sign: '+', word: 'added', base: null, line: whole(r.line), pieces: linePieces(text), rtl: hasRtl(text) };
      case 'del':
        return { kind: 'del', sign: '−', word: 'removed', base: whole(r.base), line: null, pieces: linePieces(text), rtl: hasRtl(text) };
      case 'gap': {
        const n = whole(r.count) ?? 0;
        return { kind: 'gap', sign: '…', word: `${n.toLocaleString('en')} unchanged ${n === 1 ? 'line' : 'lines'} not shown`, base: null, line: null, pieces: [], rtl: false };
      }
      default:
        return { kind: 'context', sign: '', word: 'unchanged', base: whole(r.base), line: whole(r.line), pieces: linePieces(text), rtl: hasRtl(text) };
    }
  });
}

/** "1 line added, 1 removed, in 1 place" (read first, before the table). */
export function proposalSummary(p: { added: number; removed: number; hunks: number }): string {
  const n = (v: number, one: string, many = `${one}s`) => `${v.toLocaleString('en')} ${v === 1 ? one : many}`;
  return `${n(p.added, 'line')} added, ${p.removed.toLocaleString('en')} removed, in ${n(p.hunks, 'place')}`;
}

/** The rewrite note (critique B13), past REWRITE_NOTE_PCT of the file; null otherwise. */
export function rewriteNote(pct: number | undefined): string | null {
  if (typeof pct !== 'number' || !(pct > REWRITE_NOTE_PCT)) return null;
  return `This proposal rewrites ${Math.round(pct)} % of the file: read every line — one real change can hide in a rewrite. Ask Claude for the smallest change if it should not.`;
}

/** What the server offers for a proposal (comment-ops ProposalOffer). */
export interface Offer {
  apply: boolean;
  preview: boolean;
  apply_render: boolean;
  why?: string;
}

export type ProposalButton = 'apply' | 'preview' | 'apply_render';

/**
 * The proposal's buttons — from the server's `offer` ONLY (the state, the take, the variant, the theme and the overrides
 * are decided there): Apply ⇐ apply, Preview change ⇐ preview, Apply and re-render ⇐ apply_render, each only for a
 * literal true; `why` is said whenever something is not offered (the server's words).
 */
export function proposalButtons(offer: Offer | undefined | null): { buttons: ProposalButton[]; why: string | null } {
  if (!offer || typeof offer !== 'object') return { buttons: [], why: 'Nothing can be done with this proposal now' };
  const buttons: ProposalButton[] = [];
  if (offer.apply === true) buttons.push('apply');
  if (offer.preview === true) buttons.push('preview');
  if (offer.apply_render === true) buttons.push('apply_render');
  const all = buttons.length === 3;
  const why = typeof offer.why === 'string' && offer.why !== '' ? offer.why : all ? null : buttons.length === 0 ? 'Nothing can be done with this proposal now' : null;
  return { buttons, why };
}

/**
 * What the page says after an apply that went through (review B M2): its problems (the apply entry not recorded…) and
 * the scenario's validation warnings for the text written; null when there is nothing to say.
 */
export function appliedWords(a: { warnings?: readonly unknown[]; problems?: readonly unknown[] }): { tone: 'warning'; words: string } | null {
  const problems = (Array.isArray(a.problems) ? a.problems : []).filter((x): x is string => typeof x === 'string' && x !== '');
  const warnings = (Array.isArray(a.warnings) ? a.warnings : []).map((w) => (w && typeof w === 'object' && typeof (w as { message?: unknown }).message === 'string' ? (w as { message: string }).message : null));
  if (!problems.length && !warnings.length) return null;
  const lines: string[] = [];
  if (problems.length) lines.push(`Applied, but: ${problems.join(' ')}`);
  if (warnings.length) {
    const named = warnings.filter((w): w is string => w !== null).slice(0, 3);
    lines.push(`${problems.length ? 'The' : 'Applied. The'} scenario has ${warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}${named.length ? `: ${named.join(' · ')}` : ''}${warnings.length > named.length ? ' …' : ''}`);
  }
  return { tone: 'warning', words: lines.join('\n') };
}

/** What thread_apply answered and Undo apply / the render after it need (comment-ops ThreadApplyAnswer, in part). */
export interface Applied {
  scenario: { name: string; hash: string; previous: { text: string; hash: string } };
}

/** Undo apply: scenario_edit `restore` of what was there before the apply, on the hash the apply wrote. */
export function undoEditArgs(project: string, a: Applied): { project: string; name: string; hash: string; edit: { kind: 'restore'; text: string; text_hash: string } } {
  return { project, name: a.scenario.name, hash: a.scenario.hash, edit: { kind: 'restore', text: a.scenario.previous.text, text_hash: a.scenario.previous.hash } };
}

/** Undo is offered while today's file is still what the apply wrote (another write since: nothing to undo here). */
export function canUndo(a: Applied | null | undefined, todaySha256: string | null | undefined): boolean {
  return !!a && typeof todaySha256 === 'string' && todaySha256 === a.scenario.hash;
}

/** Apply and re-render: scenario_render of the thread's take on the exact file the apply wrote (expect_edit_sha256). */
export function renderAfterApplyArgs(project: string, a: Applied, runId: string): { project: string; name: string; run: string; expect_edit_sha256: string } {
  return { project, name: a.scenario.name, run: runId, expect_edit_sha256: a.scenario.hash };
}
