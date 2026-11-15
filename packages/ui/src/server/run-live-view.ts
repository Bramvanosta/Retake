/**
 * The Run screen stream's view of the files it reads (run-live.ts): each progress event of a run's log.jsonl and each
 * note of its job's events.jsonl type-checked and reduced, its texts scrubbed and under `untrusted`, URLs masked, and
 * the two lists merged by time.
 */
import { JOB_STATES } from '@retake/engine/shell';
import { decodeOrKeep } from '@retake/core/base';

/** Steps an outline carries, at most. */
export const LIVE_OUTLINE_MAX = 5000;
/** Warnings a run_end carries, at most. */
const WARNINGS_MAX = 20;

/** One event of the view: its source file, the byte offset of its line's end there, and the reduced event. */
export interface LiveItem {
  src: 'log' | 'job';
  seq: number;
  ev: Record<string, unknown>;
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

/** The mask of a URL part that may carry a credential. */
export const URL_MASK = '•••';

/**
 * A path segment that may be a credential or a person's address (runner-web looksLikeSecretSegment, in short): an
 * e-mail address, a long hex string (a UUID), a JWT, a long run of letters with digits (base64url).
 */
function secretSegment(raw: string): boolean {
  const v = decodeOrKeep(raw);
  if (/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(v)) return true;
  if (v.length < 16) return false;
  if (/^[0-9a-f]{32,}$/i.test(v.replace(/-/g, ''))) return true;
  if (/^[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}$/.test(v) && v.length >= 20) return true;
  return v.split(/[-_.~+=]/).some((run) => run.length >= 20 && /[0-9]/.test(run) && /[a-z]/i.test(run));
}

/**
 * URLs in a text as the Run screen shows them: a password in the URL, every query value and the fragment
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
      // A hook without a name is named by its description — its shell command or URL: scrubbed as a text.
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
