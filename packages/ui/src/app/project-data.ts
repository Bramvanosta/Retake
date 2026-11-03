/**
 * L5.10a: the open project's shared reads — `project_get` (its environments, README, warnings), `project_board` (the
 * poster grid, the smart groups' counts, the inspector) and `auth_status` (the Cast) — one module-level entry per op
 * and project (one call in flight; a reload asked meanwhile runs once after it), read by the shell's browser and the
 * screens alike through `useSyncExternalStore`: opening a project costs one read of each.
 * L5.10a fixes (reviews A-H1, B-H1): the store's `subscribe` is stable per entry (an inline one made React unsubscribe
 * and resubscribe at every render — the "first reader" rule then re-read all three ops at every re-render of the shell:
 * a read per step of a take, a read loop on an error). Reading is no longer the subscription's business: the first
 * reader of an entry (or one coming back to the project) reads it in an effect; a re-render reads nothing. An entry in
 * error is read again on an event, a focus, a Retry or after ERROR_RETRY_MS (doubling, at most ERROR_RETRY_MAX_MS)
 * while someone reads it — never in a loop.
 *
 * What re-reads them (critique M2, `boardEventAction`): a reconnection (all); a run of the project that appeared,
 * changed status or went away, a scenario file, a render file (the board); README (the project); the project's own
 * files otherwise (all three). A run that only progressed re-reads nothing here — the Project screen asks `run_status`
 * for the takes it shows running (ProductionsScreen). A `jobs` event re-reads the board (at most every 2 s) only for a
 * job it shows (a render's progress) or a job it never saw (a new render or take); the Cast at most every 10 s. A
 * window focus re-reads each once. A job event naming its projects (`projects`, L5.10a fixes) re-reads only theirs.
 * Nothing re-reads the board on every step of a capture (studio-e2e-board-reads counts the calls).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { AuthStatus, ProjectBoardView, ProjectView } from '@retake/engine';
import { CallError, call, errorText } from './api.js';
import type { Loaded } from './api.js';
import type { StudioEvent } from './events.js';
import { useEvents } from './events.js';
import { SessionEnded } from './session.js';

export type ProjectOp = 'project_get' | 'project_board' | 'auth_status';
type DataOf<O extends ProjectOp> = O extends 'project_get' ? ProjectView : O extends 'project_board' ? ProjectBoardView : AuthStatus;

/** Board re-reads on job changes: at most one per this. */
export const BOARD_JOBS_THROTTLE_MS = 2000;
/** Cast re-reads on job changes (a sign-in): at most one per this. */
export const CAST_JOBS_THROTTLE_MS = 10_000;
/** An entry in error is read again after this (then twice as long each time, at most ERROR_RETRY_MAX_MS). */
export const ERROR_RETRY_MS = 2000;
export const ERROR_RETRY_MAX_MS = 60_000;

interface Entry {
  op: ProjectOp;
  slug: string;
  state: Loaded<unknown>;
  subs: Set<() => void>;
  /** Readers mounted (screens and the shell): the first one reads. */
  users: number;
  inflight: boolean;
  again: boolean;
  timer: number | null;
  lastAt: number;
  /** The read after an error, and its delay (0: no error). */
  retry: number | null;
  backoff: number;
}

const entries = new Map<string, Entry>();
/** Reads made per op (tests count them through the server; this is for the page's own checks). */
export const reads: Record<ProjectOp, number> = { project_get: 0, project_board: 0, auth_status: 0 };

function entryOf(op: ProjectOp, slug: string): Entry {
  const key = `${op}\0${slug}`;
  let e = entries.get(key);
  if (!e) {
    e = { op, slug, state: { state: 'loading' }, subs: new Set(), users: 0, inflight: false, again: false, timer: null, lastAt: 0, retry: null, backoff: 0 };
    entries.set(key, e);
  }
  return e;
}

function set(e: Entry, state: Loaded<unknown>): void {
  e.state = state;
  for (const s of [...e.subs]) s();
}

function clearRetry(e: Entry): void {
  if (e.retry !== null) window.clearTimeout(e.retry);
  e.retry = null;
}

