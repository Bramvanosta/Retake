/**
 * The Run screen's stream (L4.4, R-UI-16 – R-UI-18): `POST /v1/live {project, run_id, after?, frames?}` — server-sent
 * events read by the page through `fetch` (the token in a header, the run in the JSON body: no id in a URL or a log),
 * behind the same gate as every route. One stream follows one run:
 *
 * - **Steps and log** come from the run's own `log.jsonl` (every progress event, redacted by the runner — a job's run
 *   and a terminal's `retake run` alike) and, for a job's run, the worker's notes of its `events.jsonl` — tailed while
 *   the stream is open and never otherwise: a stat-and-read every RUN_LIVE_POLL_MS from byte offsets, through the
 *   run-file rules of L4.2 (RunFolder: no link followed, no FIFO held, checked once open), at most LIVE_READ_CHUNK
 *   bytes per read, a line longer than LIVE_LINE_MAX skipped with a note (never a buffer without a bound). An event's
 *   `seq` is the byte offset of its line's end in its file; `after: {log, job}` resumes after a reconnect without a
 *   duplicate. On connect: one `snapshot` (the events since `after`, else since the start — at most the last
 *   LIVE_TAIL_MAX bytes of a long log, said so — with the log lines cut to the last LIVE_SNAPSHOT_LOG_LINES), then
 *   `progress` events, `job` (its state, a pause or a stop asked) on change, and `end` once the run and its job ended.
 * - **Events are a view**, never raw RunProgress: every field type-checked (the files are data an agent could have
 *   written), unknown events dropped, no path field (a RunRecord's `dir`, outputs, screenshots), every text capped at
 *   LIVE_TEXT_MAX characters with the workspace and home folders replaced (`<workspace>`, `~`), the filmed site's and
 *   the hooks' text (step and log messages, session details, hook messages, errors, warnings) under `untrusted`: the
 *   page renders it as text, never as a link or HTML.
 * - **The live picture** of a job's run: frames from the worker's live channel (engine live-channel.ts) — ONE upstream
 *   per job whatever the number of page streams (the worker serves 2), opened only while a page stream wants frames
 *   and closed when none does (a hidden tab drops its stream, the picture toggled off reopens it with `frames: false`);
 *   a capture's stream carries frames only when the page asked for them (`frames: true`: the picture costs Chromium CPU
 *   during a take), a dry run's unless it said `frames: false`. Latest-only on this hop too: a frame is written only
 *   when the page's socket needs no drain, else it replaces the one waiting frame. Frames live in memory only (the
 *   upstream's current frame, dropped when it closes): never written, logged or put in an event file; `event: frame`
 *   carries the JPEG as base64 for a canvas (createImageBitmap — no CSP change, no `src=`). `picture` events say what
 *   the picture is doing: off, none (a terminal's run, or ended), waiting, live, busy (the worker serves no more).
 * - At most RUN_LIVE_STREAMS_MAX streams (with the event stream and calls, below a browser's 6 connections per host); a
 *   third gets 503 `too_many_streams`. A stream is never an op: the op counter does not move.
 *
 * Nothing here logs a token, a body, a frame or a line of the files it reads.
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { SLUG_RE } from '@retake/core/model';
import { zRunId } from '@retake/core/ids';
import { PROJECT_SLUG_RE } from '@retake/core/project';
import { JOB_STATES } from '@retake/engine';
import type { JobState } from '@retake/engine';
import { ERROR_STATUS, EngineError, FINISHED_JOB_STATES, RunFolder, openLiveFeed, openProjectBySlug, readLiveChannel, readPlainRange, securityHeaders, toEngineError } from '@retake/engine';
import type { Engine, JobFiles, JobQueueView, LiveFeedFrame, RangeRead, OpenedWorkspace } from '@retake/engine';
import { sseText } from './live.js';
import { bestEffort } from '@retake/core/base';

/** Run streams served at once, at most. */
export const RUN_LIVE_STREAMS_MAX = 2;
/** How often an open stream reads the run's files (ms). */
export const RUN_LIVE_POLL_MS = 300;
/** Bytes read from one file per read, at most. */
export const LIVE_READ_CHUNK = 256 * 1024;
/** A line of log.jsonl / events.jsonl longer than this is skipped (with a note). */
export const LIVE_LINE_MAX = 64 * 1024;
/** On connect, a log longer than this is read from its last LIVE_TAIL_MAX bytes. */
export const LIVE_TAIL_MAX = 8 * 1024 * 1024;
/** Log lines a snapshot carries, at most (the newest). */
export const LIVE_SNAPSHOT_LOG_LINES = 500;
/** A text field of an event, at most (characters). */
export const LIVE_TEXT_MAX = 2000;
/** Steps an outline carries, at most. */
export const LIVE_OUTLINE_MAX = 5000;
/** Warnings a run_end carries, at most. */
const WARNINGS_MAX = 20;
/** A comment line on every run stream this often (ms). */
const KEEPALIVE_MS = 15_000;
/** How long the upstream waits before trying the job's channel again (ms). */
const FEED_RETRY_MS = 1000;
/** After `run_end`, how long a stream waits for the job to finish before it ends anyway (ms). */
const END_GRACE_MS = 10_000;
/** Bytes read per poll and file, at most (a stream catches up over several polls). */
const POLL_READ_MAX = 8 * LIVE_READ_CHUNK;

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug, never a path');
const runId = zRunId('a run id, never a path');
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The body of `POST /v1/live`. */
export const RunLiveInput = z.strictObject({
  project,
  run_id: runId,
  /** The last `seq` of each source the page holds (a reconnect): the snapshot then carries only what came after. */
  after: z.strictObject({ log: offset, job: offset.optional() }).optional(),
  /** The live picture: default on for a dry run, off for a capture (the page asks for it with true). */
  frames: z.boolean().optional(),
});

