/** A recording's live view (poll and events) and the focus keeper of its screen. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RecordViewAnswer } from '../../server/record-ops.js';
import { CallError, errorText } from '../api.js';
import { recordOptions, recordView } from '../data/record.js';
import { recordEventAction, useEvents } from '../events.js';
import { DONE_POLL_MS, LIVE_POLL_MS, LIVE_STATES, newerView } from '../words/record-words.js';
import { startedJobs } from './started.js';

/** A recording's view, read live: the poll (700 ms live / 3 s after, never while the tab is hidden) and the events. */
export function useRecordView(
  slug: string,
  rec: string,
): [RecordViewAnswer | null, string | null, () => void, (v: RecordViewAnswer, fresh?: boolean) => void, () => void, () => RecordViewAnswer | null] {
  const [view, setView] = useState<RecordViewAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = useRef<string | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  const viewRef = useRef<RecordViewAnswer | null>(null);
  const looked = useRef(false);
  /** The next full view is shown whatever its revision (the server said the screen's revision is not the current one). */
  const force = useRef(false);
  /** A view to show — never an older revision over a newer one (a poll sent before an annotate came back after it). */
  const accept = useCallback((v: RecordViewAnswer, fresh = false) => {
    if (!(force.current && !v.unchanged) && !newerView(viewRef.current, v)) return;
    if (!v.unchanged) force.current = false;
    // An answer to the person's own change: any poll still on its way is older.
    if (fresh) seq.current++;
    viewRef.current = v;
    version.current = v.version;
    setView(v);
  }, []);
  const load = useCallback(() => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    const n = ++seq.current;
    // The job (until the folder exists, and once a discard removed it): record_start's in this tab, else the last view's.
    const job = startedJobs.get(rec) ?? viewRef.current?.job?.id;
    recordView({ project: slug, rec_id: rec, ...(job ? { job } : {}), ...(version.current && viewRef.current ? { since: version.current } : {}) })
      .then(
        async (v) => {
          if (n !== seq.current) return;
          setError(null);
          // No folder and no job known to this tab (a reload before the window opened): the workspace's open recording.
          if (v.state === 'missing' && !job && !looked.current) {
            looked.current = true;
            const o = await recordOptions({ project: slug }).catch(() => null);
            if (o?.open && o.open.rec_id === rec) {
              startedJobs.set(rec, o.open.job);
              again.current = true;
              return;
            }
          }
          accept(v);
        },
        (e: unknown) => {
          if (n === seq.current && !(e instanceof CallError && e.error.code === 'cancelled')) setError(errorText(e));
        },
      )
      .finally(() => {
        inFlight.current = false;
        if (again.current) {
          again.current = false;
          load();
        }
      });
  }, [slug, rec, accept]);
  useEffect(() => {
    load();
    return () => {
      seq.current++;
    };
  }, [load]);
  useEvents((e) => {
    if (recordEventAction(e, slug, rec)) load();
  });
  const state = view?.state;
  useEffect(() => {
    const every = state && LIVE_STATES.has(state) ? LIVE_POLL_MS : DONE_POLL_MS;
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, every);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state, load]);
  const resync = useCallback(() => {
    force.current = true;
    load();
  }, [load]);
  // The newest view accepted (a change queued behind another one reads its revision when it is sent).
  const latest = useCallback(() => viewRef.current, []);
  return [view, error, load, accept, resync, latest];
}

/** A focused control that went (or turned disabled) under the person: its replacement by test id, else the title. */
export function useFocusKeeper(title: RefObject<HTMLHeadingElement | null>): void {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onIn = (e: FocusEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.closest('#main, .sh-inspector, .sh-statusbar-wrap') && !t.closest('dialog')) last.current = t;
    };
    document.addEventListener('focusin', onIn);
    return () => document.removeEventListener('focusin', onIn);
  }, []);
  useLayoutEffect(() => {
    const was = last.current;
    if (!was) return;
    const active = document.activeElement;
    const gone = !was.isConnected || (was as HTMLButtonElement).disabled === true;
    const dropped = !active || active === document.body || active === was;
    if (!gone || !dropped) return;
    // Let a dialog that is opening or closing place the focus itself.
    if (document.querySelector('dialog[open]')) return;
    const id = was.dataset.testid;
    // A radio among its group's (one test id each group): the one of the same value.
    const value = was instanceof HTMLInputElement ? was.value : null;
    const twins = id
      ? [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].filter((el) => !(el as HTMLButtonElement).disabled && (value === null || (el as HTMLInputElement).value === value))
      : [];
    const next = twins.length === 1 ? twins[0] : title.current;
    last.current = next;
    next?.focus({ preventScroll: next === title.current });
  });
}
