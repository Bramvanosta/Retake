/**
 * L5.11a: Shoot's shared state — what the status bar, Prepare, the live screen and the Scenario screen read and do for a
 * scenario's runs.
 *
 * - `scenario_actions` entries (one per scenario × location: one call in flight, a reload asked meanwhile runs once
 *   after it, an error read again later — project-data.ts's pattern). They are read again only on what concerns them
 *   (`shootEventAction`): the scenario's file, a run of it appearing / changing status / going away, the project's own
 *   files, a reconnection, a focus; a render they show (its progress: at most every RENDER_JOBS_THROTTLE_MS) or a job of
 *   the project they never saw (at most every JOBS_THROTTLE_MS). A step's progress — its run's job rewritten — never
 *   re-reads them (review A-M1): the status bar's progress line is `run_status` (useRunProgress), and on the Scenario
 *   screen the screen feeds the store from its own view (`feedActions`, critique H2: no second read, no second
 *   validation per save).
 * - Starts (`startRun`, `startRender`): one store function per kind, so a held ⌘R, a click and a menu command in the same
 *   tick queue ONE run — the scenario is marked `sending` synchronously before the call and a second ask is ignored
 *   (the server's one-run-per-scenario 409 stays the authority). The run just queued counts as running until a read
 *   shows it (critique L3). A capture refused for sessions to confirm opens the shell's one confirmation sheet.
 * - What the last start of a scenario came to (`useLastStart`): the Scenario screen's take strip shows it whoever
 *   started it (review B H1 of L5.10b).
 * - The file a screen shows (`useShownFile`): Rehearse / Capture / Render send the hash of the file on screen (review A
 *   #6 of L4.2: a changed file is a 409, then the screen reads it again), else the actions' hash.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ScenarioActions } from '@retake/engine';
import { CallError, call, errorText } from './api.js';
import type { Loaded } from './api.js';
import { scenarioEventAction, useEvents } from './events.js';
import type { StudioEvent } from './events.js';
import { SessionEnded } from './session.js';
import { modeWord } from './shoot-words.js';

/** Job-driven re-reads: at most one per this (a job of the project the entry never saw). */
export const JOBS_THROTTLE_MS = 2000;
/** A render the entry shows, while it progresses: at most one re-read per this (critique H2: ~36 reads for a 3-minute render). */
export const RENDER_JOBS_THROTTLE_MS = 5000;
const ERROR_RETRY_MS = 2000;
const ERROR_RETRY_MAX_MS = 60_000;
/** A run just queued counts as running until a read shows it, at most this long (critique L3). */
const PENDING_MS = 15_000;

type Mode = 'dry' | 'capture';
const key3 = (slug: string, name: string, env: string | undefined) => `${slug}\0${name}\0${env ?? ''}`;
const key2 = (slug: string, name: string) => `${slug}\0${name}`;

// ── tiny stores ───────────────────────────────────────────────────────────────────────────────────────────────────────

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      for (const s of [...subs]) s();
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

// ── scenario_actions entries ──────────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  slug: string;
  name: string;
  env: string | undefined;
  state: Loaded<ScenarioActions>;
  subs: Set<() => void>;
  users: number;
  inflight: boolean;
  again: boolean;
  timer: number | null;
  lastAt: number;
  retry: number | null;
  backoff: number;
}

const entries = new Map<string, Entry>();
/** scenario_actions reads made by this page (the e2e counts them at the server too). */
export const actionReads = { count: 0 };

function entryOf(slug: string, name: string, env: string | undefined): Entry {
  const k = key3(slug, name, env);
  let e = entries.get(k);
  if (!e) {
    e = { slug, name, env, state: { state: 'loading' }, subs: new Set(), users: 0, inflight: false, again: false, timer: null, lastAt: 0, retry: null, backoff: 0 };
    entries.set(k, e);
  }
  return e;
}

function setState(e: Entry, state: Loaded<ScenarioActions>): void {
  e.state = state;
  for (const s of [...e.subs]) s();
}

