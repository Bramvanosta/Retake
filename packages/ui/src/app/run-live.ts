/**
 * The Run screen's stream client (L4.4): `POST /v1/live` read through fetch (sse.ts), folded into one state — the
 * run's start, its outline (every step it executes), each step's status, the preflight's sessions, hooks, pauses, the
 * log (capped), the job, the picture's state and the end. Frames never enter React state: they go straight to the
 * LiveView's canvas through `onFrame`.
 *
 * - **Reconnect with a cursor**: the page keeps the largest `seq` of each source (`log`, `job`); a stream that drops
 *   without `end` is opened again with `after` (no duplicate, nothing missed), with a growing delay.
 * - **Only while watched** (critique B8): a hidden tab closes its stream (the Studio then closes the job's upstream when
 *   no other page wants frames) and opens it again with `after` when it is shown. Toggling the picture reopens the
 *   stream with `frames: true / false`. `frames` is sent only when the person chose; otherwise the server's default
 *   holds — the picture on for a dry run, off for a capture (it costs Chromium CPU during the take).
 * - **503** (every run stream of this Studio taken — another tab): the screen follows the run with a `run_status` read
 *   every few seconds instead, and tries the stream again later.
 *
 * Every text of the view arrives already reduced by the server; the screen renders each one as a text node (Txt).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openStream } from './api.js';
import type { ApiError } from './api.js';
import { runStatus } from './data/shoot.js';
import { readSse } from './sse.js';

export type PictureState = 'off' | 'none' | 'waiting' | 'live' | 'busy' | 'ended';

export interface OutlineStep {
  scene: string;
  /** 0-based. */
  step: number;
  action: string;
  desc: string;
  /** A step of an `offscreen: true` scene (L5.8): played (live, pausable), left out of the video. */
  offscreen?: true;
}

export interface StepState {
  status: 'running' | 'ok' | 'skipped' | 'failed' | 'dry';
  ms?: number;
  message?: string;
}

export interface SessionRow {
  persona: string;
  status: string;
  detail?: string;
}

export interface HookRow {
  phase: string;
  name: string;
  status: string;
  message?: string;
  /** The runner's "this phase starts" event (named after its phase, "n hook(s)"): shown until a hook of it reports. */
  marker?: true;
}

export interface PauseRow {
  state: string;
  scene: string;
  step: number;
  ms?: number;
  /** The longest the pause may last before the run stops (the worker's RETAKE_PAUSE_MAX_MIN). */
  max_ms?: number;
  reason?: string;
  ts?: string;
}

export interface LogLine {
  key: string;
  ts?: string;
  level: string;
  /** Who wrote it: the run (log.jsonl), the worker (the job's notes) or this Studio (a note of the stream). */
  from: 'run' | 'worker' | 'studio';
  text: string;
}

export interface RunStartView {
  status: string;
  mode?: string;
  env?: string;
  steps_total: number;
  production?: boolean;
  access?: string;
  hooks?: string;
  until?: string;
  ts?: string;
}

export interface RunEndView {
  status: string;
  steps_total: number;
  steps_done?: number;
  hooks?: { setup: string; teardown: string };
  stopped_at?: { scene: string; step: number; reason: string };
  error?: { scene?: string; step?: number; action?: string };
  warnings: number;
  optional_failures?: number;
  untrusted?: { error?: string; warnings?: string[] };
  ts?: string;
}

export interface JobView {
  state: string;
  pause_requested: boolean;
  cancel_requested: boolean;
}

export interface LiveFrame {
  seq: number;
  w: number;
  h: number;
  jpeg: string;
}

/** The live picture's canvas drawing size (LiveView.tsx): a 16:9 box. */
export const LIVE_BOX = { w: 960, h: 540 } as const;

/** Frames in a row of a new height (same width) before the picture is laid out for it. */
export const SETTLE_FRAMES = 3;

export interface Size {
  w: number;
  h: number;
}

