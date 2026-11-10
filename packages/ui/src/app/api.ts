/**
 * Calls to the Studio server's `/v1` API: the bearer token in a header (never a cookie, never a URL), no credentials.
 * The token of this tab is set once by the bootstrap (`setToken`); every answer updates the connection state the shell
 * shows (a network failure → offline; a 401 → the session ended).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionEnded, endSession } from './session.js';
import type { StudioOp, StudioOps } from './data/ops.js';

export interface ApiError {
  code: string;
  message: string;
  fix?: string;
  details?: Record<string, unknown>;
}

export class CallError extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'CallError';
  }
}

export type Connection = 'connecting' | 'online' | 'offline' | 'ended';

let token: string | null = null;
let connection: Connection = 'connecting';
const listeners = new Set<(c: Connection) => void>();

function setConnection(c: Connection): void {
  if (c === connection || connection === 'ended') return;
  connection = c;
  for (const l of listeners) l(c);
}

export function setToken(t: string): void {
  token = t;
}

/** The server no longer knows this tab's token (a 401, here or on the event stream): the session ended. */
export function sessionEnded(): void {
  endSession();
  setConnection('ended');
}

/** The connection state, re-rendered on change. */
export function useConnection(): Connection {
  const [c, setC] = useState(connection);
  useEffect(() => {
    listeners.add(setC);
    setC(connection);
    return () => {
      listeners.delete(setC);
    };
  }, []);
  return c;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (token === null) throw new SessionEnded();
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, credentials: 'omit', cache: 'no-store' });
  } catch {
    // A call this tab gave up on (its signal) is not a lost server.
    if (init.signal?.aborted) throw new CallError(0, { code: 'cancelled', message: 'cancelled' });
    setConnection('offline');
    throw new CallError(0, { code: 'unavailable', message: 'The Studio server does not answer: is `retake ui` still running?' });
  }
  if (res.status === 401) {
    sessionEnded();
    throw new SessionEnded();
  }
  setConnection('online');
  let body: { ok?: boolean; data?: T; error?: ApiError };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    if (init.signal?.aborted) throw new CallError(0, { code: 'cancelled', message: 'cancelled' });
    body = {};
  }
  if (!res.ok || !body.ok) throw new CallError(res.status, body.error ?? { code: 'internal', message: `HTTP ${res.status}` });
  return body.data as T;
}

/**
 * A stream route (`POST /v1/live`, L4.4): the response to read as server-sent events, or its status when it is not one
 * (503 every stream slot taken, 404 no such run…) with the server's error. A 401 ends the session; a network failure
 * is `{status: 0}` (the caller retries). Same headers as a call: the token in a header, no credentials, no cache.
 */
export async function openStream(path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; res?: Response; error?: ApiError }> {
  if (token === null) throw new SessionEnded();
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
  } catch {
    if (!signal.aborted) setConnection('offline');
    return { status: 0 };
  }
  if (res.status === 401) {
    sessionEnded();
    throw new SessionEnded();
  }
  setConnection('online');
  if (res.ok && res.body) return { status: res.status, res };
  let error: ApiError | undefined;
  try {
    error = ((await res.json()) as { error?: ApiError }).error;
  } catch {
    /* not JSON */
  }
  return { status: res.status, ...(error ? { error } : {}) };
}

/** `GET /v1/info`: the engine's info, the HTTP API version and the ops this server allows. */
export function info<T>(): Promise<T> {
  return request<T>('/v1/info');
}

/** A call's options: `signal` aborts it, `keepalive` lets it outlive the page. */
export interface CallOptions {
  signal?: AbortSignal;
  keepalive?: boolean;
}

/** An op's arguments and its result (StudioOps, data/ops.ts: derived from the Studio's op table). */
export type OpArgs<K extends StudioOp> = StudioOps[K]['args'];
export type OpResult<K extends StudioOp> = StudioOps[K]['result'];
/** A call's parameters after the op: its arguments — optional when the op needs none — and the options. */
export type OpParams<K extends StudioOp> = {} extends OpArgs<K> ? [args?: OpArgs<K>, o?: CallOptions] : [args: OpArgs<K>, o?: CallOptions];

function callOp(op: string, args: object, o: CallOptions): Promise<unknown> {
  return request<unknown>(`/v1/call/${encodeURIComponent(op)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    ...(o.signal ? { signal: o.signal } : {}),
    // L5.2b: the unsaved report's last call on pagehide outlives the page.
    ...(o.keepalive ? { keepalive: true } : {}),
  });
}

/**
 * `POST /v1/call/<op>`: one op of the allow-list with its arguments; the tool's data, or a CallError. `signal` aborts
 * it (the server then stops the op: closing the request aborts its work) — a CallError `cancelled`. `keepalive`: the
 * request outlives the page (a `pagehide` report). Typed by StudioOps (L6.12): an op the Studio does not serve, an
 * argument its input refuses or a result read as another type is a compile error. Only data/ calls it (L6.13).
 */
export function call<K extends StudioOp>(op: K, ...a: OpParams<K>): Promise<OpResult<K>> {
  const [args = {}, o = {}] = a as [object?, CallOptions?];
  return callOp(op, args, o) as Promise<OpResult<K>>;
}

export function errorText(e: unknown): string {
  if (e instanceof CallError) return e.error.message;
  return e instanceof Error ? e.message : String(e);
}

export type Loaded<T> = { state: 'loading' } | { state: 'error'; error: string; code?: string } | { state: 'ready'; data: T };

/**
 * One op's answer for a component: loads on mount and when `key` changes, `reload()` refetches (keeping the last data
 * on screen while it does), and a window focus refetches (a cheap fallback to the event stream: events.ts).
 */
export function useCall<K extends StudioOp>(op: K, args: OpArgs<K>, key: string): [Loaded<OpResult<K>>, () => void] {
  type T = OpResult<K>;
  const [v, setV] = useState<Loaded<T>>({ state: 'loading' });
  const argsRef = useRef(args);
  argsRef.current = args;
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    (callOp(op, argsRef.current, {}) as Promise<T>).then(
      (data) => n === seq.current && setV({ state: 'ready', data }),
      (e: unknown) => {
        if (n !== seq.current || e instanceof SessionEnded) return;
        setV({ state: 'error', error: errorText(e), ...(e instanceof CallError ? { code: e.error.code } : {}) });
      },
    );
  }, [op]);
  useEffect(() => {
    setV({ state: 'loading' });
    load();
    window.addEventListener('focus', load);
    return () => {
      seq.current++;
      window.removeEventListener('focus', load);
    };
  }, [load, key]);
  return [v, load];
}
