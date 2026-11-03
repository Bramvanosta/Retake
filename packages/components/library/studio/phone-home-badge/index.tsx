import { Img, useCurrentFrame } from 'remotion';
import {
  AppIcon,
  Background,
  CapText,
  PhoneDevice,
  SYSTEM_COLORS,
  backgroundSample,
  biasMotion,
  capTextLayout,
  clamp,
  cssFontFamily,
  darkLight,
  mixColors,
  nightTone,
  phoneCardGeometry,
  progress,
  readableOn,
  roundTo,
  wallpaperCss,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, ThemeTokens } from '@retake/components/kit';

type Params = {
  from: number;
  to: number;
  start: number;
  interval: number;
  row: number;
  col: number;
  badge: 'system' | 'accent';
  time: string;
  layout: 'center' | 'left';
  height: number;
  finish: 'dark' | 'light';
  wallpaper: 'accent' | 'night' | 'paper';
};

/** The badge count at `t` seconds: `from`, then one more every `interval` from `start`, up to `to`. */
export function badgeCount(t: number, p: Pick<Params, 'from' | 'to' | 'start' | 'interval'>): { count: number; since: number } {
  const steps = Math.max(0, p.to - p.from);
  let k = 0;
  while (k < steps && t >= p.start + k * p.interval) k++;
  return { count: p.from + k, since: k > 0 ? t - (p.start + (k - 1) * p.interval) : Infinity };
}

/** Quiet tints for the other icons, all from the theme (deterministic by index). */
function tint(theme: ThemeTokens, i: number): string {
  const { light } = darkLight(theme);
  const night = nightTone(theme);
  const a = theme.colors.accent;
  const m = theme.colors.muted;
  const list = [mixColors(a, light, 0.15), mixColors(night, light, 0.25), mixColors(m, light, 0.2), mixColors(a, night, 0.45), mixColors(light, m, 0.35), mixColors(m, night, 0.3), mixColors(a, light, 0.5), mixColors(night, a, 0.25)];
  return list[(i * 5 + Math.floor(i / 4) * 3) % list.length];
}

/** A simple white glyph (circle, square, bars, wave…) for placeholder icons. */
function Glyph({ i, size, color }: { i: number; size: number; color: string }) {
  const k = i % 6;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" style={{ position: 'absolute', left: 0, top: 0 }}>
      {k === 0 ? <circle cx="10" cy="10" r="4.6" fill="none" stroke={color} strokeWidth="1.8" /> : null}
      {k === 1 ? <rect x="5.5" y="5.5" width="9" height="9" rx="2.2" fill={color} opacity="0.92" /> : null}
      {k === 2 ? <path d="M6 13V9M10 13V6M14 13v-3" stroke={color} strokeWidth="1.9" strokeLinecap="round" /> : null}
      {k === 3 ? <path d="M4.5 11.5c2-3 3.6-3 5.5 0s3.5 3 5.5 0" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" /> : null}
      {k === 4 ? <path d="M10 5l4.5 8h-9z" fill={color} opacity="0.92" /> : null}
      {k === 5 ? <><circle cx="7.5" cy="10" r="2" fill={color} /><circle cx="12.5" cy="10" r="2" fill={color} opacity="0.7" /></> : null}
    </svg>
  );
}

/**
 * The home screen: status bar, a 4 × 5 grid of quiet icons with the product's app at (row, col), a dock, and the app's
 * badge counting up (a pop on each step; the first one grows from nothing).
 */