/** Where a frame goes: the letterbox of the laid-out size (scale, top-left corner of the frame). */
export function placeFrame(layout: Size, f: Size): { s: number; x: number; y: number; dw: number; dh: number } {
  let s = LIVE_BOX.w / layout.w;
  if (layout.h * s > LIVE_BOX.h) s = LIVE_BOX.h / layout.h;
  const dw = Math.round(f.w * s);
  const dh = Math.round(f.h * s);
  return { s, x: Math.round((LIVE_BOX.w - dw) / 2), y: Math.round((LIVE_BOX.h - layout.h * s) / 2), dw, dh };
}

/** The layout's next size after frame `f` (mutates `pending`, the streak of a new height). */
export function nextLayout(layout: Size | null, pending: Size & { n: number }, f: Size): Size {
  if (!layout || f.w !== layout.w) {
    pending.n = 0;
    return { w: f.w, h: f.h };
  }
  if (f.h === layout.h) {
    pending.n = 0;
    return layout;
  }
  if (pending.w === f.w && pending.h === f.h) pending.n++;
  else Object.assign(pending, { w: f.w, h: f.h, n: 1 });
  if (pending.n < SETTLE_FRAMES) return layout;
  pending.n = 0;
  return { w: f.w, h: f.h };
}

export interface RunLiveState {
  hello: { mode: string; job: string | null } | null;
  start: RunStartView | null;
  outline: OutlineStep[] | null;
  outlineTruncated: boolean;
  /** By `<scene>.<step>`. */
  steps: Record<string, StepState>;
  /** The entries of a `hook:` step (phase `step`, L5.8), by its `<scene>.<step>`: shown on its row. */
  stepHooks: Record<string, HookRow[]>;
  current: { scene: string; step: number } | null;
  /** The last step that started (kept after the end): the one a stop interrupted, when it did not finish. */
  lastStarted: { scene: string; step: number } | null;
  /** The latest `ts` of the events so far (the elapsed time of a run that ended without its `run_end`). */
  lastTs: string | null;
  sessions: SessionRow[];
  hooks: HookRow[];
  /** Paused now (before this step). */
  paused: PauseRow | null;
  /** Pauses that ended, and refusals. */
  pauses: PauseRow[];
  encode: 'start' | 'done' | null;
  end: RunEndView | null;
  log: LogLine[];
  /** Log lines not shown (the snapshot's cut, and the oldest beyond LOG_KEEP). */
  logDropped: number;
  job: JobView | null;
  picture: { state: PictureState; why?: string } | null;
  /** The stream's `end`: the run and its job are over. */
  ended: { status?: string; job_state?: string } | null;
  /** The log was read from its tail only (a long run). */
  truncated: boolean;
}

/** What `run_status` says, while the stream is refused (another tab holds the slots). */
export interface RunStatusLite {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  paused?: { scene: string; step: number; since: string };
  finished: boolean;
  job?: { id: string; state: string; pause_requested_at?: string; cancel_requested_at?: string };
}

export type StreamConn = 'connecting' | 'open' | 'hidden' | 'busy' | 'retrying' | 'ended' | 'error';

/** Log lines kept on screen, at most (the newest). */
export const LOG_KEEP = 1000;
/** A refused stream (503) is tried again after this long (ms). */
const BUSY_RETRY_MS = 30_000;
/** run_status read this often while the stream is refused (ms). */
const FALLBACK_POLL_MS = 2500;
/** At most this often the screen re-renders for new events (ms). */
const FLUSH_MS = 100;
/** A frame's JPEG as base64, at most (the worker's 512 KiB cap, encoded). */
const FRAME_B64_MAX = 700_000;

export const EMPTY: RunLiveState = {
  hello: null,
  start: null,
  outline: null,
  outlineTruncated: false,
  steps: {},
  stepHooks: {},
  current: null,
  lastStarted: null,
  lastTs: null,
  sessions: [],
  hooks: [],
  paused: null,
  pauses: [],
  encode: null,
  end: null,
  log: [],
  logDropped: 0,
  job: null,
  picture: null,
  ended: null,
  truncated: false,
};

const str = (v: unknown): v is string => typeof v === 'string';
const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } => (v === undefined ? {} : ({ [k]: v } as { [P in K]?: V }));
const ustr = (u: unknown, k: string): string | undefined => {
  const v = obj(u)[k];
  return str(v) ? v : undefined;
};

