/**
 * The tab's unsaved-text report (L5.2b, DESIGN §4j): what this tab holds unsaved (drafts.ts `unsavedItems()` — kinds and
 * names, never the text) goes to its own server through the op `unsaved_report`, where the desktop app's quit question
 * reads it. Never the shell: the page talks to its server only.
 *
 * - One tab session per page load: 22 random base64url characters, in memory only (a reload is a new session; the
 *   old one cleared by its `pagehide`).
 * - Sent when the set (or, while it is not empty, the tab's visibility) changes — one call in flight, the latest state
 *   sent after it; nothing is sent while nothing was ever unsaved. A failed call is tried again after RETRY_MS.
 * - `pagehide`: an empty report with `keepalive` (it outlives the page), so a report never outlives its tab session
 *   (critique L8: no heartbeat, nothing on the server expires it by time — a hidden window's timers are throttled);
 *   nothing more is sent until `pageshow` (the unload's own `visibilitychange` comes after `pagehide`: a report sent
 *   then could reach the server after the empty one).
 * - The session ended (401): it stops.
 * - A name that fails the server's rule (a slug of at most 100 characters) is left out before sending, the item kept
 *   (review A L4: one bad name never makes the whole report a 400 — the server drops such a name too).
 */
import { CallError } from './api.js';
import { unsavedReport } from './data/desktop.js';
import { onUnsavedChange, unsavedItems } from './drafts.js';
import type { UnsavedItem } from './drafts.js';
import { SessionEnded } from './session.js';

export const RETRY_MS = 5000;
/** Items one report names at most (the op's cap). */
export const REPORT_ITEMS_MAX = 16;

/** The names a report may carry (the server's PROJECT_SLUG_RE / SLUG_RE, capped like its other ops). */
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SCENARIO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** `item` with only the names the server takes as names (the item itself always stays). */
export function reportable(item: UnsavedItem): UnsavedItem {
  const project = item.project !== undefined && PROJECT_NAME_RE.test(item.project) ? item.project : undefined;
  const scenario = project !== undefined && item.scenario !== undefined && SCENARIO_NAME_RE.test(item.scenario) ? item.scenario : undefined;
  return { kind: item.kind, ...(project !== undefined ? { project } : {}), ...(scenario !== undefined ? { scenario } : {}) };
}

export interface ReportArgs {
  tab: string;
  hidden: boolean;
  items: UnsavedItem[];
}

export interface ReportDeps {
  send(args: ReportArgs, keepalive: boolean): Promise<unknown>;
  items(): UnsavedItem[];
  subscribe(f: () => void): () => void;
  hidden(): boolean;
  /** `visibilitychange` (document), `pagehide` / `pageshow` (window); returns the unsubscribe. */
  listen(event: 'visibilitychange' | 'pagehide' | 'pageshow', f: () => void): () => void;
  timer(f: () => void, ms: number): () => void;
  tabId(): string;
}

/** 16 random bytes as 22 base64url characters. */
export function newTabId(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function browserDeps(): ReportDeps {
  return {
    send: (args, keepalive) => unsavedReport({ ...args }, { keepalive }),
    items: unsavedItems,
    subscribe: onUnsavedChange,
    hidden: () => document.visibilityState === 'hidden',
    listen: (event, f) => {
      const target: EventTarget = event === 'visibilitychange' ? document : window;
      target.addEventListener(event, f);
      return () => target.removeEventListener(event, f);
    },
    timer: (f, ms) => {
      const t = setTimeout(f, ms);
      return () => clearTimeout(t);
    },
    tabId: () => newTabId(),
  };
}

const NOTHING = '[]';

/** Start reporting; returns the stop. */
export function startUnsavedReport(deps: ReportDeps = browserDeps()): () => void {
  const tab = deps.tabId();
  /** The state the server holds for this tab (NOTHING: no report, or an empty one); null: unknown (a call failed). */
  let last: string | null = NOTHING;
  let inFlight = false;
  let again = false;
  let stopped = false;
  /** Bumped by pagehide: an answer to a call sent before it does not say what the server holds. */
  let gen = 0;
  /** Between pagehide and pageshow: nothing is sent (the unload's visibilitychange comes after pagehide). */
  let hiddenPage = false;
  let cancelRetry: (() => void) | undefined;
  const offs: Array<() => void> = [];

  const stop = () => {
    stopped = true;
    cancelRetry?.();
    for (const off of offs.splice(0)) off();
  };

  const sync = () => {
    if (stopped || hiddenPage) return;
    const items = deps.items().slice(0, REPORT_ITEMS_MAX).map(reportable);
    const hidden = deps.hidden();
    const key = items.length ? JSON.stringify([hidden, items]) : NOTHING;
    if (key === last) return;
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    cancelRetry?.();
    cancelRetry = undefined;
    const g = gen;
    deps
      .send({ tab, hidden, items }, false)
      .then(
        () => {
          if (g === gen) last = key;
        },
        (e: unknown) => {
          if (e instanceof SessionEnded || (e instanceof CallError && e.status === 401)) {
            stop();
            return;
          }
          last = null;
          cancelRetry = deps.timer(() => {
            cancelRetry = undefined;
            sync();
          }, RETRY_MS);
        },
      )
      .finally(() => {
        inFlight = false;
        if (again) {
          again = false;
          sync();
        }
      });
  };

  offs.push(deps.subscribe(sync));
  offs.push(deps.listen('visibilitychange', sync));
  offs.push(
    deps.listen('pagehide', () => {
      if (stopped) return;
      hiddenPage = true;
      if (last === NOTHING && !inFlight) return;
      gen++;
      last = NOTHING;
      deps.send({ tab, hidden: true, items: [] }, true).catch(() => undefined);
    }),
  );
  // Back from the back-forward cache: the report again.
  offs.push(
    deps.listen('pageshow', () => {
      hiddenPage = false;
      sync();
    }),
  );
  sync();
  return stop;
}
