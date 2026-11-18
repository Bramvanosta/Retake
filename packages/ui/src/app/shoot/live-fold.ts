/**
 * The Run screen's state from the stream's view events (run-live.ts): the view's types, one event folded into the
 * state (`applyEvent`), a step row's status and the counts, and where a frame goes in the live picture's box.
 */
export type PictureState = 'off' | 'none' | 'waiting' | 'live' | 'busy' | 'ended';

export interface OutlineStep {
  scene: string;
  /** 0-based. */
  step: number;
  action: string;
  desc: string;
  /** A step of an `offscreen: true` scene: played (live, pausable), left out of the video. */
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
  /** A queued job the app's Tools hold: what it waits for (the browser; the render tools for the headless shell). */
  waits_for?: 'browser' | 'render';
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
  /** The entries of a `hook:` step (phase `step`), by its `<scene>.<step>`: shown on its row. */
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

export const str = (v: unknown): v is string => typeof v === 'string';
export const int = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const opt = <K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } => (v === undefined ? {} : ({ [k]: v } as { [P in K]?: V }));
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

/** A `hook` event: a `hook:` step's entry on its step's row, a phase's marker row, or a hook's own result. */
function foldHook(s: RunLiveState, ev: Record<string, unknown>): RunLiveState {
  if (!str(ev.phase) || !str(ev.name) || !str(ev.status)) return s;
  const row: HookRow = { phase: ev.phase, name: ev.name, status: ev.status, ...opt('message', ustr(ev.untrusted, 'message')) };
  // A `hook:` step's entries belong to the step running now: its row shows them.
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

/** A `run_end` event's view (null: not one the screen can read). */
function runEndOf(ev: Record<string, unknown>, ts: string | undefined): RunEndView | null {
  if (!str(ev.status) || !int(ev.steps_total)) return null;
  const u = obj(ev.untrusted);
  const warnings = Array.isArray(u.warnings) ? u.warnings.filter(str) : undefined;
  return {
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
      return {
        ...s,
        outline: steps.map((o) => ({
          scene: o.scene as string,
          step: o.step as number,
          action: o.action as string,
          desc: str(o.desc) ? o.desc : '',
          ...(o.offscreen === true ? { offscreen: true as const } : {}),
        })),
        outlineTruncated: ev.truncated === true,
      };
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
    case 'hook':
      return foldHook(s, ev);
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
      const end = runEndOf(ev, ts);
      return end ? { ...s, end, current: null, paused: null } : s;
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
 * The status a step's row shows: its own, except — the step a stop interrupted (the last one that
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

/** Steps done (their row says done) and skipped, of these rows — a failed step is not done. */
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