export const stepKey = (scene: string, step: number) => `${scene}.${step}`;

/** What the log says of the job's state (the job is the worker's: its `succeeded` is not the run's outcome). */
const JOB_STATE_WORDS: Record<string, string> = {
  queued: 'job queued for the worker',
  running: 'the worker started the job',
  succeeded: 'the worker finished the job (the run’s own outcome is above)',
  failed: 'the job failed',
  cancelled: 'the job was cancelled',
  interrupted: 'the job was interrupted (its worker stopped)',
};

/** One event of the view folded into the state (a copy of what changed; unknown events change nothing). */
export function applyEvent(prev: RunLiveState, source: string, seq: number, ev: Record<string, unknown>): RunLiveState {
  const ts = str(ev.ts) ? ev.ts : undefined;
  const next = foldEvent(prev, source, seq, ev, ts);
  return next !== prev && ts && (!next.lastTs || ts > next.lastTs) ? { ...next, lastTs: ts } : next;
}

function foldEvent(s: RunLiveState, source: string, seq: number, ev: Record<string, unknown>, ts: string | undefined): RunLiveState {
  const addLog = (level: string, text: string, from: LogLine['from']): RunLiveState => {
    const line: LogLine = { key: `${source}:${seq}:${s.logDropped + s.log.length}`, ...opt('ts', ts), level, from, text };
    // In time order (the run's lines and the worker's come from two files): after the last line not later than it.
    let at = s.log.length;
    if (ts) while (at > 0 && (s.log[at - 1].ts ?? '') > ts) at--;
    const log = [...s.log.slice(0, at), line, ...s.log.slice(at)];
    const over = log.length - LOG_KEEP;
    return over > 0 ? { ...s, log: log.slice(over), logDropped: s.logDropped + over } : { ...s, log };
  };
  switch (ev.type) {
    case 'run_start':
      if (!str(ev.status) || !int(ev.steps_total)) return s;
      return {
        ...s,
        start: {
          status: ev.status,
          steps_total: ev.steps_total,
          ...opt('mode', str(ev.mode) ? ev.mode : undefined),
          ...opt('env', str(ev.env) ? ev.env : undefined),
          ...opt('production', ev.production === true ? true : undefined),
          ...opt('access', str(ev.access) ? ev.access : undefined),
          ...opt('hooks', str(ev.hooks) ? ev.hooks : undefined),
          ...opt('until', str(ev.until) ? ev.until : undefined),
          ...opt('ts', ts),
        },
      };
    case 'outline': {
      if (!Array.isArray(ev.steps)) return s;
      const steps = ev.steps.map(obj).filter((o) => str(o.scene) && int(o.step) && str(o.action));
      return { ...s, outline: steps.map((o) => ({ scene: o.scene as string, step: o.step as number, action: o.action as string, desc: str(o.desc) ? o.desc : '', ...(o.offscreen === true ? { offscreen: true as const } : {}) })), outlineTruncated: ev.truncated === true };
    }
    case 'session': {
      if (!str(ev.persona) || !str(ev.status)) return s;
      const row: SessionRow = { persona: ev.persona, status: ev.status, ...opt('detail', ustr(ev.untrusted, 'detail')) };
      return { ...s, sessions: [...s.sessions.filter((r) => r.persona !== row.persona), row] };
    }
    case 'pause': {
      if (!str(ev.state) || !str(ev.scene) || !int(ev.step)) return s;
      const row: PauseRow = {
        state: ev.state,
        scene: ev.scene,
        step: ev.step,
        ...opt('ms', int(ev.ms) ? ev.ms : undefined),
        ...opt('max_ms', int(ev.max_ms) && ev.max_ms > 0 ? ev.max_ms : undefined),
        ...opt('reason', str(ev.reason) ? ev.reason : undefined),
        ...opt('ts', ts),
      };
      if (row.state === 'paused') return { ...s, paused: row };
      return { ...s, paused: null, pauses: [...s.pauses, row] };
    }
    case 'hook': {
      if (!str(ev.phase) || !str(ev.name) || !str(ev.status)) return s;
      const row: HookRow = { phase: ev.phase, name: ev.name, status: ev.status, ...opt('message', ustr(ev.untrusted, 'message')) };
      // A `hook:` step's entries (L5.8) belong to the step running now: its row shows them.
      if (row.phase === 'step') {
        if (!s.current) return s;
        const k = stepKey(s.current.scene, s.current.step);
        const list = (s.stepHooks[k] ?? []).filter((h) => !h.marker);
        return { ...s, stepHooks: { ...s.stepHooks, [k]: [...list, ...(row.status === 'start' ? [{ ...row, marker: true as const }] : [row])] } };
      }
      // The phase's start (named after it): one marker row; a hook's own result then replaces it.
      if (row.status === 'start' && row.name === row.phase) return { ...s, hooks: [...s.hooks.filter((h) => !(h.marker && h.phase === row.phase)), { ...row, marker: true }] };
      return { ...s, hooks: [...s.hooks.filter((h) => !(h.marker && h.phase === row.phase)), row] };
    }
    case 'step_start': {
      if (!str(ev.scene) || !int(ev.step)) return s;
      const at = { scene: ev.scene, step: ev.step };
      return { ...s, current: at, lastStarted: at, paused: null, steps: { ...s.steps, [stepKey(ev.scene, ev.step)]: { status: 'running' } } };
    }
    case 'step_end': {
      if (!str(ev.scene) || !int(ev.step) || !str(ev.status)) return s;
      const st = ev.status as StepState['status'];
      return { ...s, steps: { ...s.steps, [stepKey(ev.scene, ev.step)]: { status: st, ...opt('ms', int(ev.ms) ? ev.ms : undefined), ...opt('message', ustr(ev.untrusted, 'message')) } } };
    }
    case 'encode':
      return ev.status === 'start' || ev.status === 'done' ? { ...s, encode: ev.status } : s;
    case 'run_end': {
      if (!str(ev.status) || !int(ev.steps_total)) return s;
      const u = obj(ev.untrusted);
      const warnings = Array.isArray(u.warnings) ? u.warnings.filter(str) : undefined;
      const end: RunEndView = {
        status: ev.status,
        steps_total: ev.steps_total,
        warnings: int(ev.warnings) ? ev.warnings : 0,
        ...opt('steps_done', int(ev.steps_done) ? ev.steps_done : undefined),
        ...opt('hooks', str(obj(ev.hooks).setup) && str(obj(ev.hooks).teardown) ? (ev.hooks as RunEndView['hooks']) : undefined),
        ...opt('stopped_at', str(obj(ev.stopped_at).scene) ? (ev.stopped_at as RunEndView['stopped_at']) : undefined),
        ...opt('error', ev.error && typeof ev.error === 'object' ? (ev.error as RunEndView['error']) : undefined),
        ...opt('optional_failures', int(ev.optional_failures) ? ev.optional_failures : undefined),
        ...opt('untrusted', str(u.error) || warnings?.length ? { ...opt('error', str(u.error) ? u.error : undefined), ...opt('warnings', warnings) } : undefined),
        ...opt('ts', ts),
      };
      return { ...s, end, current: null, paused: null };
    }
    case 'log':
      return str(ev.level) ? addLog(ev.level, ustr(ev.untrusted, 'message') ?? '', 'run') : s;
    case 'job_log':
      return str(ev.level) ? addLog(ev.level, ustr(ev.untrusted, 'message') ?? '', 'worker') : s;
    case 'job_state':
      return str(ev.state) ? addLog('info', `${JOB_STATE_WORDS[ev.state] ?? `job ${ev.state}`}${ustr(ev.untrusted, 'message') ? `: ${ustr(ev.untrusted, 'message')}` : ''}`, 'worker') : s;
    case 'note':
      return str(ev.message) ? addLog('warn', ev.message, 'studio') : s;
    default:
      return s;
  }
}

