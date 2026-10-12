// Buyer notifications store shared by the bell and the pages: loaded once per page load, refreshed when the bell
// opens, and polled every second while a page is open (L2.11) — a proposal the roaster sends shows on the bell (unread
// badge, the bell rings) about a second later, like the live quote lists.

import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../shared/api.js';

/** How often an open page asks for new notifications (ms). */
const POLL_MS = 1000;

let state = { unread: 0, items: [], loaded: false };
const listeners = new Set();
/** Bumped by every load and change made here: a poll answer that started before it is stale and dropped. */
let version = 0;

function set(next) {
  state = { ...next, loaded: true };
  for (const l of listeners) l();
}

export async function refreshNotifications() {
  const v = ++version;
  const next = await api.get('/api/notifications');
  if (v === version) set(next);
}

export async function markNotificationsRead(ids) {
  version++;
  set(await api.post('/api/notifications/read', ids ? { ids } : {}));
}

async function poll() {
  const v = version;
  const next = await api.get('/api/notifications');
  // Only a change re-renders (an unchanged answer keeps the snapshot, so nothing restarts).
  if (v === version && JSON.stringify({ unread: next.unread, items: next.items }) !== JSON.stringify({ unread: state.unread, items: state.items })) set(next);
}

let started = false;
let polling = false;

export function useNotifications() {
  const snapshot = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
  useEffect(() => {
    if (started) return;
    started = true;
    refreshNotifications().catch(() => {
      started = false;
    });
    if (!polling) {
      polling = true;
      setInterval(() => poll().catch(() => {}), POLL_MS);
    }
  }, []);
  return snapshot;
}