function load(e: Entry): void {
  if (e.inflight) {
    e.again = true;
    return;
  }
  if (e.retry !== null) window.clearTimeout(e.retry);
  e.retry = null;
  e.inflight = true;
  e.lastAt = Date.now();
  actionReads.count++;
  call<ScenarioActions>('scenario_actions', { project: e.slug, name: e.name, ...(e.env ? { env: e.env } : {}) }).then(
    (data) => {
      e.backoff = 0;
      settlePending(e.slug, e.name, data);
      setState(e, { state: 'ready', data });
    },
    (err: unknown) => {
      if (err instanceof SessionEnded) return;
      e.backoff = e.backoff === 0 ? ERROR_RETRY_MS : Math.min(e.backoff * 2, ERROR_RETRY_MAX_MS);
      setState(e, { state: 'error', error: errorText(err), ...(err instanceof CallError ? { code: err.error.code } : {}) });
    },
  ).finally(() => {
    e.inflight = false;
    if (e.again) {
      e.again = false;
      load(e);
    } else if (e.state.state === 'error' && e.users > 0 && e.retry === null) {
      e.retry = window.setTimeout(() => {
        e.retry = null;
        if (e.users > 0) load(e);
      }, e.backoff);
    }
  });
}

function throttled(e: Entry, ms: number): void {
  if (e.timer !== null) return;
  e.timer = window.setTimeout(() => {
    e.timer = null;
    if (e.users > 0) load(e);
  }, Math.max(0, e.lastAt + ms - Date.now()));
}

const LOADING: Loaded<never> = { state: 'loading' };
const NO_SUB = () => () => undefined;
const NO_STATE = () => LOADING;

/** The status bar's read of a scenario on a location (null: none — no scenario, or the Scenario screen feeds it). */
export function useScenarioActions(slug: string | null, name: string | null, env: string | undefined): Loaded<ScenarioActions> {
  const e = slug !== null && name !== null ? entryOf(slug, name, env) : null;
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!e) return () => undefined;
      e.subs.add(fn);
      return () => {
        e.subs.delete(fn);
      };
    },
    [e],
  );
  const snap = useCallback(() => (e ? e.state : LOADING), [e]);
  const state = useSyncExternalStore(e ? subscribe : NO_SUB, e ? snap : NO_STATE);
  useEffect(() => {
    if (!e) return;
    e.users++;
    if (e.users === 1 && !e.inflight) load(e);
    return () => {
      e.users--;
      if (e.users === 0 && e.retry !== null) {
        window.clearTimeout(e.retry);
        e.retry = null;
      }
    };
  }, [e]);
  return state as Loaded<ScenarioActions>;
}

const runChanged = new Set<{ slug: string; name: string; fn: { current: () => void } }>();

/**
 * Re-read every entry of a scenario now (after a start, a stop, a refusal) — and tell the screens that read the
 * scenario's runs themselves (the Scenario screen's view): a queued run stopped is cancelled at once, but its run.json
 * only changes once a worker takes it, so no file event would say so (L5.10b's Cancel read the view again the same way).
 */
export function reloadActions(slug: string, name: string): void {
  for (const e of entries.values()) if (e.slug === slug && e.name === name && e.users > 0) load(e);
  for (const l of [...runChanged]) if (l.slug === slug && l.name === name) l.fn.current();
}

/** Call `fn` when this tab started, stopped or was refused a run of the scenario (reloadActions). */
export function useRunChanged(slug: string, name: string, fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = { slug, name, fn: ref };
    runChanged.add(l);
    return () => {
      runChanged.delete(l);
    };
  }, [slug, name]);
}

