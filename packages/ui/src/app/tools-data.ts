/**
 * The app's downloaded Tools, one status every screen shares (`useTools`; its ops: data/tools.ts) — the Set-up
 * sheet's item, the status bar's control, Welcome's card, the Tools page, the Run screen's waiting words and the "not
 * downloaded yet" states of previews read the same poll: every second while a download or a check runs, every 2 s
 * while a Tools screen is open (`fast`), else every 30 s — and at once after an action (`refreshTools`). A checkout's
 * server says `available: false`: then nothing shows.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { toolsStatus } from './data/tools.js';
import type { ToolsView } from './data/ops.js';

const SLOW_MS = 30_000;
const FAST_MS = 2000;
const RUN_MS = 1000;

/** The shared status: its value, its readers, and the screens that want it fast. */
const store = {
  value: null as ToolsView | null,
  listeners: new Set<() => void>(),
  fast: 0,
  timer: null as number | null,
  reading: false,
};

function period(): number {
  const s = store.value;
  if (s && (s.state === 'downloading' || s.checking)) return RUN_MS;
  return store.fast > 0 ? FAST_MS : SLOW_MS;
}

function schedule(): void {
  if (store.timer !== null) window.clearTimeout(store.timer);
  store.timer = store.listeners.size > 0 ? window.setTimeout(() => void refreshTools(), period()) : null;
}

/** Read the status now (after an action, on a screen's open); every reader gets it. */
export async function refreshTools(): Promise<ToolsView | null> {
  if (store.reading) return store.value;
  store.reading = true;
  try {
    store.value = await toolsStatus();
    for (const l of store.listeners) l();
  } catch {
    /* kept: the next poll tries again */
  } finally {
    store.reading = false;
    schedule();
  }
  return store.value;
}

function subscribe(l: () => void): () => void {
  store.listeners.add(l);
  if (store.listeners.size === 1) void refreshTools();
  return () => {
    store.listeners.delete(l);
    if (store.listeners.size === 0) schedule();
  };
}

/** The Tools' status (null until the first answer); `fast` while a Tools screen is open. */
export function useTools(fast = false): ToolsView | null {
  // The server snapshot (a server-side render, as the Studio's tests do): no answer yet.
  const v = useSyncExternalStore(
    subscribe,
    () => store.value,
    () => null,
  );
  useEffect(() => {
    if (!fast) return;
    store.fast++;
    void refreshTools();
    return () => {
      store.fast--;
      schedule();
    };
  }, [fast]);
  return v;
}