/** A step row's status on the Run screen. */
export type StepRowStatus = StepState['status'] | 'waiting' | 'not_reached' | 'stopped' | 'interrupted' | 'hook_skipped';

/**
 * The status a step's row shows (review B M1, M2, L8): its own, except — the step a stop interrupted (the last one that
 * started, when it did not finish well) is "stopped"; a step still running when the run ended without finishing it (its
 * worker killed) "interrupted"; a `hook:` step of a run whose hooks are skipped "hook_skipped" (it did not run); a step
 * never reached "not_reached" once the run ended, "waiting" before.
 */
export function stepStatus(s: RunLiveState, row: Pick<OutlineStep, 'scene' | 'step' | 'action'>, finished: boolean): StepRowStatus {
  const st = s.steps[stepKey(row.scene, row.step)];
  if (!st) return finished ? 'not_reached' : 'waiting';
  const last = s.lastStarted !== null && s.lastStarted.scene === row.scene && s.lastStarted.step === row.step;
  if (last && s.end?.status === 'cancelled' && (st.status === 'failed' || st.status === 'running')) return 'stopped';
  if (st.status === 'running' && finished) return 'interrupted';
  if (row.action === 'hook' && s.start?.hooks === 'skip' && (st.status === 'ok' || st.status === 'dry')) return 'hook_skipped';
  return st.status;
}

