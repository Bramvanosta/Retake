import { useCurrentFrame } from 'remotion';
import { NOTIFICATION_INSET, NotificationCard, biasMotion, layoutNotification, notificationArea, notificationBox, notificationMotion } from '@demo-studio/components/kit';
import type { ComponentProps, NotificationAppearance, NotificationContent, NotificationPlace, NotificationStyle } from '@demo-studio/components/kit';

type Params = { style: NotificationStyle; place: NotificationPlace; appearance: NotificationAppearance };

/**
 * A system notification: the scenario's values over the captured web notification's (`media.notification`), drawn by
 * the kit's NotificationCard in the chosen style, placed by `notificationBox` (frame corner or over the capture) and
 * animated by `notificationMotion` (slide / rise / drop in, out the same way over the last 0.35 s).
 */
export default function Notification({ theme, slots, params, unit, width, height, fps, durationInFrames, rects, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const n = media?.notification?.kind === 'notification' ? media.notification : undefined;
  const content: NotificationContent = {
    app: slots.app ?? n?.app ?? theme.brand.name,
    title: slots.title ?? n?.title,
    body: slots.body ?? n?.body,
    time: slots.time ?? 'now',
    icon: slots.icon ?? n?.icon?.url,
  };
  const area = notificationArea(params.style, params.place, width, height, rects);
  const layout = layoutNotification(params.style, content, theme, unit, area.w - 2 * NOTIFICATION_INSET[params.style] * unit);
  const box = notificationBox(layout, params.place, width, height, rects);
  const m = notificationMotion(params.style, frame, fps, durationInFrames, unit, biasMotion(theme.style_bias).pace);
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, opacity: m.opacity, transform: m.transform, pointerEvents: 'none' }}>
      <NotificationCard theme={theme} layout={layout} content={content} appearance={params.appearance} />
    </div>
  );
}
