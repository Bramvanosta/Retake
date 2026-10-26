/**
 * Dead clicks (L5.6, R-FLD-12): a click that changes nothing — no request, no DOM change, no navigation, no dialog, no
 * new tab or download, no field taking the focus — within about a second is reported at once (a warning with a
 * screenshot), never 60 s later by the wait that follows; `retry_click: true` on the step clicks once more first.
 */
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { Dialog, Download, Frame, Page, Request } from 'playwright-core';
import { errorMessage, isCancelled } from '../errors.js';
import type { StepContext } from '../runtime.js';
import { fileSlug, wallNow } from '../util.js';

/** How long after the press a click has to show an effect. */
export const DEAD_CLICK_MS = 1000;
const POLL_MS = 80;
/** A request to a URL the page already asked for in the last POLLING_MS before the click is its polling, not an effect. */
const POLLING_MS = 5000;

/** "GET https://host/path" (no query): what a page's polling asks for again and again. */
function requestKey(r: Request): string {
  return `${r.method()} ${r.url().replace(/[?#].*$/, '')}`;
}

/** What a click caused, watched from just before its press. */
export interface EffectWatch {
  /** Wall-clock ms of the press (set by the click). */
  wall: number;
  /** The first effect seen so far ('request', 'navigation', 'dom', 'change'…), else null. */
  seen(): Promise<string | null>;
  stop(): void;
}

/** Start watching the active page for an effect (call right before the press). */
export async function watchEffects(ctx: StepContext): Promise<EffectWatch> {
  const page = ctx.rt.page;
  const kit = ctx.rt.kit;
  let node: string | null = null;
  // The page's own polling (a list refreshed every second) must not make a dead click look alive.
  const polling = new Set<string>();
  const since = Date.now() - POLLING_MS;
  for (const r of await page.requests().catch(() => [] as Request[])) {
    try {
      if (r.timing().startTime >= since) polling.add(requestKey(r));
    } catch {
      /* collected */
    }
  }
  const onRequest = (r: Request) => {
    // A request the page makes (fetch, XHR, a form, a navigation, an image); never a data: / blob: read.
    if (/^https?:|^wss?:/.test(r.url()) && !polling.has(requestKey(r))) node ??= 'request';
  };
  const onNav = (f: Frame) => {
    if (f === page.mainFrame()) node ??= 'navigation';
  };
  const onDialog = (_d: Dialog) => (node ??= 'dialog');
  const onDownload = (_d: Download) => (node ??= 'download');
  const onPage = (_p: Page) => (node ??= 'new tab');
  page.on('request', onRequest);
  page.on('framenavigated', onNav);
  page.on('dialog', onDialog);
  page.on('download', onDownload);
  page.context().on('page', onPage);
  let kitOk = true;
  await kit.effectWatch().catch((e: unknown) => {
    kitOk = false;
    ctx.rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: the click's effects cannot be watched (${errorMessage(e)})`);
  });
  let stopped = false;
  return {
    wall: wallNow(),
    async seen(): Promise<string | null> {
      if (node) return node;
      // A kit that cannot watch (a document replaced, a page that refused the call): never called dead.
      if (!kitOk) return 'unknown';
      const s = await kit.effectSeen().catch((e: unknown) => {
        ctx.rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: the click's effects cannot be read (${errorMessage(e)})`);
        return null;
      });
      // The kit cannot answer, or its document is a new one (it stopped watching): never called dead.
      if (!s) return 'unknown';
      if (!s.watching) return 'new document';
      if (s.events.length) return s.events[0];
      return s.dom > 0 ? `DOM change (${s.first})` : null;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      page.off('request', onRequest);
      page.off('framenavigated', onNav);
      page.off('dialog', onDialog);
      page.off('download', onDownload);
      page.context().off('page', onPage);
      void kit.effectStop().catch(() => undefined);
    },
  };
}

/** Poll until an effect shows or DEAD_CLICK_MS after the press has passed: the effect, else null. */
export async function awaitEffect(ctx: StepContext, fx: EffectWatch): Promise<string | null> {
  for (;;) {
    const s = await fx.seen();
    if (s) return s;
    const left = fx.wall + DEAD_CLICK_MS - wallNow();
    if (left <= 0) return null;
    await ctx.rt.sleep(Math.min(POLL_MS, left));
  }
}

/** The warning of a dead click (and its screenshot, `screenshots/dead-click-<scene>-<step>.png`). */
async function reportDead(ctx: StepContext, desc: string, page: Page): Promise<void> {
  const { rt } = ctx;
  const where = `${ctx.scene.id}.${ctx.step.index}`;
  let shot = '';
  if (!rt.inspecting) {
    const file = join(rt.screenshotsDir, `dead-click-${fileSlug(ctx.scene.id)}-${ctx.step.index}.png`);
    try {
      await page.screenshot({ path: file, timeout: 10_000 });
      // Never a picture of a sign-in page (L1.6).
      if (rt.loginGuardError()) await rm(file, { force: true });
      else shot = `; screenshot: ${file}`;
    } catch (e) {
      if (isCancelled(e)) throw e;
      rt.log('debug', `dead-click screenshot failed: ${errorMessage(e)}`);
    }
  }
  rt.warn(
    `${where}: clicking ${desc} produced nothing within ${DEAD_CLICK_MS / 1000} s (no request, DOM change, navigation, dialog or new tab) — ` +
      `is the control disabled, or the wrong element?${shot} (retry_click: true clicks once more before failing)`,
  );
}

/**
 * A click without retry_click: watched in the background until DEAD_CLICK_MS after the press (the next steps go on,
 * a wait among them); a dead click warns as soon as the second has passed. The next acting step waits for the check to
 * end first, so its own effects never count for this click.
 */
export function checkInBackground(ctx: StepContext, fx: EffectWatch, desc: string): void {
  const { rt } = ctx;
  const page = rt.page;
  const check: { close: () => Promise<void> } = { close: () => Promise.resolve() };
  const done = (async () => {
    try {
      const seen = await awaitEffect(ctx, fx);
      if (seen === null) await reportDead(ctx, desc, page);
      else rt.log('debug', `${ctx.scene.id}.${ctx.step.index}: the click's first effect: ${seen}`);
    } catch (e) {
      if (!isCancelled(e)) rt.log('debug', `dead-click check: ${errorMessage(e)}`);
    } finally {
      fx.stop();
      rt.effectChecks.delete(check);
    }
  })();
  check.close = () => done;
  rt.effectChecks.add(check);
}

/** Wait for the background checks of earlier clicks to end (before an acting step; at the end of the scenes). */
export async function settleEffectChecks(ctx: { rt: StepContext['rt'] }): Promise<void> {
  for (const c of [...ctx.rt.effectChecks]) await c.close();
}
