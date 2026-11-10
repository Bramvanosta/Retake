import {
  Background,
  CapText,
  NotificationCard,
  PhoneDevice,
  biasMotion,
  backgroundSample,
  capTextLayout,
  clamp,
  cssFontFamily,
  darkLight,
  layoutNotification,
  mixColors,
  phoneCardGeometry,
  progress,
  readableOn,
  roundTo,
  useCurrentFrame,
  wallpaperCss,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, NotificationContent, NotificationLayout } from '@retake/components/kit';

type Item = { app: string; title?: string; body?: string; time?: string; icon?: string };
type Params = {
  time: string;
  date: string;
  notifications: Item[];
  start: number;
  interval: number;
  layout: 'center' | 'left';
  height: number;
  finish: 'dark' | 'light';
  wallpaper: 'accent' | 'night' | 'paper';
};

const PEEK = 9;
const GAP = 10;

/** Groups (by app) of the first `k` arrivals, newest group first; each lists its items oldest → newest. */
export function groupsAfter(items: readonly Item[], k: number): Array<{ app: string; items: number[] }> {
  const groups: Array<{ app: string; items: number[]; last: number }> = [];
  for (let i = 0; i < k; i++) {
    const g = groups.find((x) => x.app === items[i].app);
    if (g) {
      g.items.push(i);
      g.last = i;
    } else groups.push({ app: items[i].app, items: [i], last: i });
  }
  return groups.sort((a, b) => b.last - a.last).map(({ app, items: its }) => ({ app, items: its }));
}

/**
 * The lock screen: wallpaper, date, big time, then the notifications arriving one by one (drop in over 0.5 s, the
 * stack below sliding down), newest group first, older notifications of a group peeking under its newest card.
 */
