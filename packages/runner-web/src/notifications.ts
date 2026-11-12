/**
 * Web notifications of the product (R-NTF-03): the in-page kit reports every `new Notification(…)` and
 * `ServiceWorkerRegistration#showNotification(…)` of a page's own document (the permission is granted by the session;
 * session.ts checks the payload); each one becomes an artefact (artefacts/notifications/<name>.json, its icon read
 * within the limits below) and a timeline event (`action: 'notification'`, step -1) in the scene running at that moment.
 * A run keeps at most NOTIFICATION_RUN_MAX notifications and reads at most NOTIFICATION_ICON_RUN_MAX icons.
 */
import type { Page } from 'playwright-core';
import { canonicalOrigin } from '@retake/core/policy';
import { pageOrigins } from '@retake/core/run';
import { errorMessage } from './errors.js';
import type { Runtime } from './runtime.js';
import type { NotificationPayload } from './session.js';
import { sniffMime } from './artefacts/store.js';

/** Notifications a run records; later ones are ignored (one warning). */
export const NOTIFICATION_RUN_MAX = 50;
/** Icons a run reads (data: or fetched); later icons are not read (one warning), their artefacts keep the URL. */
export const NOTIFICATION_ICON_RUN_MAX = 20;
/** The largest icon kept: a data: URL decoded, or a fetched response body (bytes). */
export const NOTIFICATION_ICON_MAX_BYTES = 1024 * 1024;
const ICON_TIMEOUT_MS = 10_000;

/** An icon URL as a message shows it: a data: URL by its size, anything else cut at 120 characters. */
export function shownIcon(url: string): string {
  if (/^data:/i.test(url)) return `a data: URL of ${url.length} characters`;
  return url.length > 120 ? `${url.slice(0, 117)}…` : url;
}

/**
 * Why an icon is not read (null when it may be): only a data: URL, or an http(s) URL of one of `origins` (the
 * notifying page's own origin and the environment's) — another port of localhost is another origin.
 */
export function iconRefusal(url: string, origins: readonly string[]): string | null {
  if (/^data:/i.test(url)) return null;
  const o = canonicalOrigin(url);
  if (o === null) return 'an icon is read only from a data: URL or an http(s) URL';
  if (!origins.includes(o)) return `${o} is neither the notifying page's origin nor one of the environment's (${origins.join(', ') || 'none'})`;
  return null;
}

function decodeDataUrl(url: string): { data: Buffer; mime: string } {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('not a data: URL');
  const meta = url.slice(5, comma).split(';');
  const payload = url.slice(comma + 1);
  const base64 = meta.length > 1 && meta[meta.length - 1].toLowerCase() === 'base64';
  const bytes = base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  if (bytes.length > NOTIFICATION_ICON_MAX_BYTES) throw new Error(`it is ${bytes.length} bytes, more than ${NOTIFICATION_ICON_MAX_BYTES}`);
  const mime = meta[0]?.includes('/') ? meta[0].toLowerCase() : '';
  return { data: bytes, mime: mime || sniffMime(bytes) };
}

/**
 * Read a notification icon the rules allow (iconRefusal first): a data: URL is decoded; an http(s) URL is fetched with
 * the page's session cookies, without following a redirect, its body cut off beyond NOTIFICATION_ICON_MAX_BYTES (the
 * fetch fails). Throws with the reason.
 */
