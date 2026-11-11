/** Web notifications relayed to the runner. */
import { config } from './config.js';

// ── Web notifications (R-NTF-03): report every `new Notification(…)` and ServiceWorkerRegistration#showNotification
// to the runner (binding `__retakeNotification`, else queued in `__retakeNotifications`, at most 50), then let the
// page's call proceed unchanged. Patched once per window (a re-installed kit keeps the first patch). Only a page's own
// document reports (the runner ignores a frame inside it); each text is sent one character past the runner's limit
// (session.ts NOTIFICATION_TEXT_MAX, NOTIFICATION_ICON_URL_MAX), which cuts or drops what is longer.
export function relayNotifications(): void {
  (() => {
    const TEXT_SENT = 2049;
    const ICON_SENT = 1_500_001;
    type Reported = { via: string; title: string; body: string; tag?: string; icon?: string; time: number; url: string; origin: string };
    const g = window as unknown as Record<string, unknown> & { __retakeNotifications?: Reported[] };
    if (config.passive || g.__retakeNotifyPatched) return;
    let top = true;
    try {
      top = window.top === window;
    } catch {
      top = false;
    }
    if (!top) return;
    g.__retakeNotifyPatched = true;
    const report = (via: string, title: unknown, options: unknown) => {
      try {
        const o = (options && typeof options === 'object' ? options : {}) as { body?: unknown; tag?: unknown; icon?: unknown };
        let icon: string | undefined;
        if (o.icon !== undefined && o.icon !== null && String(o.icon) !== '') {
          try {
            icon = new URL(String(o.icon), location.href).href;
          } catch {
            icon = String(o.icon);
          }
        }
        const payload: Reported = {
          via,
          title: String(title ?? '').slice(0, TEXT_SENT),
          body: o.body === undefined || o.body === null ? '' : String(o.body).slice(0, TEXT_SENT),
          time: Date.now(),
          url: location.href.slice(0, TEXT_SENT),
          origin: location.origin,
        };
        if (o.tag !== undefined && o.tag !== null && String(o.tag) !== '') payload.tag = String(o.tag).slice(0, TEXT_SENT);
        if (icon) payload.icon = icon.slice(0, ICON_SENT);
        const binding = g.__retakeNotification;
        if (typeof binding === 'function') (binding as (p: Reported) => unknown)(payload);
        else if ((g.__retakeNotifications ??= []).length < 50) g.__retakeNotifications.push(payload);
      } catch {
        /* never break the page */
      }
    };
    const Orig = g.Notification as (new (title: string, options?: unknown) => Notification) & { permission?: string; requestPermission?: (...a: unknown[]) => unknown; maxActions?: number } | undefined;
    if (typeof Orig === 'function') {
      const Patched = function (this: unknown, title: string, options?: unknown) {
        if (!new.target) throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator.");
        report('Notification', title, options);
        return Reflect.construct(Orig, [title, options], new.target) as Notification;
      } as unknown as Record<string, unknown>;
      Patched.prototype = Orig.prototype;
      Object.defineProperty(Patched, 'permission', { get: () => Orig.permission, configurable: true });
      if ('maxActions' in Orig) Object.defineProperty(Patched, 'maxActions', { get: () => Orig.maxActions, configurable: true });
      if (typeof Orig.requestPermission === 'function') Patched.requestPermission = (...a: unknown[]) => Orig.requestPermission!.apply(Orig, a);
      Object.defineProperty(Patched, 'name', { value: 'Notification' });
      g.Notification = Patched;
    }
    const SWR = g.ServiceWorkerRegistration as { prototype: { showNotification?: (this: unknown, title: string, options?: unknown) => Promise<void> } } | undefined;
    const show = SWR?.prototype.showNotification;
    if (SWR && typeof show === 'function') {
      SWR.prototype.showNotification = function (this: unknown, title: string, options?: unknown) {
        report('ServiceWorkerRegistration.showNotification', title, options);
        return show.call(this, title, options);
      };
    }
  })();
}