/** What an entry does with an event (pure): read now, read soon, or nothing. `seen`: the job ids met so far (added to). */
export function shootEventAction(e: StudioEvent, entry: { slug: string; name: string; data: ScenarioActions | null }, seen: Set<string>): 'now' | 'jobs' | 'render' | null {
  if (e.type === 'resync') return 'now';
  if (e.type === 'jobs') {
    const other = Array.isArray(e.projects) && !e.projects.includes(entry.slug);
    if (other) {
      for (const id of e.changed) seen.add(id);
      return null;
    }
    // A run's job is rewritten at every step (its progress): never a re-read (review A-M1 of L5.11a). Its end is caught by
    // run.json's status change (a workspace event), by useRunProgress's `onEnded` and by Stop's own reload.
    const render = entry.data?.render_job?.job;
    let out: 'jobs' | 'render' | null = null;
    for (const id of e.changed) {
      if (id === render) out = out ?? 'render';
      else if (!seen.has(id)) out = 'jobs';
      seen.add(id);
    }
    return out;
  }
  if (e.type !== 'workspace') return null;
  if (Array.isArray(e.files) && e.files.includes(entry.slug)) return 'now';
  return scenarioEventAction(e, entry.slug, entry.name).reread ? 'now' : null;
}

const seenJobs = new Set<string>();