export type PictureState = 'off' | 'none' | 'waiting' | 'live' | 'busy' | 'ended';

/** One event of the view: its source file, the byte offset of its line's end there, and the reduced event. */
export interface LiveItem {
  src: 'log' | 'job';
  seq: number;
  ev: Record<string, unknown>;
}

// ─── reading a growing JSON-lines file from byte offsets ─────────────────────────────────────────────────────────────

/** Lines of a growing file, from a byte offset: complete lines only, each with the offset of its end. */
export class JsonlTail {
  private partial: Buffer[] = [];
  private partialLen = 0;
  /** In a line to drop up to its end: one longer than LIVE_LINE_MAX (said in a note), or the cut line at a tail start. */
  private skipping: 'long' | 'cut' | null;
  /** Where the next read starts. */
  private next: number;
  /** The end of the last complete line handed out. */
  cursor: number;
  /** The read failed for a reason other than "not there yet" (a link, not a file): no further read. */
  broken: string | null = null;

  constructor(
    private readonly read: (offset: number, max: number) => RangeRead | { ok: false; reason: string },
    start: number,
    /** True when `start` may fall inside a line (a tail start): its rest is dropped. */
    cut = false,
  ) {
    this.next = start;
    this.cursor = start;
    this.skipping = cut ? 'cut' : null;
  }

  /** New complete lines (at most `budget` bytes read); `notes` says what was skipped. */
  pull(budget: number): { lines: Array<{ text: string; end: number }>; notes: string[]; size: number | null } {
    const lines: Array<{ text: string; end: number }> = [];
    const notes: string[] = [];
    let size: number | null = null;
    while (!this.broken && budget > 0) {
      const r = this.read(this.next, Math.min(LIVE_READ_CHUNK, budget));
      if (!r.ok) {
        if (r.reason !== 'missing') this.broken = r.reason;
        break;
      }
      size = r.size;
      if (r.size < this.next) {
        // The file is shorter than what was read: it was replaced — nothing of it is trusted to line up any more.
        this.broken = 'replaced';
        notes.push('the run log was replaced while it was read: reopen the run');
        break;
      }
      if (r.bytes.length === 0) break;
      const base = this.next;
      this.next += r.bytes.length;
      budget -= r.bytes.length;
      let from = 0;
      for (;;) {
        const nl = r.bytes.indexOf(0x0a, from);
        if (nl < 0) break;
        const end = base + nl + 1;
        if (this.skipping) {
          if (this.skipping === 'long') notes.push(`a line longer than ${LIVE_LINE_MAX / 1024} KiB was skipped`);
          this.skipping = null;
        } else if (this.partialLen + (nl - from) > LIVE_LINE_MAX) {
          notes.push(`a line longer than ${LIVE_LINE_MAX / 1024} KiB was skipped`);
        } else {
          const piece = r.bytes.subarray(from, nl);
          const text = this.partialLen ? Buffer.concat([...this.partial, piece]).toString('utf8') : piece.toString('utf8');
          lines.push({ text, end });
        }
        this.partial = [];
        this.partialLen = 0;
        this.cursor = end;
        from = nl + 1;
      }
      if (from < r.bytes.length && !this.skipping) {
        const rest = r.bytes.subarray(from);
        if (this.partialLen + rest.length > LIVE_LINE_MAX) {
          this.partial = [];
          this.partialLen = 0;
          this.skipping = 'long';
        } else {
          this.partial.push(Buffer.from(rest));
          this.partialLen += rest.length;
        }
      }
      if (r.bytes.length < LIVE_READ_CHUNK) break;
    }
    return { lines, notes, size };
  }
}

