/**
 * Live updates (L4.1 part 3): the server's event stream `GET /v1/events`, read through `fetch` (the token in a header —
 * EventSource cannot send one) — ONE stream per browser, not per tab (critique B1: over HTTP/1.1 every stream holds
 * one of the browser's 6 connections to this server; at 6 tabs every call would hang, and a 7th tab would not load).
 *
 * - The tab that holds the Web Lock `demo-studio.events` reads the stream and relays each event to the other tabs over
 *   the BroadcastChannel of the same name; when it closes, the lock passes to another tab, which opens the stream.
 * - Without Web Locks (an old browser) every tab reads its own stream; the server serves 4 at most and answers the
 *   next 503: that tab — or a leader refused for the same reason — re-reads what it shows every 3 s instead, for 30 s,
 *   then tries the stream again.
 * - When a stream opens again after one was lost (its `hello`), and at each tick of that timer, subscribers get
 *   `resync`: re-read whatever they show (what changed meanwhile was told to nobody).
 *
 * Events carry slugs and job ids only (never text of a file); a subscriber re-reads through `/v1/call`.
 */
import { useEffect, useRef, useState } from 'react';
import { sessionEnded } from './api.js';

export type StudioEvent =
  | { type: 'workspace'; projects: string[]; readme: string[] }
  | { type: 'jobs'; changed: string[] }
  | { type: 'index'; generation: number }
  | { type: 'resync' };

/** How this tab learns about changes. */
export type EventMode = 'connecting' | 'stream' | 'relay' | 'polling' | 'off';

const NAME = 'demo-studio.events';
export const POLL_FALLBACK_MS = 3000;

const listeners = new Set<(e: StudioEvent) => void>();
const modeListeners = new Set<(m: EventMode) => void>();
let mode: EventMode = 'connecting';
let channel: BroadcastChannel | null = null;
let started = false;

function setMode(m: EventMode): void {
  if (m === mode) return;
  mode = m;
  for (const l of modeListeners) l(m);
}

function dispatch(e: StudioEvent): void {
  for (const l of [...listeners]) l(e);
}

/** An event for this tab and, through the channel, every other tab of this Studio. */
function publish(e: StudioEvent): void {
  dispatch(e);
  channel?.postMessage(e);
}

function isEvent(v: unknown): v is StudioEvent {
  const t = (v as { type?: unknown } | null)?.type;
  return t === 'workspace' || t === 'jobs' || t === 'index' || t === 'resync';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type StreamEnd = 'closed' | 'busy' | 'ended' | 'failed';

/** Read one stream until it ends. `first`: no resync for its hello (the screens just loaded their data). */
async function readStream(token: string, first: boolean): Promise<StreamEnd> {
  let res: Response;
  try {
    res = await fetch('/v1/events', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, credentials: 'omit', cache: 'no-store' });
  } catch {
    return 'failed';
  }
  if (res.status === 401) return 'ended';
  if (res.status === 503) return 'busy';
  if (!res.ok || !res.body) return 'failed';
  setMode('stream');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 'closed';
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!type || data === undefined) continue; // a comment line (keepalive)
        if (type === 'hello') {
          if (!first) publish({ type: 'resync' });
          continue;
        }
        let body: unknown;
        try {
          body = JSON.parse(data);
        } catch {
          continue;
        }
        const e = { ...(body as object), type };
        if (isEvent(e)) publish(e);
      }
    }
  } catch {
    return 'failed';
  }
}

/** Hold the stream for this browser: until the session ends (the lock is then released). */
async function lead(token: string): Promise<void> {
  let first = true;
  let backoff = 1000;
  for (;;) {
    setMode('connecting');
    const end = await readStream(token, first);
    if (end === 'ended') {
      setMode('off');
      sessionEnded();
      return;
    }
    if (end === 'closed') backoff = 1000;
    if (end === 'busy') {
      // Every stream slot is taken (another browser, or a browser without Web Locks): re-read on a timer, try again later.
      setMode('polling');
      for (let t = 0; t < 10; t++) {
        await sleep(POLL_FALLBACK_MS);
        publish({ type: 'resync' });
      }
    } else {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
    // The next stream's hello is the resync: whatever changed while no stream was open.
    first = false;
  }
}

/** Start live updates for this tab (once): lead the browser's stream when this tab gets the lock, relay meanwhile. */
export function startEvents(token: string): void {
  if (started) return;
  started = true;
  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel(NAME);
    channel.onmessage = (m: MessageEvent) => {
      if (isEvent(m.data)) dispatch(m.data);
    };
  }
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks && channel) {
    setMode('relay');
    void locks.request(NAME, () => lead(token)).catch(() => setMode('off'));
  } else void lead(token);
}

/** Call `fn` for every event while the component is mounted (the latest `fn`). */
export function useEvents(fn: (e: StudioEvent) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const l = (e: StudioEvent) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** How this tab learns about changes, re-rendered on change. */
export function useEventMode(): EventMode {
  const [m, set] = useState(mode);
  useEffect(() => {
    modeListeners.add(set);
    set(mode);
    return () => {
      modeListeners.delete(set);
    };
  }, []);
  return m;
}

/** Call `fn` when a project's files changed (any of them), or after a reconnection. */
export function useProjectEvents(slug: string, fn: () => void): void {
  useEvents((e) => {
    if ((e.type === 'workspace' && e.projects.includes(slug)) || e.type === 'resync') fn();
  });
}