/** The shell keeps the entries fresh (one listener for all of them: events and a window focus). */
export function useShootEvents(): void {
  useEvents((ev) => {
    for (const e of entries.values()) {
      if (e.users === 0) continue;
      const data = e.state.state === 'ready' ? e.state.data : null;
      if (data?.render_job) seenJobs.add(data.render_job.job);
      if (data?.running?.job) seenJobs.add(data.running.job);
      const a = shootEventAction(ev, { slug: e.slug, name: e.name, data }, seenJobs);
      if (a === 'now') load(e);
      else if (a === 'jobs') throttled(e, JOBS_THROTTLE_MS);
      else if (a === 'render') throttled(e, RENDER_JOBS_THROTTLE_MS);
    }
  });
  useEffect(() => {
    const onFocus = () => {
      for (const e of entries.values()) if (e.users > 0) load(e);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
}

// ── the Scenario screen's own view, fed to the status bar (critique H2) ───────────────────────────────────────────────

/** A run's progress as `run_status` tells it (the status bar's line, the Scenario screen's Running callout). */
export interface LiveRun {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  paused?: { scene: string; step: number };
  stopping?: boolean;
  pausing?: boolean;
  finished: boolean;
}

export type FedActions = Pick<ScenarioActions, 'hash' | 'ok' | 'environment' | 'run_blockers' | 'runs' | 'running' | 'capture' | 'render_job'> & { env: string | undefined; live: LiveRun | null };

const fed = new Map<string, ReturnType<typeof store<FedActions | null>>>();
function fedOf(slug: string, name: string) {
  const k = key2(slug, name);
  let s = fed.get(k);
  if (!s) fed.set(k, (s = store<FedActions | null>(null)));
  return s;
}

/** The Scenario screen feeds what it read (its view, its run_status, its renders) while it is mounted. */
export function useFeedActions(slug: string, name: string, data: FedActions | null): void {
  const s = fedOf(slug, name);
  useEffect(() => {
    if (data) {
      settlePending(slug, name, data);
      s.set(data);
    }
  }, [s, data, slug, name]);
  useEffect(() => () => s.set(null), [s]);
}

export function useFedActions(slug: string | null, name: string | null): FedActions | null {
  const s = slug !== null && name !== null ? fedOf(slug, name) : null;
  return useSyncExternalStore(s ? s.subscribe : NO_SUB, s ? s.get : () => null);
}

// ── the file on screen ────────────────────────────────────────────────────────────────────────────────────────────────

const shownFiles = new Map<string, Array<{ hash: string; run?: string }>>();

/** A screen showing a scenario's file registers its hash (and the capture it shows: a timeline's run) while mounted. */
export function useShownFile(slug: string, name: string, hash: string | null, run?: string): void {
  useEffect(() => {
    if (!hash) return;
    const k = key2(slug, name);
    const item = { hash, ...(run ? { run } : {}) };
    shownFiles.set(k, [...(shownFiles.get(k) ?? []), item]);
    return () => {
      const left = (shownFiles.get(k) ?? []).filter((x) => x !== item);
      if (left.length) shownFiles.set(k, left);
      else shownFiles.delete(k);
    };
  }, [slug, name, hash, run]);
}

/** The file on screen now (the latest screen's), or undefined. */
export function shownFile(slug: string, name: string): { hash: string; run?: string } | undefined {
  const l = shownFiles.get(key2(slug, name));
  return l?.[l.length - 1];
}

// ── starts, the sheet, what the last start came to ────────────────────────────────────────────────────────────────────

export type LastStart = { mode: Mode; run_id: string; env?: string } | { mode: Mode; error: string; fix?: string; code?: string };

/** A persona a capture's `sessions_ack` must name (scenario_sessions `confirm`, a 409's `details.sessions`). */
export interface SessionToConfirm {
  persona: string;
  status: string;
  /** The run checks it before filming (a `check`, or never signed in); false: it cannot. */
  checked_first?: boolean;
}

export interface SheetAsk {
  slug: string;
  name: string;
  env?: string;
  hash?: string;
  sessions: SessionToConfirm[];
  onStarted?: (runId: string) => void;
}

const sending = new Map<string, Mode | 'render'>();
const lastStarts = store(new Map<string, LastStart>());
const pending = store(new Map<string, { id: string; mode: Mode; at: number }>());
const sheet = store<SheetAsk | null>(null);
const signInAsk = store<{ slug: string; name: string; persona: string } | null>(null);
const sendingStore = store(0);

function settlePending(slug: string, name: string, data: Pick<ScenarioActions, 'runs'>): void {
  const k = key2(slug, name);
  const p = pending.get().get(k);
  if (p && (data.runs.some((r) => r.id === p.id) || Date.now() - p.at > PENDING_MS)) {
    const next = new Map(pending.get());
    next.delete(k);
    pending.set(next);
  }
}

/**
 * A run of the scenario this tab just queued and no read shows yet (critique L3), or null. `runs`: what the caller read
 * (a read that already lists it — it may come before scenario_run's answer — ends the wait).
 */
export function usePendingRun(slug: string | null, name: string | null, runs: ReadonlyArray<{ id: string }> | undefined): { id: string; mode: Mode } | null {
  const m = useSyncExternalStore(pending.subscribe, pending.get);
  if (slug === null || name === null) return null;
  const p = m.get(key2(slug, name));
  return p && Date.now() - p.at <= PENDING_MS && !runs?.some((r) => r.id === p.id) ? p : null;
}

export function useLastStart(slug: string, name: string): LastStart | undefined {
  return useSyncExternalStore(lastStarts.subscribe, lastStarts.get).get(key2(slug, name));
}

/** The scenario is being started (or rendered) by this tab right now. */
export function useSending(slug: string | null, name: string | null): Mode | 'render' | null {
  useSyncExternalStore(sendingStore.subscribe, sendingStore.get);
  return slug !== null && name !== null ? (sending.get(key2(slug, name)) ?? null) : null;
}

export const useSheet = () => useSyncExternalStore(sheet.subscribe, sheet.get);
export const closeSheet = () => sheet.set(null);
export function openSheet(ask: SheetAsk): void {
  sheet.set(ask);
}
export const useSignInAsk = () => useSyncExternalStore(signInAsk.subscribe, signInAsk.get);
export const askSignIn = (a: { slug: string; name: string; persona: string } | null) => signInAsk.set(a);

function setLast(slug: string, name: string, v: LastStart | null): void {
  const next = new Map(lastStarts.get());
  if (v) next.set(key2(slug, name), v);
  else next.delete(key2(slug, name));
  lastStarts.set(next);
}

function setSending(slug: string, name: string, v: Mode | 'render' | null): void {
  if (v) sending.set(key2(slug, name), v);
  else sending.delete(key2(slug, name));
  sendingStore.set(sendingStore.get() + 1);
}

/** What scenario_run answers (the fields the page reads). */
interface RunAnswer {
  run_id: string;
  job: string;
  mode: Mode;
}

/**
 * Queue a rehearsal or a capture of a scenario — false (nothing sent) while one of it is being sent by this tab (a held
 * key, a click and a menu command in the same tick: ONE call). `hash`: the file as shown; `env`: only a location that is
 * not the file's own; `ack`: the personas the person confirmed (a capture). A capture refused for sessions to confirm
 * opens the confirmation sheet; any other refusal is the scenario's last start (with its command) and said.
 */
export function startRun(o: { slug: string; name: string; mode: Mode; hash?: string; env?: string; ack?: string[]; say: (s: string) => void; onStarted?: (runId: string) => void }): boolean {
  const k = key2(o.slug, o.name);
  if (sending.has(k)) return false;
  setSending(o.slug, o.name, o.mode);
  setLast(o.slug, o.name, null);
  const where = o.env ? ` on ${o.env}` : '';
  call<RunAnswer>('scenario_run', { project: o.slug, name: o.name, mode: o.mode, ...(o.hash ? { hash: o.hash } : {}), ...(o.env ? { env: o.env } : {}), ...(o.ack ? { sessions_ack: o.ack } : {}) })
    .then(
      (d) => {
        setLast(o.slug, o.name, { mode: o.mode, run_id: d.run_id, ...(o.env ? { env: o.env } : {}) });
        const next = new Map(pending.get());
        next.set(k, { id: d.run_id, mode: o.mode, at: Date.now() });
        pending.set(next);
        o.say(`${modeWord(o.mode)} of ${o.name}${where} queued`);
        o.onStarted?.(d.run_id);
      },
      (e: unknown) => {
        if (e instanceof SessionEnded) return;
        const listed = e instanceof CallError ? (e.error.details?.sessions as SessionToConfirm[] | undefined) : undefined;
        if (o.mode === 'capture' && Array.isArray(listed) && listed.length > 0) {
          openSheet({ slug: o.slug, name: o.name, ...(o.env ? { env: o.env } : {}), ...(o.hash ? { hash: o.hash } : {}), sessions: listed, ...(o.onStarted ? { onStarted: o.onStarted } : {}) });
          return;
        }
        const message = errorText(e);
        setLast(o.slug, o.name, { mode: o.mode, error: message, ...(e instanceof CallError && e.error.fix ? { fix: e.error.fix } : {}), ...(e instanceof CallError ? { code: e.error.code } : {}) });
        o.say(`The ${modeWord(o.mode, true)} of ${o.name} was not started: ${message.split('\n')[0].slice(0, 200)}`);
      },
    )
    .finally(() => {
      setSending(o.slug, o.name, null);
      reloadActions(o.slug, o.name);
    });
  return true;
}

/** Queue a render of the capture shown (once at a time per scenario in this tab). */
export function startRender(o: { slug: string; name: string; run: string; hash: string; say: (s: string) => void }): boolean {
  const k = key2(o.slug, o.name);
  if (sending.has(k)) return false;
  setSending(o.slug, o.name, 'render');
  call<{ render_id: string }>('scenario_render', { project: o.slug, name: o.name, run: o.run, expect_edit_sha256: o.hash })
    .then(
      (d) => o.say(`Render ${d.render_id} of ${o.name} queued`),
      (e: unknown) => {
        if (!(e instanceof SessionEnded)) o.say(`The render of ${o.name} was not started: ${errorText(e).split('\n')[0].slice(0, 200)}`);
      },
    )
    .finally(() => {
      setSending(o.slug, o.name, null);
      reloadActions(o.slug, o.name);
    });
  return true;
}

/** Stop a run of a job (its teardown and rollbacks still run). */
export function stopRun(o: { slug: string; name: string; run: string; mode: string; say: (s: string) => void; onDone?: () => void }): void {
  call('run_cancel', { project: o.slug, run_id: o.run }).then(
    () => {
      o.say(`Stopping the ${modeWord(o.mode, true)} of ${o.name}: its teardown and rollbacks still run`);
      o.onDone?.();
    },
    (e: unknown) => {
      if (!(e instanceof SessionEnded)) o.say(`Not stopped: ${errorText(e).split('\n')[0].slice(0, 200)}`);
    },
  ).finally(() => reloadActions(o.slug, o.name));
}

/** Pause (before the next step) or resume a run of a job. */
export function pauseRun(o: { slug: string; name: string; run: string; paused: boolean; say: (s: string) => void; onDone?: () => void }): void {
  call('run_pause', { project: o.slug, run_id: o.run, paused: o.paused }).then(
    () => {
      o.say(o.paused ? 'Pausing before the next step' : 'Resuming');
      o.onDone?.();
    },
    (e: unknown) => {
      if (!(e instanceof SessionEnded)) o.say(`${o.paused ? 'Not paused' : 'Not resumed'}: ${errorText(e).split('\n')[0].slice(0, 200)}`);
    },
  );
}

// ── the live screen's arrival after a start ───────────────────────────────────────────────────────────────────────────

let liveFocus: string | null = null;
/** A start from this tab opens run `id`'s live screen: its title takes the focus there (review A-M2: never <body>). */
export function focusLiveOnArrival(id: string): void {
  liveFocus = id;
}
/** True once for the run a start opened (its live screen focuses its title). */
export function takeLiveFocus(id: string): boolean {
  if (liveFocus !== id) return false;
  liveFocus = null;
  return true;
}

// ── a running run's progress (run_status) ─────────────────────────────────────────────────────────────────────────────

/** run_status's answer, as far as the progress line reads it. */
interface RunStatusAnswer {
  id: string;
  mode: string;
  status: string;
  steps_done: number;
  steps_total: number;
  current?: { scene: string; step: number; action: string };
  paused?: { scene: string; step: number };
  finished: boolean;
  job?: { pause_requested_at?: string; cancel_requested_at?: string };
}

export function liveOf(d: RunStatusAnswer): LiveRun {
  return {
    id: d.id,
    mode: d.mode,
    status: d.status,
    steps_done: d.steps_done,
    steps_total: d.steps_total,
    ...(d.current ? { current: d.current } : {}),
    ...(d.paused ? { paused: { scene: d.paused.scene, step: d.paused.step } } : {}),
    ...(d.job?.cancel_requested_at ? { stopping: true } : {}),
    ...(d.job?.pause_requested_at && !d.paused ? { pausing: true } : {}),
    finished: d.finished,
  };
}

/**
 * At most one `run_status` read at a time for the run of `slug` (one more after it when progress came meanwhile): at
 * once, on its progress events and on job changes. When the run is finished — interrupted included — `onEnded` runs
 * (once per run). Null id: nothing read.
 */
export function useRunProgress(slug: string | null, runId: string | null, onEnded?: () => void): [LiveRun | null, (runs: string[]) => void] {
  const [live, setLive] = useState<LiveRun | null>(null);
  const busy = useRef(false);
  const again = useRef<string | null>(null);
  const endedFor = useRef<string | null>(null);
  const runningRef = useRef(runId);
  runningRef.current = runId;
  const endedRef = useRef(onEnded);
  endedRef.current = onEnded;
  const read = useCallback(
    (id: string) => {
      if (slug === null) return;
      if (busy.current) {
        again.current = id;
        return;
      }
      busy.current = true;
      call<RunStatusAnswer>('run_status', { project: slug, run_id: id })
        .then(
          (d) => {
            setLive(liveOf(d));
            if (d.finished && d.id === runningRef.current && endedFor.current !== d.id) {
              endedFor.current = d.id;
              endedRef.current?.();
            }
          },
          () => undefined,
        )
        .finally(() => {
          busy.current = false;
          const next = again.current;
          again.current = null;
          if (next) read(next);
        });
    },
    [slug],
  );
  useEffect(() => {
    if (runId) read(runId);
    else setLive(null);
  }, [runId, read]);
  const progress = useCallback(
    (runs: string[]) => {
      // [] (a jobs event): the running run, if any — its job may have ended without a word from its run.json.
      const id = runId && (runs.length === 0 || runs.includes(runId)) ? runId : runs[0];
      if (id) read(id);
    },
    [runId, read],
  );
  return [live, progress];
}

// ── Prepare's "Live picture during a capture" (a per-tab preference, off by default) ──────────────────────────────────

const capturePicture = store(false);
/** Whether a capture's live picture is on from its start (the live screen's initial choice for a capture). */
export function useCapturePicture(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(capturePicture.subscribe, capturePicture.get), capturePicture.set];
}
export const capturePictureOn = () => capturePicture.get();
