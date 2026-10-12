/**
 * Web notifications of the product (R-NTF-03): the in-page kit reports every `new Notification(…)` and
 * `ServiceWorkerRegistration#showNotification(…)` (the permission is granted by the session); each one becomes an
 * artefact (artefacts/notifications/<name>.json, its icon fetched with the session) and a timeline event
 * (`action: 'notification'`, step -1) in the scene running at that moment.
 */
import type { Page } from 'playwright-core';
import { errorMessage } from './errors.js';
import type { Runtime } from './runtime.js';
import type { NotificationPayload } from './session.js';
import { sniffMime } from './artefacts/store.js';

/** Fetch a notification icon with the page's session (cookies); data: URLs are decoded. */
export async function fetchIcon(page: Page, url: string): Promise<{ data: Buffer; mime: string } | null> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (data) {
    const bytes = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]));
    return { data: bytes, mime: data[1] || sniffMime(bytes) };
  }
  if (!/^https?:/i.test(url)) return null;
  const res = await page.context().request.get(url, { timeout: 10_000 });
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  const bytes = await res.body();
  return { data: bytes, mime: sniffMime(bytes, new URL(url).pathname, res.headers()['content-type'] ?? '') };
}

/** Record the session's web notifications for this run. `settled()` waits for the ones still being written. */
export function watchNotifications(rt: Runtime): { settled: () => Promise<void> } {
  const pending: Promise<void>[] = [];
  rt.session.onNotification = (page: Page, n: NotificationPayload) => {
    const t = rt.now();
    const cur = rt.current;
    const pageId = rt.session.idOf(page);
    const icon = n.icon
      ? fetchIcon(page, n.icon).catch((e: unknown) => {
          rt.warn(`notification "${n.title}": its icon ${n.icon} could not be fetched (${errorMessage(e)})`);
          return null;
        })
      : null;
    const job = rt.artefacts
      .addNotification(
        { title: n.title, body: n.body, tag: n.tag, icon: n.icon, origin: n.origin, via: n.via, time: n.time, page: pageId },
        t,
        cur ? { scene: cur.scene, step: cur.step } : {},
        icon,
      )
      .then((a) => {
        rt.log('info', `notification captured: "${a.title}" (${a.name}) from ${a.origin}`);
        if (!cur) {
          rt.warn(`notification "${a.title}" showed before the first scene: it is kept as an artefact but not placed on the timeline`);
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
      .catch((e: unknown) => rt.warn(`notification "${n.title}" could not be recorded: ${errorMessage(e)}`));
    pending.push(job);
  };
  return {
    settled: async () => {
      rt.session.onNotification = null;
      await Promise.all(pending);
    },
  };
}