/** Steps done (their row says done) and skipped, of these rows — a failed step is not done (review B L9). */
export function stepCounts(s: RunLiveState, rows: Array<Pick<OutlineStep, 'scene' | 'step' | 'action'>>, finished: boolean): { done: number; skipped: number } {
  let done = 0;
  let skipped = 0;
  for (const r of rows) {
    const st = stepStatus(s, r, finished);
    if (st === 'ok' || st === 'dry') done++;
    else if (st === 'skipped' || st === 'hook_skipped') skipped++;
  }
  return { done, skipped };
}

/** "30 min" / "90 s": a pause's longest length in words. */
export function pauseMaxWords(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/** Tracks `document.visibilityState`: false while the tab is hidden (in the background, minimised). */
export function useVisible(): boolean {
  const [visible, set] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => set(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

export interface RunLive {
  state: RunLiveState;
  conn: StreamConn;
  /** The stream's refusal (404 no such run, 400…), as the server said it. */
  error: ApiError | null;
  /** run_status, while the stream is refused (503). */
  fallback: RunStatusLite | null;
}

/**
 * Follow one run: its stream while the tab is visible (`frames`: null = the server's default), frames to `onFrame`.
 */
export function useRunLive(slug: string, runId: string, frames: boolean | null, onFrame: (f: LiveFrame) => void): RunLive {
  const [state, setState] = useState<RunLiveState>(EMPTY);
  const [conn, setConn] = useState<StreamConn>('connecting');
  const [error, setError] = useState<ApiError | null>(null);
  const [fallback, setFallback] = useState<RunStatusLite | null>(null);
  const visible = useVisible();
  const stateRef = useRef<RunLiveState>(EMPTY);
  const cursor = useRef<{ log: number; job: number } | null>(null);
  const ended = useRef(false);
  const frameRef = useRef(onFrame);
  frameRef.current = onFrame;
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setState(stateRef.current);
    }, FLUSH_MS);
  }, []);

  const advance = (source: unknown, seq: unknown) => {
    if (!cursor.current || !int(seq)) return;
    if (source === 'log' && seq > cursor.current.log) cursor.current = { ...cursor.current, log: seq };
    if (source === 'job' && seq > cursor.current.job) cursor.current = { ...cursor.current, job: seq };
  };

  const handle = (type: string, data: unknown): boolean => {
    const d = obj(data);
    switch (type) {
      case 'hello':
        stateRef.current = { ...stateRef.current, hello: { mode: str(d.mode) ? d.mode : 'dry', job: str(d.job) ? d.job : null } };
        break;
      case 'snapshot': {
        let s = d.from === 'start' ? { ...EMPTY, hello: stateRef.current.hello, picture: stateRef.current.picture, job: stateRef.current.job } : stateRef.current;
        const c = obj(d.cursor);
        cursor.current = { log: int(c.log) ? c.log : 0, job: int(c.job) ? c.job : 0 };
        if (d.truncated === true) s = { ...s, truncated: true };
        if (int(d.log_lines_dropped)) s = { ...s, logDropped: s.logDropped + d.log_lines_dropped };
        for (const it of Array.isArray(d.events) ? d.events : []) {
          const i = obj(it);
          s = applyEvent(s, str(i.src) ? i.src : 'log', int(i.seq) ? i.seq : 0, obj(i.ev));
        }
        for (const n of Array.isArray(d.notes) ? d.notes.filter(str) : []) s = applyEvent(s, 'log', 0, { type: 'note', message: n });
        stateRef.current = s;
        break;
      }
      case 'progress':
        stateRef.current = applyEvent(stateRef.current, str(d.src) ? d.src : 'log', int(d.seq) ? d.seq : 0, obj(d.ev));
        advance(d.src, d.seq);
        break;
      case 'job':
        if (str(d.state)) stateRef.current = { ...stateRef.current, job: { state: d.state, pause_requested: d.pause_requested === true, cancel_requested: d.cancel_requested === true } };
        break;
      case 'picture':
        if (str(d.state)) stateRef.current = { ...stateRef.current, picture: { state: d.state as PictureState, ...opt('why', str(d.why) ? d.why : undefined) } };
        break;
      case 'frame':
        if (int(d.seq) && int(d.w) && int(d.h) && d.w > 0 && d.h > 0 && d.w <= 4096 && d.h <= 4096 && str(d.jpeg) && d.jpeg.length <= FRAME_B64_MAX) {
          frameRef.current({ seq: d.seq, w: d.w, h: d.h, jpeg: d.jpeg });
        }
        return true;
      case 'end':
        ended.current = true;
        stateRef.current = { ...stateRef.current, ended: { ...opt('status', str(d.status) ? d.status : undefined), ...opt('job_state', str(d.job_state) ? d.job_state : undefined) } };
        flush();
        return false;
      default:
        return true;
    }
    flush();
    return true;
  };
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // A new run on the same screen: everything from the start.
  useEffect(() => {
    stateRef.current = EMPTY;
    cursor.current = null;
    ended.current = false;
    setState(EMPTY);
    setError(null);
    setFallback(null);
  }, [slug, runId]);

  useEffect(() => {
    if (ended.current) return;
    if (!visible) {
      setConn('hidden');
      return;
    }
    const ac = new AbortController();
    void (async () => {
      let backoff = 1000;
      while (!ac.signal.aborted && !ended.current) {
        setConn('connecting');
        const body = { project: slug, run_id: runId, ...(cursor.current ? { after: cursor.current } : {}), ...(frames !== null ? { frames } : {}) };
        let r: Awaited<ReturnType<typeof openStream>>;
        try {
          r = await openStream('/v1/live', body, ac.signal);
        } catch {
          return; // the session ended: the shell says so
        }
        if (ac.signal.aborted) return;
        if (r.res) {
          setConn('open');
          setError(null);
          backoff = 1000;
          await readSse(r.res, (t, d) => handleRef.current(t, d));
          if (ac.signal.aborted) return;
          if (ended.current) {
            setConn('ended');
            return;
          }
        } else if (r.status === 503) {
          setConn('busy');
          await sleep(BUSY_RETRY_MS, ac.signal);
          continue;
        } else if (r.status >= 400 && r.status < 500) {
          setError(r.error ?? { code: 'internal', message: `HTTP ${r.status}` });
          setConn('error');
          return;
        }
        setConn('retrying');
        await sleep(backoff, ac.signal);
        backoff = Math.min(backoff * 2, 10_000);
      }
    })();
    return () => ac.abort();
  }, [slug, runId, frames, visible]);

  // Refused stream: run_status every few seconds while the tab is visible.
  useEffect(() => {
    if (conn !== 'busy' || !visible) return;
    let live = true;
    const read = () =>
      runStatus({ project: slug, run_id: runId }).then(
        (d) => live && setFallback(d),
        () => undefined,
      );
    void read();
    const t = setInterval(read, FALLBACK_POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [conn, visible, slug, runId]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  return { state, conn, error, fallback };
}