export default function PhoneLockscreen({ theme, slots, params, unit, width, height, fps, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const t = frame / fps;
  const items: Item[] = [...(params.notifications ?? [])];
  const e = media?.email?.kind === 'email' ? media.email : undefined;
  if (e) items.push({ app: 'Mail', title: e.from_name ?? e.from, body: e.subject });
  const n = media?.notification?.kind === 'notification' ? media.notification : undefined;
  if (n) items.push({ app: n.app, title: n.title, body: n.body, icon: n.icon?.url });

  const hasText = !!(slots.title || slots.kicker) && (params.layout === 'left' || variant === 'vertical');
  const g = phoneCardGeometry({ width, height, unit: u, displayHeight: params.height, layout: params.layout, withText: hasText });
  const d = g.display;
  const { dark, light } = darkLight(theme);
  const wallMid = params.wallpaper === 'paper' ? mixColors(light, theme.colors.accent, 0.2) : mixColors(theme.colors.accent, dark, 0.3);
  const ink = readableOn(wallMid, light, dark, 3);
  const font = cssFontFamily(theme.fonts.body);

  // Cards (display coordinates).
  const cardX = d.w * 0.04;
  const cardW = d.w * 0.92;
  const stackTop = Math.round(d.h * 0.4);
  const layouts: NotificationLayout[] = items.map((it) =>
    layoutNotification('ios-banner', { app: it.app, title: it.title ?? it.app, body: it.body, time: it.time ?? 'now', icon: it.icon, glyph: it.app === 'Mail' ? 'mail' : undefined }, theme, u, cardW),
  );
  const content = (i: number): NotificationContent => ({
    app: items[i].app,
    title: items[i].title ?? items[i].app,
    body: items[i].body,
    time: items[i].time ?? 'now',
    icon: items[i].icon,
    glyph: items[i].app === 'Mail' && !items[i].icon ? 'mail' : undefined,
  });
  const arrive = (i: number) => params.start + i * params.interval;
  let k = 0;
  while (k < items.length && t >= arrive(k)) k++;
  const p = k > 0 ? progress(frame, fps, { delay: arrive(k - 1), duration: 0.5 * bias.pace, ease: 'entrance' }) : 1;
  const heightOf = (grp: { items: number[] }) => layouts[grp.items[grp.items.length - 1]].h + Math.min(grp.items.length - 1, 2) * PEEK * u;
  const positions = (kk: number) => {
    const out = new Map<string, number>();
    let y = stackTop;
    for (const grp of groupsAfter(items, kk)) {
      out.set(grp.app, y);
      y += heightOf(grp) + GAP * u;
    }
    return out;
  };
  const before = positions(Math.max(0, k - 1));
  const after = positions(k);
  const groups = groupsAfter(items, k);
  const newest = k - 1;

  const enter = progress(frame, fps, { duration: 0.55 * bias.pace, ease: 'entrance' });
  const rise = roundTo((1 - enter) * 30 * bias.travel * u, 2);
  const clock = capTextLayout({ text: params.time, width: d.w * 0.9, maxFontSize: d.w * 0.25, minFontSize: d.w * 0.15, maxLines: 1, lineHeight: 1, fontFamily: theme.fonts.display, fontWeight: 600 });
  const textBg = backgroundSample(theme);
  const kicker = hasText && slots.kicker && g.text
    ? capTextLayout({ text: slots.kicker, width: g.text.w, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = hasText && slots.title && g.text
    ? capTextLayout({ text: slots.title, width: g.text.w, maxFontSize: (variant === 'vertical' ? 64 : 56) * u, minFontSize: 32 * u, maxLines: 3, lineHeight: 1.08, fontFamily: theme.fonts.display, letterSpacing: -0.01 })
    : null;
  const textIn = progress(frame, fps, { delay: 0.3, duration: 0.5 * bias.pace, ease: 'entrance' });
  const center = variant === 'vertical';
  const stackH = (kicker ? kicker.capHeight + 28 * u : 0) + (title ? title.band : 0);
  const textTop = g.text ? (center ? g.text.y + 20 * u : g.text.y + g.text.h / 2 - stackH / 2) : 0;
  const textX = g.text ? (center ? g.text.x + g.text.w / 2 : g.text.x) : 0;

  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, transform: `translateY(${rise}px)`, opacity: roundTo(Math.min(1, enter * 1.4), 4) }}>
        <PhoneDevice theme={theme} geometry={g} finish={params.finish} unit={u} status={{ ink }}>
          <div style={{ position: 'absolute', inset: 0, background: wallpaperCss(theme, params.wallpaper) }} />
          <div style={{ position: 'absolute', left: 0, width: d.w, top: d.h * 0.105, textAlign: 'center', fontFamily: font, fontWeight: 600, fontSize: d.w * 0.047, color: withAlpha(ink, 0.92) }}>{params.date}</div>
          <CapText layout={clock} x={d.w / 2} capTop={d.h * 0.155} align="center" color={withAlpha(ink, 0.95)} />
          {groups.map((grp) => {
            const target = after.get(grp.app) ?? stackTop;
            const from = before.get(grp.app);
            const isNewGroup = from === undefined;
            const y = isNewGroup ? target : from + (target - from) * p;
            const top = grp.items[grp.items.length - 1];
            const l = layouts[top];
            const peeks = grp.items.slice(Math.max(0, grp.items.length - 3), -1).reverse();
            const arriving = top === newest;
            const op = arriving ? clamp(p * 1.4) : 1;
            const dy = arriving ? -(1 - p) * 36 * u : 0;
            return (
              <div key={grp.app} style={{ position: 'absolute', left: cardX, top: roundTo(y, 2), width: cardW }}>
                {peeks.map((idx, j) => (
                  <div
                    key={idx}
                    style={{
                      position: 'absolute',
                      left: (j + 1) * 9 * u,
                      right: (j + 1) * 9 * u,
                      top: l.h + (j + 1) * PEEK * u - 22 * u,
                      height: 22 * u,
                      borderRadius: `0 0 ${16 * u}px ${16 * u}px`,
                      background: withAlpha(light, 0.5 - j * 0.15),
                    }}
                  />
                ))}
                <div style={{ position: 'absolute', left: 0, top: 0, opacity: roundTo(op, 4), transform: `translateY(${roundTo(dy, 2)}px)` }}>
                  <NotificationCard theme={theme} layout={l} content={content(top)} appearance="light" style={{ background: withAlpha(light, 0.82), boxShadow: `0 ${6 * u}px ${18 * u}px ${withAlpha(dark, 0.18)}` }} />
                </div>
              </div>
            );
          })}
          {/* Flashlight, camera, home indicator. */}
          {[0, 1].map((i) => {
            const s = d.w * 0.12;
            return (
              <div key={i} style={{ position: 'absolute', left: i === 0 ? d.w * 0.12 : d.w * 0.88 - s, top: d.h * 0.885, width: s, height: s, borderRadius: s / 2, background: withAlpha(dark, 0.32), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width={s * 0.42} height={s * 0.42} viewBox="0 0 20 20">
                  {i === 0 ? <path d="M7 2h6v4l-2 3v9H9V9L7 6z" fill="none" stroke={withAlpha(light, 0.9)} strokeWidth="1.5" strokeLinejoin="round" /> : <path d="M3 6h3l2-2h4l2 2h3v10H3z M10 8.5a3 3 0 1 0 0.01 0z" fill="none" stroke={withAlpha(light, 0.9)} strokeWidth="1.5" strokeLinejoin="round" />}
                </svg>
              </div>
            );
          })}
          <div style={{ position: 'absolute', left: d.w * 0.33, width: d.w * 0.34, top: d.h - 14 * u, height: 5 * u, borderRadius: 3 * u, background: withAlpha(ink, 0.85) }} />
        </PhoneDevice>
      </div>
      {g.text ? (
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(textIn, 4), transform: `translateY(${roundTo((1 - textIn) * 10 * bias.travel * u, 2)}px)` }}>
          {kicker ? <CapText layout={kicker} x={textX} capTop={textTop} align={center ? 'center' : 'left'} color={readableOn(textBg, theme.colors.accent, theme.colors.text, 2.6)} /> : null}
          {title ? <CapText layout={title} x={textX} capTop={textTop + (kicker ? kicker.capHeight + 28 * u : 0)} align={center ? 'center' : 'left'} color={readableOn(textBg, theme.colors.text, dark, 4.5)} /> : null}
        </div>
      ) : null}
    </Background>
  );
}