export async function fetchIcon(page: Page, url: string): Promise<{ data: Buffer; mime: string }> {
  if (/^data:/i.test(url)) return decodeDataUrl(url);
  if (canonicalOrigin(url) === null) throw new Error('not an http(s) URL');
  const cookies = await page.context().cookies(url);
  const headers: Record<string, string> = { accept: 'image/*,*/*;q=0.8' };
  if (cookies.length) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(ICON_TIMEOUT_MS) });
  try {
    if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status}: a redirect is not followed`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > NOTIFICATION_ICON_MAX_BYTES) throw new Error(`it is ${declared} bytes, more than ${NOTIFICATION_ICON_MAX_BYTES}`);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    for (;;) {
      const r = reader ? await reader.read() : { done: true as const, value: undefined };
      if (r.done) break;
      total += r.value.byteLength;
      if (total > NOTIFICATION_ICON_MAX_BYTES) {
        await reader?.cancel().catch(() => undefined);
        throw new Error(`it is more than ${NOTIFICATION_ICON_MAX_BYTES} bytes`);
      }
      chunks.push(r.value);
    }
    reader?.releaseLock();
    const bytes = Buffer.concat(chunks);
    return { data: bytes, mime: sniffMime(bytes, new URL(url).pathname, res.headers.get('content-type') ?? '') };
  } finally {
    if (res.body && !res.body.locked) await res.body.cancel().catch(() => undefined);
  }
}

function shownTitle(t: string): string {
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** Record the session's web notifications for this run. `settled()` waits for the ones still being written. */
export function watchNotifications(rt: Runtime): { settled: () => Promise<void> } {
  const pending: Promise<void>[] = [];
  const envOrigins = pageOrigins(rt.env.pages);
  let count = 0;
  let icons = 0;
  rt.session.onNotification = (page: Page, n: NotificationPayload) => {
    if (++count > NOTIFICATION_RUN_MAX) {
      if (count === NOTIFICATION_RUN_MAX + 1) rt.warn(`the pages showed more than ${NOTIFICATION_RUN_MAX} notifications: the later ones are not recorded`);
      return;
    }
    const t = rt.now();
    const cur = rt.current;
    // A js hook tab (the quote scenario's console polling in the background) is named by its page key too.
    const pageId = rt.session.idOf(page) ?? rt.session.hookPageId(page);
    const title = shownTitle(n.title);
    if (n.iconTooLong) rt.warn(`notification "${title}": its icon URL is longer than the limit, it is not kept`);
    let icon: Promise<{ data: Buffer; mime: string } | null> | null = null;
    if (n.icon) {
      const refused = iconRefusal(n.icon, [n.origin, ...envOrigins]);
      if (refused) rt.warn(`notification "${title}": its icon ${shownIcon(n.icon)} is not fetched (${refused}); the artefact keeps its URL`);
      else if (++icons > NOTIFICATION_ICON_RUN_MAX) {
        if (icons === NOTIFICATION_ICON_RUN_MAX + 1) rt.warn(`the notifications gave more than ${NOTIFICATION_ICON_RUN_MAX} icons: the later ones are not read, their artefacts keep the URL`);
      } else {
        icon = fetchIcon(page, n.icon).catch((e: unknown) => {
          rt.warn(`notification "${title}": its icon ${shownIcon(n.icon!)} could not be read (${errorMessage(e)})`);
          return null;
        });
      }
    }
    const job = rt.artefacts
      .addNotification({ title: n.title, body: n.body, tag: n.tag, icon: n.icon, origin: n.origin, via: n.via, time: n.time, page: pageId }, t, cur ? { scene: cur.scene, step: cur.step } : {}, icon)
      .then((a) => {
        rt.log('info', `notification captured: "${title}" (${a.name}) from ${a.origin}`);
        if (!cur) {
          rt.warn(`notification "${title}" showed before the first scene: it is kept as an artefact but not placed on the timeline`);
          return;
        }
        rt.timeline.addEvent({
          scene: cur.scene,
          scene_index: cur.scene_index,
          step: -1,
          action: 'notification',
          t_start: t,
          t_end: t,
          status: 'ok',
          ...(pageId ? { page: pageId } : {}),
          url: n.url,
          data: { name: a.name, index: a.index, title: a.title, body: a.body, ...(a.tag ? { tag: a.tag } : {}), artefact: a.file, via: a.via },
        });
      })
      .catch((e: unknown) => rt.warn(`notification "${title}" could not be recorded: ${errorMessage(e)}`));
    pending.push(job);
  };
  return {
    settled: async () => {
      rt.session.onNotification = null;
      await Promise.all(pending);
    },
  };
}
