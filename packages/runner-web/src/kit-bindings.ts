/** The bindings the in-page kit calls (web notifications, cursor effects) and the notification payload it reports, checked. */
import type { BrowserContext, Page } from 'playwright-core';
import type { CursorEffectPayload } from './kit/types.js';

/** A web notification reported by the in-page kit (Notification API or ServiceWorkerRegistration.showNotification). */
export interface NotificationPayload {
  via: 'Notification' | 'ServiceWorkerRegistration.showNotification';
  title: string;
  body: string;
  tag?: string;
  /** Absolute icon URL (resolved against the page), when given. */
  icon?: string;
  /** The icon the page gave is not kept: its URL is longer than the limit (NOTIFICATION_ICON_URL_MAX). */
  iconTooLong?: true;
  /** Page wall clock (epoch ms). */
  time: number;
  /** The notifying page's URL and origin, as the browser reports its main frame (not as the page says). */
  url: string;
  origin: string;
}

/** The longest title, body or tag a notification keeps (characters; a longer one is cut, with `…`). */
export const NOTIFICATION_TEXT_MAX = 2048;
/** The longest icon URL a notification keeps: a data: URL (about 1 MiB of base64), any other URL. */
export const NOTIFICATION_ICON_URL_MAX = { data: 1_500_000, other: 2048 } as const;
const NOTIFICATION_VIA = new Set(['Notification', 'ServiceWorkerRegistration.showNotification']);

function capText(v: string, max = NOTIFICATION_TEXT_MAX): string {
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/**
 * What the kit reported, checked: an object whose `via` is one of the two APIs, `title` and `body` strings, `tag` and
 * `icon` strings when given, `time` a valid epoch; anything else is null (ignored). Texts are cut at
 * NOTIFICATION_TEXT_MAX; an icon URL beyond NOTIFICATION_ICON_URL_MAX is dropped (`iconTooLong`). The URL and origin
 * are the main frame's (`frameUrl`), never the payload's.
 */
export function readNotificationPayload(raw: unknown, frameUrl: string): NotificationPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.via !== 'string' || !NOTIFICATION_VIA.has(p.via)) return null;
  if (typeof p.title !== 'string' || typeof p.body !== 'string') return null;
  if (p.tag !== undefined && typeof p.tag !== 'string') return null;
  if (p.icon !== undefined && typeof p.icon !== 'string') return null;
  if (typeof p.time !== 'number' || !Number.isFinite(p.time) || Math.abs(p.time) > 8.64e15) return null;
  let origin = 'null';
  try {
    origin = new URL(frameUrl).origin;
  } catch {
    /* not a URL: an opaque origin */
  }
  const n: NotificationPayload = {
    via: p.via as NotificationPayload['via'],
    title: capText(p.title),
    body: capText(p.body),
    time: p.time,
    url: capText(frameUrl),
    origin,
  };
  if (p.tag) n.tag = capText(p.tag);
  if (p.icon) {
    const max = /^data:/i.test(p.icon) ? NOTIFICATION_ICON_URL_MAX.data : NOTIFICATION_ICON_URL_MAX.other;
    if (p.icon.length > max) n.iconTooLong = true;
    else n.icon = p.icon;
  }
  return n;
}

/** Name of the binding the kit calls for each web notification the page shows. */
export const NOTIFICATION_BINDING = '__retakeNotification';
/** Name of the binding the kit calls with what its cursor shows: icon changes, presses, click ripples. */
export const CURSOR_BINDING = '__retakeCursor';

/** What the bindings hand their reports to: read at call time (the runner sets them after the launch). */
export interface KitBindingHost {
  onNotification: ((page: Page, n: NotificationPayload) => void) | null;
  onCursorEffect: ((page: Page, e: CursorEffectPayload) => void) | null;
}

/** The kit's two bindings in a context: each web notification and each cursor effect of a page goes to `session`. */
export async function exposeKitBindings(context: BrowserContext, session: KitBindingHost): Promise<void> {
  // Both bindings answer the page's own document only: a call from a frame inside it (an embed, an ad) is ignored.
  await context.exposeBinding(NOTIFICATION_BINDING, (src, payload: unknown) => {
    try {
      if (!session.onNotification || !src.page || src.frame !== src.page.mainFrame()) return;
      const n = readNotificationPayload(payload, src.frame.url());
      if (n) session.onNotification(src.page, n);
    } catch {
      /* a listener error must not reach the page */
    }
  });
  await context.exposeBinding(CURSOR_BINDING, (src, payload: CursorEffectPayload) => {
    try {
      if (session.onCursorEffect && src.page && src.frame === src.page.mainFrame()) session.onCursorEffect(src.page, payload);
    } catch {
      /* a listener error must not reach the page */
    }
  });
}
