/**
 * Calls to the Studio server's `/v1` API: the bearer token in a header (never a cookie, never a URL), no credentials.
 * The token of this tab is set once by the bootstrap (`setToken`); every answer updates the connection state the shell
 * shows (a network failure → offline; a 401 → the session ended).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionEnded, endSession } from './session.js';

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
    setConnection('offline');
    throw new CallError(0, { code: 'unavailable', message: 'The Studio server does not answer: is `studio ui` still running?' });
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
    body = {};
  }
  if (!res.ok || !body.ok) throw new CallError(res.status, body.error ?? { code: 'internal', message: `HTTP ${res.status}` });
  return body.data as T;
}

/** `GET /v1/info`: the engine's info, the HTTP API version and the ops this server allows. */
export function info<T>(): Promise<T> {
  return request<T>('/v1/info');
}

/** `POST /v1/call/<op>`: one op of the allow-list with its arguments; the tool's data, or a CallError. */
export function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  return request<T>(`/v1/call/${encodeURIComponent(op)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
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
export function useCall<T>(op: string, args: Record<string, unknown>, key: string): [Loaded<T>, () => void] {
  const [v, setV] = useState<Loaded<T>>({ state: 'loading' });
  const argsRef = useRef(args);
  argsRef.current = args;
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    call<T>(op, argsRef.current).then(
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
