import { useCurrentFrame } from 'remotion';
import { NOTIFICATION_INSET, NotificationCard, biasMotion, layoutNotification, notificationArea, notificationBox, notificationMotion } from '@demo-studio/components/kit';
import type { ComponentProps, NotificationAppearance, NotificationContent, NotificationPlace, NotificationStyle } from '@demo-studio/components/kit';

type Params = { style: NotificationStyle; place: NotificationPlace; appearance: NotificationAppearance };

/** studio/notification's card fed by an email: sender → title, subject → bold second line, first line → body. */
export default function MailNotification({ theme, slots, params, unit, width, height, fps, durationInFrames, rects, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const e = media?.email?.kind === 'email' ? media.email : undefined;
  const content: NotificationContent = {
    app: slots.app ?? 'Mail',
    title: slots.from ?? e?.from_name ?? e?.from,
    subtitle: slots.subject ?? e?.subject,
    body: slots.preview ?? e?.preview,
    time: slots.time ?? 'now',
    icon: slots.icon,
    glyph: 'mail',
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