export default function PhoneHomeBadge({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const t = frame / fps;
  const bias = biasMotion(theme.style_bias);
  const hasText = !!(slots.title || slots.kicker) && (params.layout === 'left' || variant === 'vertical');
  const g = phoneCardGeometry({ width, height, unit: u, displayHeight: params.height, layout: params.layout, withText: hasText });
  const d = g.display;
  const { dark, light } = darkLight(theme);
  const wallMid = params.wallpaper === 'paper' ? mixColors(light, theme.colors.accent, 0.2) : mixColors(nightTone(theme), theme.colors.accent, 0.2);
  const ink = readableOn(wallMid, light, dark, 3);
  const font = cssFontFamily(theme.fonts.body);

  // Grid (display coordinates) — mirrors the manifest anchor.
  const m = d.w * 0.075;
  const s = d.w * 0.155;
  const cg = (d.w - 2 * m - 4 * s) / 3;
  const y0 = d.h * 0.085;
  const pitch = s + d.h * 0.052;
  const label = d.w * 0.028;
  const cell = (row: number, col: number) => ({ x: m + col * (s + cg), y: y0 + row * pitch });
  const app = { row: params.row, col: params.col };

  const { count, since } = badgeCount(t, params);
  const first = count - params.from === 1 && params.from === 0;
  const pop = since < 0.35 ? (first ? progress(Math.round(since * fps), fps, { duration: 0.3, ease: 'entrance' }) : 1 + 0.28 * Math.sin(Math.PI * clamp(since / 0.3))) : 1;
  const badgeBg = params.badge === 'accent' ? theme.colors.accent : SYSTEM_COLORS.badge;
  const badgeInk = readableOn(badgeBg, SYSTEM_COLORS.page, dark, 3);
  const bs = s * 0.36;
  const text = String(count);
  const bw = Math.max(bs, bs * (0.62 + 0.38 * text.length));

  const enter = progress(frame, fps, { duration: 0.55 * bias.pace, ease: 'entrance' });
  const rise = roundTo((1 - enter) * 30 * bias.travel * u, 2);
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

  const cells: Array<{ row: number; col: number; i: number }> = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 4; col++) cells.push({ row, col, i: row * 4 + col });
  const dockY = d.h * 0.865;
  const dockH = s + d.w * 0.07;

  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, transform: `translateY(${rise}px)`, opacity: roundTo(Math.min(1, enter * 1.4), 4) }}>
        <PhoneDevice theme={theme} geometry={g} finish={params.finish} unit={u} status={{ ink, time: params.time }}>
          <div style={{ position: 'absolute', inset: 0, background: wallpaperCss(theme, params.wallpaper) }} />
          {cells.map(({ row, col, i }) => {
            const c = cell(row, col);
            const isApp = row === app.row && col === app.col;
            return (
              <div key={i} style={{ position: 'absolute', left: c.x, top: c.y, width: s }}>
                {isApp ? (
                  slots.icon && slots.icon !== theme.logo?.url ? (
                    <Img src={slots.icon} style={{ width: s, height: s, borderRadius: s * 0.225, display: 'block', objectFit: 'cover' }} />
                  ) : (
                    <AppIcon theme={theme} size={s} />
                  )
                ) : (
                  <div style={{ position: 'relative', width: s, height: s, borderRadius: s * 0.225, background: `linear-gradient(160deg, ${mixColors(tint(theme, i), light, 0.14)} 0%, ${tint(theme, i)} 100%)` }}>
                    <Glyph i={i} size={s} color={withAlpha(light, 0.92)} />
                  </div>
                )}
                {isApp ? (
                  <div style={{ marginTop: s * 0.08, textAlign: 'center', fontFamily: font, fontSize: label, color: ink, whiteSpace: 'nowrap', overflow: 'hidden' }}>{slots.app ?? theme.brand.name ?? ''}</div>
                ) : (
                  <div style={{ margin: `${s * 0.13}px auto 0`, width: s * (0.45 + ((i * 37) % 30) / 100), height: label * 0.55, borderRadius: label, background: withAlpha(ink, 0.45) }} />
                )}
                {isApp && count > 0 ? (
                  <div
                    style={{
                      position: 'absolute',
                      left: s - bw * 0.62,
                      top: -bs * 0.38,
                      minWidth: bw,
                      height: bs,
                      borderRadius: bs / 2,
                      background: badgeBg,
                      color: badgeInk,
                      fontFamily: font,
                      fontWeight: 600,
                      fontSize: bs * 0.62,
                      lineHeight: `${roundTo(bs, 2)}px`,
                      textAlign: 'center',
                      transform: `scale(${roundTo(pop, 4)})`,
                      boxShadow: `0 ${1 * u}px ${3 * u}px ${withAlpha(dark, 0.3)}`,
                    }}
                  >
                    {text}
                  </div>
                ) : null}
              </div>
            );
          })}
          {/* Dock. */}
          <div style={{ position: 'absolute', left: d.w * 0.04, width: d.w * 0.92, top: dockY, height: dockH, borderRadius: d.w * 0.09, background: withAlpha(light, 0.22) }}>
            {[0, 1, 2, 3].map((j) => (
              <div key={j} style={{ position: 'absolute', left: m - d.w * 0.04 + j * (s + cg), top: (dockH - s) / 2, width: s, height: s, borderRadius: s * 0.225, background: `linear-gradient(160deg, ${mixColors(tint(theme, j + 3), light, 0.14)} 0%, ${tint(theme, j + 3)} 100%)` }}>
                <Glyph i={j + 2} size={s} color={withAlpha(light, 0.92)} />
              </div>
            ))}
          </div>
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
