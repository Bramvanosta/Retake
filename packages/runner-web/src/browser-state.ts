/** A browser context's storage state applied, and its file: guard (BrowserSession). */
import { readFile } from 'node:fs/promises';
import type { BrowserContext, CDPSession } from 'playwright-core';
import { bestEffort, errorMessage } from '@retake/core/base';
import { RunnerError } from './errors.js';
import { restoreIndexedDb } from './idb-state.js';

/** Playwright storage state: cookies, and per origin its localStorage and (when saved with it) its IndexedDB. */
export interface StorageStateFile {
  cookies?: Parameters<BrowserContext['addCookies']>[0];
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }>; indexedDB?: unknown[] }>;
}

/**
 * The browser's own last resort against local files, in every realm of a run (capture, dry run, inspection): a
 * browser-level CDP session pauses every `file:` request of every page, popup and frame — those that exist and those to
 * come — and fails it (`net::ERR_BLOCKED_BY_CLIENT`), whatever started it. Other requests are never paused, so the HTTP
 * cache and the write guard's route are untouched. Throws when the browser cannot be guarded (no browser-level session,
 * Fetch refused): the realm is not used.
 */
export async function armFileGuard(context: BrowserContext, persona = ''): Promise<CDPSession> {
  const fail = (why: string, cause?: unknown) =>
    new RunnerError(`could not set the browser${persona ? ` of persona ${persona}` : ''} to refuse file: pages: ${why}`, cause === undefined ? undefined : { cause });
  const browser = context.browser();
  if (!browser) throw fail('no browser-level session');
  let cdp: CDPSession;
  try {
    cdp = await browser.newBrowserCDPSession();
  } catch (e) {
    throw fail(errorText(e), e);
  }
  cdp.on('Fetch.requestPaused', (e: { requestId: string; request: { url: string } }) => {
    // Only file: requests are paused (the pattern); anything else goes on untouched.
    const call = /^file:/i.test(e.request.url)
      ? cdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' })
      : cdp.send('Fetch.continueRequest', { requestId: e.requestId });
    bestEffort(call, 'a request of a page that is gone goes with it');
  });
  try {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'file:*' }] });
  } catch (e) {
    await cdp.detach().catch(() => undefined);
    throw fail(errorText(e), e);
  }
  return cdp;
}

function errorText(e: unknown): string {
  return errorMessage(e).split('\n')[0];
}

/**
 * Apply a storage state to a context: its cookies, its localStorage by an init script (keys the app set are kept) and
 * its IndexedDB databases (idb-state.ts: written now, before any page of the product loads).
 */
export async function applyStorageState(context: BrowserContext, from: StorageStateFile | string): Promise<void> {
  let state: StorageStateFile;
  if (typeof from === 'string') {
    try {
      state = JSON.parse(await readFile(from, 'utf8')) as StorageStateFile;
    } catch (e) {
      throw new RunnerError(`cannot read storage_state ${from}: ${errorMessage(e)}`);
    }
  } else state = from;
  if (state.cookies?.length) await context.addCookies(state.cookies);
  const origins = (state.origins ?? []).filter((o) => o.localStorage?.length).map((o) => ({ origin: o.origin, localStorage: o.localStorage }));
  if (origins.length) {
    // Applied before page scripts; keys already present (set by the app since) are kept.
    await context.addInitScript({
      content: `(() => { const o = ${JSON.stringify(origins)}.find((x) => x.origin === location.origin);
        if (!o) return; try { for (const kv of o.localStorage) if (localStorage.getItem(kv.name) === null) localStorage.setItem(kv.name, kv.value); } catch {} })();`,
    });
  }
  try {
    await restoreIndexedDb(context, state.origins ?? []);
  } catch (e) {
    throw new RunnerError(`the saved session's IndexedDB could not be restored: ${errorMessage(e).split('\n')[0]}`, { cause: e });
  }
}
