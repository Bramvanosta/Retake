// Buyer notifications store shared by the bell and the pages. Loaded once per page load and
// refreshed when the bell opens — there is no polling, so a proposal added while the page is
// open only shows up on the next load (deterministic for scripted videos).

import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../shared/api.js';

let state = { unread: 0, items: [], loaded: false };
const listeners = new Set();

function set(next) {
  state = { ...next, loaded: true };
  for (const l of listeners) l();
}

export async function refreshNotifications() {
  set(await api.get('/api/notifications'));
}

export async function markNotificationsRead(ids) {
  set(await api.post('/api/notifications/read', ids ? { ids } : {}));
}

let started = false;

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
  }, []);
  return snapshot;
}