/** Read now (or once more after the read in flight). */
function load(e: Entry): void {
  if (e.inflight) {
    e.again = true;
    return;
  }
  clearRetry(e);
  e.inflight = true;
  e.lastAt = Date.now();
  reads[e.op]++;
  call<unknown>(e.op, { project: e.slug }).then(
    (data) => {
      e.backoff = 0;
      set(e, { state: 'ready', data });
    },
    (err: unknown) => {
      if (err instanceof SessionEnded) return;
      // Read again later, not now (reviews A-H1 / B-H1: an error re-read at once looped hundreds of times a second).
      e.backoff = e.backoff === 0 ? ERROR_RETRY_MS : Math.min(e.backoff * 2, ERROR_RETRY_MAX_MS);
      set(e, { state: 'error', error: errorText(err), ...(err instanceof CallError ? { code: err.error.code } : {}) });
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

/** Read within `ms` of the last read, once (several asks in the window: one read). */
function throttled(e: Entry, ms: number): void {
  if (e.timer !== null) return;
  const wait = Math.max(0, e.lastAt + ms - Date.now());
  e.timer = window.setTimeout(() => {
    e.timer = null;
    if (e.users > 0) load(e);
  }, wait);
}

const LOADING: Loaded<never> = { state: 'loading' };
const NO_SUB = () => () => undefined;
const NO_STATE = () => LOADING;

function useEntry<O extends ProjectOp>(op: O, slug: string | null): Loaded<DataOf<O>> {
  const e = slug === null ? null : entryOf(op, slug);
  // Stable per entry: React keeps the subscription across renders (an inline function resubscribed at every one).
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
  const snapshot = useCallback(() => (e ? e.state : LOADING), [e]);
  const state = useSyncExternalStore(e ? subscribe : NO_SUB, e ? snapshot : NO_STATE);
  // The first reader of the entry (or one coming back to the project) reads it; another reader joining, a re-render
  // or a change of screen inside the project reads nothing.
  useEffect(() => {
    if (!e) return;
    e.users++;
    if (e.users === 1 && !e.inflight) load(e);
    return () => {
      e.users--;
      if (e.users === 0) clearRetry(e);
    };
  }, [e]);
  return state as Loaded<DataOf<O>>;
}

export const useProjectView = (slug: string | null) => useEntry('project_get', slug);
export const useBoard = (slug: string | null) => useEntry('project_board', slug);
export const useCast = (slug: string | null) => useEntry('auth_status', slug);

/** Re-read one of a project's entries now (a screen's own Retry). */
export function reloadProject(op: ProjectOp, slug: string): void {
  const e = entries.get(`${op}\0${slug}`);
  if (e) load(e);
}

export interface BoardEventAction {
  view: boolean;
  board: 'now' | 'throttled' | null;
  cast: 'now' | 'throttled' | null;
}

const NONE: BoardEventAction = { view: false, board: null, cast: null };

/**
 * What the open project's reads do with an event (pure). `shownJobs`: the render and review jobs the board shows;
 * `seen`: every job id met so far (the caller keeps it; this adds to it).
 */
export function boardEventAction(e: StudioEvent, slug: string, shownJobs: ReadonlySet<string>, seen: Set<string>): BoardEventAction {
  if (e.type === 'resync') return { view: true, board: 'now', cast: 'now' };
  if (e.type === 'jobs') {
    // A job event that names its projects and not this one is another project's (review A-L7).
    const other = Array.isArray(e.projects) && !e.projects.includes(slug);
    let board = false;
    for (const id of e.changed) {
      if (shownJobs.has(id) || (!seen.has(id) && !other)) board = true;
      seen.add(id);
    }
    return { view: false, board: board ? 'throttled' : null, cast: other ? null : 'throttled' };
  }
  if (e.type !== 'workspace' || !e.projects.includes(slug)) return NONE;
  const mine = (list: string[] | undefined) => Array.isArray(list) && list.some((x) => x === slug || x.startsWith(`${slug}/`));
  const runs = (Array.isArray(e.runs) ? e.runs : []).filter((r) => r.project === slug);
  const runChanged = runs.some((r) => r.change !== 'progress');
  const board = runChanged || mine(e.scenarios) || mine(e.renders);
  const view = mine(e.readme);
  const named = runs.length > 0 || mine(e.scenarios) || mine(e.renders) || mine(e.readme) || mine(e.comments) || mine(e.themes) || mine(e.components) || mine(e.records) || e.site === true;
  // L5.10a fixes: a server that names the projects whose project.yaml (sandbox.yaml, scenario list) changed — those
  // re-read everything; anything else of the project no list names is its runs folder before a run is told: the board.
  if (Array.isArray(e.files)) {
    if (e.files.includes(slug)) return { view: true, board: 'now', cast: 'now' };
    return { view, board: board || !named ? 'now' : null, cast: null };
  }
  // An older server: something of the project changed that no list names (project.yaml, its hooks): everything.
  if (!named) return { view: true, board: 'now', cast: 'now' };
  return { view, board: board ? 'now' : null, cast: null };
}

/** Run the action on the project's entries. */
function act(slug: string, a: BoardEventAction): void {
  const get = (op: ProjectOp) => entries.get(`${op}\0${slug}`);
  const view = get('project_get');
  const board = get('project_board');
  const cast = get('auth_status');
  if (a.view && view && view.users > 0) load(view);
  if (board && board.users > 0) {
    if (a.board === 'now') load(board);
    else if (a.board === 'throttled') throttled(board, BOARD_JOBS_THROTTLE_MS);
  }
  if (cast && cast.users > 0) {
    if (a.cast === 'now') load(cast);
    else if (a.cast === 'throttled') throttled(cast, CAST_JOBS_THROTTLE_MS);
  }
}

const seenJobs = new Map<string, Set<string>>();

/** The shell keeps the open project's reads fresh: events (boardEventAction) and a window focus (each once). */
export function useProjectDataEvents(slug: string | null): void {
  useEvents((e) => {
    if (slug === null) return;
    const b = entries.get(`project_board\0${slug}`);
    const data = b?.state.state === 'ready' ? (b.state.data as ProjectBoardView) : undefined;
    const shown = new Set(data?.jobs ?? []);
    const seen = seenJobs.get(slug) ?? new Set<string>();
    seenJobs.set(slug, seen);
    // What the board already knows is not news: its jobs and its running takes' jobs.
    for (const id of shown) seen.add(id);
    for (const s of data?.scenarios ?? []) if (s.running?.job) seen.add(s.running.job);
    act(slug, boardEventAction(e, slug, shown, seen));
  });
  useEffect(() => {
    if (slug === null) return;
    const onFocus = () => act(slug, { view: true, board: 'now', cast: 'now' });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [slug]);
}