// ─── the view of a progress event ────────────────────────────────────────────────────────────────────────────────────

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const HOOK_PHASES = new Set(['setup', 'teardown', 'rollback', 'step']);
const HOOK_STATUS = new Set(['start', 'ok', 'failed', 'skipped']);
const STEP_STATUS = new Set(['ok', 'skipped', 'failed', 'dry']);
const SESSION_STATUS = new Set(['valid', 'unchecked', 'none', 'signed_in_auto', 'failed']);
const PAUSE_STATES = new Set(['paused', 'resumed', 'refused']);
const RUN_STATUS = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const RUN_HOOKS = new Set(['ok', 'failed', 'skipped', 'none']);
const ACCESS = new Set(['read-only', 'read-write']);
const JOB_STATE_SET = new Set<string>(JOB_STATES);
/** A name from the project's or scenario's files (scene id, persona, hook, page, action): one short line. */
const NAME_MAX = 200;

/** Text of the view: control characters but tab / line breaks out, the workspace and home folders hidden, capped. */
export type Scrub = (text: string) => string;

/** A scrubber that hides these folders (longest first) and caps the text. */
export function scrubber(folders: Array<{ path: string; as: string }>, max = LIVE_TEXT_MAX): Scrub {
  const pairs: Array<[RegExp, string, number]> = [];
  for (const f of folders) {
    const forms = new Set([f.path]);
    try {
      forms.add(realpathSync(f.path));
    } catch {
      /* a folder that does not resolve keeps its given form */
    }
    for (const form of forms) {
      const p = form.endsWith('/') ? form.slice(0, -1) : form;
      // The folder itself or a path under it — never a longer name that starts the same (/Users/a vs /Users/ab).
      if (p) pairs.push([new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'g'), f.as, p.length]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);
  return (text) => {
    let s = text.length > max * 4 ? text.slice(0, max * 4) : text;
    s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    for (const [re, as] of pairs) s = s.replace(re, as);
    s = maskUrls(s);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
}

/** The mask of a URL part that may carry a credential. */
export const URL_MASK = '•••';

/**
 * A path segment that may be a credential or a person's address (runner-web looksLikeSecretSegment, in short): an
 * e-mail address, a long hex string (a UUID), a JWT, a long run of letters with digits (base64url).
 */
function secretSegment(raw: string): boolean {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    /* kept as written */
  }
  if (/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(v)) return true;
  if (v.length < 16) return false;
  if (/^[0-9a-f]{32,}$/i.test(v.replace(/-/g, ''))) return true;
  if (/^[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}$/.test(v) && v.length >= 20) return true;
  return v.split(/[-_.~+=]/).some((run) => run.length >= 20 && /[0-9]/.test(run) && /[a-z]/i.test(run));
}

/**
 * URLs in a text as the Run screen shows them (review A): a password in the URL, every query value and the fragment
 * masked, path segments that look like a secret masked — the query keys stay (what a URL is about, never its tokens).
 */
export function maskUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, (url) => {
    const q = url.search(/[?#]/);
    const head = q < 0 ? url : url.slice(0, q);
    const rest = q < 0 ? '' : url.slice(q);
    const authority = head.replace(/^([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/i, `$1${URL_MASK}@`);
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(authority);
    const path = m
      ? `${m[1]}${m[2]
          .split('/')
          .map((seg) => (seg && secretSegment(seg) ? URL_MASK : seg))
          .join('/')}`
      : authority;
    if (!rest) return path;
    const hash = rest.indexOf('#');
    const query = hash < 0 ? rest : rest.slice(0, hash);
    const maskedQuery = query
      ? `?${query
          .slice(1)
          .split('&')
          .map((kv) => (kv.includes('=') ? `${kv.slice(0, kv.indexOf('='))}=${URL_MASK}` : kv && URL_MASK))
          .join('&')}`
      : '';
    return `${path}${maskedQuery}${hash < 0 ? '' : `#${URL_MASK}`}`;
  });
}

const str = (v: unknown): v is string => typeof v === 'string';
const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= Number.MAX_SAFE_INTEGER;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const name = (v: unknown): string | null => (str(v) && v.length > 0 && v.length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v : null);
const ts = (v: unknown): string | null => (str(v) && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** `untrusted: {...}` with the given texts (absent when none). */
function untrusted(scrub: Scrub, texts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(texts)) {
    if (str(v) && v.length) out[k] = scrub(v);
    else if (Array.isArray(v)) {
      const list = v.filter(str).slice(0, WARNINGS_MAX).map(scrub);
      if (list.length) out[k] = list;
    }
  }
  return Object.keys(out).length ? { untrusted: out } : {};
}

/** The view of one log.jsonl line (a RunProgress with `ts`), or null (not one the view shows, or malformed). */
export function viewProgress(line: unknown, scrub: Scrub): Record<string, unknown> | null {
  const e = obj(line);
  if (!e || !str(e.type)) return null;
  const at = ts(e.ts);
  const base = { type: e.type, ...(at ? { ts: at } : {}) };
  switch (e.type) {
    case 'run_start':
    case 'run_end': {
      const r = obj(e.run);
      if (!r) return null;
      const status = str(r.status) && RUN_STATUS.has(r.status) ? r.status : null;
      if (!status || !int(r.steps_total)) return null;
      const env = obj(r.environment);
      const opts = obj(r.options);
      const hooks = obj(r.hooks);
      if (e.type === 'run_start') {
        return {
          ...base,
          status,
          ...(r.mode === 'dry' || r.mode === 'capture' ? { mode: r.mode } : {}),
          ...(name(r.env) ? { env: r.env } : {}),
          steps_total: r.steps_total,
          ...(env?.production === true ? { production: true } : {}),
          ...(str(env?.access) && ACCESS.has(env.access) ? { access: env.access } : {}),
          ...(opts && (opts.hooks === 'run' || opts.hooks === 'skip') ? { hooks: opts.hooks } : {}),
          ...(opts && name(opts.until) ? { until: opts.until } : {}),
        };
      }
      const err = obj(r.error);
      const stopped = obj(r.stopped_at);
      const warnings = Array.isArray(r.warnings) ? r.warnings.filter(str) : [];
      return {
        ...base,
        status,
        steps_total: r.steps_total,
        ...(int(r.steps_done) ? { steps_done: r.steps_done } : {}),
        ...(hooks && str(hooks.setup) && RUN_HOOKS.has(hooks.setup) && str(hooks.teardown) && RUN_HOOKS.has(hooks.teardown) ? { hooks: { setup: hooks.setup, teardown: hooks.teardown } } : {}),
        ...(stopped && name(stopped.scene) && int(stopped.step) && (stopped.reason === 'irreversible' || stopped.reason === 'until')
          ? { stopped_at: { scene: stopped.scene, step: stopped.step, reason: stopped.reason } }
          : {}),
        ...(err ? { error: { ...(name(err.scene) ? { scene: err.scene } : {}), ...(int(err.step) ? { step: err.step } : {}), ...(name(err.action) ? { action: err.action } : {}) } } : {}),
        warnings: warnings.length,
        ...(Array.isArray(r.optional_failures) ? { optional_failures: r.optional_failures.length } : {}),
        ...untrusted(scrub, { error: err?.message, warnings }),
      };
    }
    case 'outline': {
      if (!Array.isArray(e.steps)) return null;
      const steps: Array<Record<string, unknown>> = [];
      for (const s of e.steps.slice(0, LIVE_OUTLINE_MAX)) {
        const o = obj(s);
        if (!o || !name(o.scene) || !int(o.step) || !name(o.action)) continue;
        steps.push({ scene: o.scene, step: o.step, action: o.action, desc: str(o.desc) ? scrub(o.desc) : '', ...(o.offscreen === true ? { offscreen: true } : {}) });
      }
      return { ...base, steps, ...(e.steps.length > LIVE_OUTLINE_MAX ? { truncated: true } : {}) };
    }
    case 'session':
      if (!name(e.persona) || !str(e.status) || !SESSION_STATUS.has(e.status)) return null;
      return { ...base, persona: e.persona, status: e.status, ...untrusted(scrub, { detail: e.detail }) };
    case 'pause':
      if (!str(e.state) || !PAUSE_STATES.has(e.state) || !name(e.scene) || !int(e.step)) return null;
      return { ...base, state: e.state, scene: e.scene, step: e.step, ...(num(e.ms) ? { ms: Math.round(e.ms) } : {}), ...(str(e.reason) ? { reason: scrub(e.reason) } : {}) };
    case 'hook': {
      if (!str(e.phase) || !HOOK_PHASES.has(e.phase) || !name(e.name) || !str(e.status) || !HOOK_STATUS.has(e.status)) return null;
      // A hook without a name is named by its description — its shell command or URL (review A): scrubbed as a text.
      const hookName = scrub(e.name as string);
      return { ...base, phase: e.phase, name: hookName || 'hook', status: e.status, ...untrusted(scrub, { message: e.message }) };
    }
    case 'scene_start':
      if (!name(e.scene) || !int(e.index)) return null;
      return { ...base, scene: e.scene, index: e.index };
    case 'step_start':
      if (!name(e.scene) || !int(e.step) || !name(e.action)) return null;
      return { ...base, scene: e.scene, step: e.step, action: e.action, desc: str(e.desc) ? scrub(e.desc) : '' };
    case 'step_end':
      if (!name(e.scene) || !int(e.step) || !name(e.action) || !str(e.status) || !STEP_STATUS.has(e.status)) return null;
      return { ...base, scene: e.scene, step: e.step, action: e.action, status: e.status, ...(num(e.ms) ? { ms: Math.round(e.ms) } : {}), ...untrusted(scrub, { message: e.message }) };
    case 'log':
      if (!str(e.level) || !LEVELS.has(e.level) || !str(e.message)) return null;
      return { ...base, level: e.level, ...untrusted(scrub, { message: e.message }) };
    case 'encode':
      if (e.status !== 'start' && e.status !== 'done') return null;
      return { ...base, status: e.status, ...untrusted(scrub, { message: e.message }) };
    default:
      return null;
  }
}

/** The view of one job events.jsonl line: the worker's notes and state changes (its `run` events are log.jsonl's). */
export function viewJobEvent(line: unknown, scrub: Scrub): Record<string, unknown> | null {
  const e = obj(line);
  if (!e || !str(e.type)) return null;
  const at = ts(e.t);
  const base = at ? { ts: at } : {};
  if (e.type === 'log') {
    if (!str(e.level) || !LEVELS.has(e.level) || !str(e.message)) return null;
    return { type: 'job_log', ...base, level: e.level, ...untrusted(scrub, { message: e.message }) };
  }
  if (e.type === 'state') {
    if (!str(e.state) || !JOB_STATE_SET.has(e.state)) return null;
    return { type: 'job_state', ...base, state: e.state, ...untrusted(scrub, { message: e.message }) };
  }
  return null;
}

// ─── streams and the upstream of frames ──────────────────────────────────────────────────────────────────────────────

const sse = sseText;

/**
 * Two lists of items, each in its file's order, merged by their `ts` (ISO, so comparable as text); an item without one
 * goes with the one before it in its own list; on a tie the run's line first. Each list's order is kept (the cursor).
 */
export function mergeByTime(a: LiveItem[], b: LiveItem[]): LiveItem[] {
  if (!a.length || !b.length) return a.length ? a : b;
  const keyed = (list: LiveItem[]) => {
    let last = '';
    return list.map((it) => {
      const t = typeof it.ev.ts === 'string' ? it.ev.ts : last;
      last = t;
      return { it, t };
    });
  };
  const x = keyed(a);
  const y = keyed(b);
  const out: LiveItem[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) out.push(y[j].t < x[i].t ? y[j++].it : x[i++].it);
  while (i < x.length) out.push(x[i++].it);
  while (j < y.length) out.push(y[j++].it);
  return out;
}
/** A page id a frame may name: the grammar of a scenario's names (core SLUG_RE), at most 100 characters. */
const isPageId = (v: string): boolean => v.length <= 100 && SLUG_RE.test(v);

/** One page's stream of one run. */
class RunStream {
  private waitingFrame: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private ticks = 0;
  private sawEnd = 0;
  private lastJob = '';
  private ended = false;
  feed: FrameFeed | null = null;
  picture: PictureState | null = null;

  constructor(
    readonly live: RunLive,
    readonly res: ServerResponse,
    readonly req: { project: string; run: string; jobId: string | null },
    private readonly log: JsonlTail,
    private readonly jobLog: JsonlTail | null,
    private readonly scrub: Scrub,
  ) {
    res.on('drain', () => {
      const f = this.waitingFrame;
      this.waitingFrame = null;
      if (f) this.frame(f);
    });
  }

  get closed(): boolean {
    return this.ended || this.res.writableEnded || this.res.destroyed;
  }

  write(text: string): void {
    if (this.closed) return;
    this.res.write(text);
    this.live.noteBacklog(this.res.writableLength);
  }

  /** Latest-only: a frame waits (replacing the one waiting) while the socket needs a drain. */
  frame(text: string): void {
    if (this.closed) return;
    if (this.res.writableNeedDrain) {
      this.waitingFrame = text;
      return;
    }
    this.write(text);
  }

  setPicture(state: PictureState, why?: string): void {
    if (this.picture === state) return;
    this.picture = state;
    this.write(sse('picture', { state, ...(why ? { why } : {}) }));
  }

  /**
   * New lines of both files, as view items (at most POLL_READ_MAX bytes each, or `budget`), in time order (review B L5:
   * the run's lines and the worker's merged by `ts`, each file's own order kept — a reload shows the same order).
   */
  pull(budget = POLL_READ_MAX): { items: LiveItem[]; notes: string[] } {
    const notes: string[] = [];
    const take = (tail: JsonlTail, src: LiveItem['src']): LiveItem[] => {
      const items: LiveItem[] = [];
      const r = tail.pull(budget);
      notes.push(...r.notes);
      for (const l of r.lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(l.text);
        } catch {
          continue;
        }
        const ev = src === 'log' ? viewProgress(parsed, this.scrub) : viewJobEvent(parsed, this.scrub);
        if (!ev) continue;
        if (src === 'log' && ev.type === 'run_end') this.sawEnd ||= Date.now();
        items.push({ src, seq: l.end, ev });
      }
      return items;
    };
    const run = take(this.log, 'log');
    const job = this.jobLog ? take(this.jobLog, 'job') : [];
    return { items: mergeByTime(run, job), notes };
  }

  cursor(): { log: number; job: number } {
    return { log: this.log.cursor, job: this.jobLog?.cursor ?? 0 };
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.live.pollMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const { items, notes } = this.pull();
      for (const n of notes) this.write(sse('progress', { src: 'log', seq: this.log.cursor, ev: { type: 'note', message: n } }));
      for (const it of items) this.write(sse('progress', it));
      if (++this.ticks % 4 !== 0 && !this.sawEnd) return;
      await this.checkEnd();
    } catch (e) {
      this.live.log(`retake ui: a run stream failed: ${e instanceof Error ? e.name : 'error'}`);
      this.close();
    } finally {
      this.busy = false;
    }
  }

  /** The job's state (on change) and, once the run and its job ended, the last lines then `end`. */
  private async checkEnd(): Promise<void> {
    const { engine } = this.live;
    let jobState: JobState | null = null;
    if (this.req.jobId) {
      const job = await bestEffort(engine.jobs.get(this.req.jobId), 'a job that cannot be read is followed again on the next tick', null);
      if (job) {
        jobState = job.state;
        const view = { state: job.state, pause_requested: Boolean(job.pause_requested_at), cancel_requested: Boolean(job.cancel_requested_at) };
        const key = JSON.stringify(view);
        if (key !== this.lastJob) {
          this.lastJob = key;
          this.write(sse('job', view));
        }
      }
    }
    const jobDone = !this.req.jobId || jobState === null || FINISHED_JOB_STATES.has(jobState);
    // A job's run is over when its job is (the worker finalises run.json first); a terminal's when run.json says so.
    let runDone = this.sawEnd > 0 || (this.req.jobId !== null && jobDone);
    let status: string | undefined;
    if (jobDone) {
      const st = await bestEffort(engine.runs.status(this.req.project, this.req.run), 'a run whose status cannot be read is followed again on the next tick', null);
      status = st?.status;
      if (!this.req.jobId) runDone ||= st === null || st.finished;
    }
    const overdue = this.sawEnd > 0 && Date.now() - this.sawEnd > END_GRACE_MS;
    if (!(runDone && jobDone) && !overdue) return;
    if (this.closed) return;
    const last = this.pull(LIVE_TAIL_MAX);
    for (const it of last.items) this.write(sse('progress', it));
    this.write(sse('end', { ...(status ? { status } : {}), ...(jobState ? { job_state: jobState } : {}) }));
    this.close();
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    if (!this.res.writableEnded) this.res.end();
    this.live.drop(this);
  }
}

/** The one upstream of a job's frames, shared by the page streams that want them; closed when none does. */
class FrameFeed {
  readonly subs = new Set<RunStream>();
  private readonly ac = new AbortController();
  state: PictureState = 'waiting';
  /** The current frame (memory only, while this upstream is open): what a page stream joining it is sent first. */
  private latest: string | null = null;
  connected = false;

  constructor(
    private readonly live: RunLive,
    private readonly jobId: string,
  ) {}

  add(s: RunStream): void {
    this.subs.add(s);
    s.feed = this;
    s.setPicture(this.state);
    if (this.latest) s.frame(this.latest);
  }

  remove(s: RunStream): void {
    this.subs.delete(s);
    s.feed = null;
    if (this.subs.size === 0) this.stop();
  }

  stop(): void {
    this.latest = null;
    this.ac.abort();
    this.live.feeds.delete(this.jobId);
  }

  private set(state: PictureState, why?: string): void {
    this.state = state;
    if (state !== 'live') this.latest = null;
    for (const s of this.subs) s.setPicture(state, why);
  }

  private onFrame(f: LiveFeedFrame): void {
    if (this.ac.signal.aborted) return;
    const h = f.header;
    const text = sse('frame', { seq: h.seq, w: h.w, h: h.h, at: h.at, ...(h.page !== undefined && isPageId(h.page) ? { page: h.page } : {}), jpeg: f.data.toString('base64') });
    if (this.state !== 'live') this.set('live');
    this.latest = text;
    for (const s of this.subs) s.frame(text);
  }

  /** Follow the job's channel while a page stream wants frames: retry while it runs, `ended` once it ended. */
  async run(): Promise<void> {
    const signal = this.ac.signal;
    while (!signal.aborted) {
      const job = await bestEffort(this.live.engine.jobs.get(this.jobId), 'a job that cannot be read is followed again on the next tick', null);
      if (signal.aborted) return;
      if (!job || FINISHED_JOB_STATES.has(job.state)) {
        this.set('ended');
        return;
      }
      if (job.state === 'running') {
        const info = await readLiveChannel(this.live.queue, this.live.files, this.jobId);
        if (info && !signal.aborted) {
          this.connected = true;
          this.live.upstreams++;
          try {
            await openLiveFeed(info, { signal, onFrame: (f) => this.onFrame(f) });
          } catch (e) {
            if (/answered 503/.test(e instanceof Error ? e.message : '')) this.set('busy', 'the live picture of this run is already open elsewhere (another Studio)');
          } finally {
            this.connected = false;
            this.live.upstreams--;
          }
          if (!signal.aborted && this.state === 'live') this.set('waiting');
        }
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, FEED_RETRY_MS);
        signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
    }
  }
}

export interface RunLiveOptions {
  engine: Engine;
  ws: OpenedWorkspace;
  pollMs?: number;
  log?: (message: string) => void;
}

/** The run streams of one Studio server. */
export class RunLive {
  readonly engine: Engine;
  /**
   * The engine's job queue itself, not one with its own memory: it is asked only who claimed a job (claimOf keeps no
   * memory), never what holds heavy work.
   */
  readonly queue: Pick<JobQueueView, 'claimOf'>;
  /** The queue's paths (Engine.jobFiles): a job's live.json, and its events read here by byte range. */
  readonly files: Pick<JobFiles, 'live' | 'events'>;
  readonly pollMs: number;
  readonly feeds = new Map<string, FrameFeed>();
  private readonly streams = new Set<RunStream>();
  private reserved = 0;
  private keepalive: NodeJS.Timeout | undefined;
  private closed = false;
  /** Upstream frame connections open now (tests). */
  upstreams = 0;
  /** The most bytes a page stream's socket held unsent so far (tests: latest-only). */
  maxBacklog = 0;

  constructor(private readonly o: RunLiveOptions) {
    this.engine = o.engine;
    this.queue = o.engine.queue;
    this.files = o.engine.jobFiles;
    this.pollMs = o.pollMs ?? RUN_LIVE_POLL_MS;
  }

  log(message: string): void {
    this.o.log?.(message);
  }

  noteBacklog(n: number): void {
    if (n > this.maxBacklog) this.maxBacklog = n;
  }

  /** Run streams open now. */
  get streamCount(): number {
    return this.streams.size;
  }

  /**
   * `POST /v1/live` (the gate passed, the body read): a stream, or an answer through `fail` — 503 when
   * RUN_LIVE_STREAMS_MAX are open, 400 for a bad body, 404 for no such run.
   */
  async open(res: ServerResponse, body: Record<string, unknown>, fail: (status: number, code: string, message: string) => void): Promise<void> {
    if (this.closed || this.streams.size + this.reserved >= RUN_LIVE_STREAMS_MAX) {
      fail(503, 'too_many_streams', `this Studio serves at most ${RUN_LIVE_STREAMS_MAX} run streams: close the live screen in another tab (this one follows the run without its picture)`);
      return;
    }
    const parsed = RunLiveInput.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      fail(400, 'invalid', `${i?.path.join('.') || 'body'}: ${i?.message ?? 'invalid'}`);
      return;
    }
    const a = parsed.data;
    this.reserved++;
    let stream: RunStream;
    let mode: string;
    let picture: { state: PictureState; why: string } | null;
    let jobId: string | null;
    let snapshot: { from: 'start' | 'after'; truncated: boolean; items: LiveItem[]; notes: string[] };
    try {
      const p = await openProjectBySlug(this.o.ws, a.project);
      const status = await this.engine.runs.status(a.project, a.run_id);
      const folder = await RunFolder.open(p.dir, a.run_id);
      if (!folder) throw new EngineError('not_found', `run ${a.run_id} has no readable folder in ${a.project} (a link, or outside the project)`);
      mode = status.mode;
      jobId = status.job?.id ?? null;
      const scrub = scrubber([
        { path: p.dir, as: '<project>' },
        { path: resolve(this.o.ws.root), as: '<workspace>' },
        { path: homedir(), as: '~' },
      ]);
      // Where the log is read from: after the page's cursor, else the start — at most its last LIVE_TAIL_MAX bytes.
      const size = (r: RangeRead | { ok: false }) => (r.ok ? r.size : 0);
      const logSize = size(folder.readRange('log.jsonl', 0, 0));
      let logStart = a.after?.log ?? 0;
      let from: 'start' | 'after' = a.after ? 'after' : 'start';
      if (logStart > logSize) {
        logStart = 0;
        from = 'start';
      }
      const truncated = logSize - logStart > LIVE_TAIL_MAX;
      if (truncated) logStart = logSize - LIVE_TAIL_MAX;
      const log = new JsonlTail((o, m) => folder.readRange('log.jsonl', o, m), logStart, truncated);
      let jobLog: JsonlTail | null = null;
      if (jobId) {
        const file = this.files.events(jobId);
        const jobSize = size(readPlainRange(file, 0, 0));
        let jobStart = from === 'after' ? (a.after?.job ?? 0) : 0;
        if (jobStart > jobSize) jobStart = 0;
        const cut = jobSize - jobStart > LIVE_TAIL_MAX;
        if (cut) jobStart = jobSize - LIVE_TAIL_MAX;
        jobLog = new JsonlTail((o, m) => readPlainRange(file, o, m), jobStart, cut);
      }
      stream = new RunStream(this, res, { project: a.project, run: a.run_id, jobId }, log, jobLog, scrub);
      const first = stream.pull(LIVE_TAIL_MAX);
      snapshot = { from, truncated, items: first.items, notes: first.notes };
      const finished = status.finished || (status.job ? FINISHED_JOB_STATES.has(status.job.state) : false);
      const wants = a.frames ?? mode === 'dry';
      picture = !jobId
        ? { state: 'none', why: 'this run was started in a terminal: steps and log only' }
        : finished
          ? { state: 'none', why: 'the run has ended' }
          : !wants
            ? { state: 'off', why: a.frames === false ? 'the picture is hidden' : 'a capture shows its picture only when asked (it costs CPU during the take)' }
            : null;
    } catch (e) {
      this.reserved--;
      const err = toEngineError(e);
      fail(ERROR_STATUS[err.code], err.code, err.message);
      return;
    }
    this.reserved--;
    if (this.closed || res.destroyed) return;
    res.writeHead(200, { ...securityHeaders('api'), 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    this.streams.add(stream);
    res.on('close', () => stream.close());
    stream.write(sse('hello', { project: a.project, run_id: a.run_id, mode, job: jobId }));
    // The snapshot: every event but the log lines cut to the newest LIVE_SNAPSHOT_LOG_LINES.
    const isLog = (i: LiveItem) => i.ev.type === 'log' || i.ev.type === 'job_log';
    let logs = snapshot.items.filter(isLog).length;
    const items = snapshot.items.filter((i) => !isLog(i) || logs-- <= LIVE_SNAPSHOT_LOG_LINES);
    const dropped = snapshot.items.length - items.length;
    stream.write(
      sse('snapshot', {
        from: snapshot.from,
        truncated: snapshot.truncated,
        ...(dropped ? { log_lines_dropped: dropped } : {}),
        cursor: stream.cursor(),
        events: items,
        ...(snapshot.notes.length ? { notes: snapshot.notes } : {}),
      }),
    );
    if (picture) stream.setPicture(picture.state, picture.why);
    else this.subscribe(stream, jobId!);
    this.schedule();
    stream.start();
  }

  /** The job's one upstream (opened now when it is the first page stream wanting frames). */
  private subscribe(s: RunStream, jobId: string): void {
    let feed = this.feeds.get(jobId);
    if (!feed) {
      feed = new FrameFeed(this, jobId);
      this.feeds.set(jobId, feed);
      void feed.run().catch((e: unknown) => this.log(`retake ui: a live picture failed: ${e instanceof Error ? e.name : 'error'}`));
    }
    feed.add(s);
  }

  /** A stream ended: out of the set, out of its upstream (closed when it was the last). */
  drop(s: RunStream): void {
    this.streams.delete(s);
    s.feed?.remove(s);
    this.schedule();
  }

  private schedule(): void {
    const want = this.streams.size > 0 && !this.closed;
    if (want && !this.keepalive) {
      this.keepalive = setInterval(() => {
        for (const s of this.streams) s.write(': keepalive\n\n');
      }, KEEPALIVE_MS);
      this.keepalive.unref();
    } else if (!want && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = undefined;
    }
  }

  /** Ends every stream and every upstream. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams]) s.close();
    for (const f of [...this.feeds.values()]) f.stop();
    this.schedule();
  }
}
