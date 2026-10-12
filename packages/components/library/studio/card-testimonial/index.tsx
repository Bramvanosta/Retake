import { Img, useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  SYSTEM_COLORS,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  formatMetrics,
  nightTone,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components/kit';

type Params = { tone: 'paper' | 'dark'; align: 'center' | 'left'; marks: boolean };

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), muted: withAlpha(ink, 0.68), light };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), muted: readableOn(bg, theme.colors.muted, ink, 3), light };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/**
 * The stack (mark, quote lines, rule, attribution row) is centred vertically; quote lines rise one by one from 0.3 s,
 * the attribution follows the last line.
 */
export default function CardTestimonial({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const center = params.align !== 'left';
  const margin = inset(220);
  const column = Math.min(width - 2 * margin, 1320 * u);
  const x = center ? width / 2 : (width - column) / 2;
  const align = center ? 'center' : 'left';

  const mark = params.marks ? capTextLayout({ text: '“', width: 300 * u, maxFontSize: 190 * u, minFontSize: 80 * u, maxLines: 1, lineHeight: 1, fontFamily: theme.fonts.display }) : null;
  const quote = capTextLayout({ text: slots.quote ?? '', width: column, maxFontSize: 58 * u, minFontSize: 30 * u, maxLines: 4, lineHeight: 1.18, fontFamily: theme.fonts.display, letterSpacing: -0.005 });
  const name = capTextLayout({ text: slots.name ?? '', width: column * 0.6, maxFontSize: 26 * u, minFontSize: 18 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600 });
  const roleText = [slots.role, slots.company].filter(Boolean).join(' · ');
  const role = roleText ? capTextLayout({ text: roleText, width: column * 0.6, maxFontSize: 22 * u, minFontSize: 15 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 400 }) : null;
  const avatar = 72 * u;
  const logoH = 40 * u;
  const textW = Math.max(name.width, role?.width ?? 0);
  const rowW = avatar + 22 * u + textW + (slots.logo ? 48 * u + logoH * 3 : 0);
  const rowH = avatar;

  // Mark → quote → rule → attribution.
  const markH = mark ? mark.capHeight * 0.55 : 0;
  let y = 0;
  const markTop = y;
  y += markH + (mark ? 30 * u : 0);
  const quoteTop = y;
  y += quote.band + 50 * u;
  const ruleTop = y;
  y += 2 * u + 44 * u;
  const rowTop = y;
  y += rowH;
  const top = Math.round((height - y) / 2);

  const lineDelay = (i: number) => 0.3 + i * 0.14;
  const after = lineDelay(quote.lines.length) + 0.2;
  const markIn = appear(frame, fps, 0.05, 0.5 * bias.pace, 10 * bias.travel * u);
  const draw = progress(frame, fps, { delay: after, duration: 0.5, ease: 'standard' });
  const rowIn = appear(frame, fps, after + 0.15, 0.5 * bias.pace, 12 * bias.travel * u);
  const rowX = center ? x - rowW / 2 : x;
  const ink = readableOn(c.accent, c.light, SYSTEM_COLORS.white, 3);
  const ini = capTextLayout({ text: initials(slots.name ?? ''), width: avatar, maxFontSize: 26 * u, minFontSize: 14 * u, maxLines: 1, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.04 });

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {mark ? (
        <div style={{ position: 'absolute', inset: 0, ...markIn }}>
          <CapText layout={mark} x={center ? x : x - 8 * u} capTop={top + markTop} align={align} color={c.accent} />
        </div>
      ) : null}
      {quote.lines.map((line, i) => {
        const l = { ...quote, lines: [line] };
        const st = appear(frame, fps, lineDelay(i), 0.55 * bias.pace, 14 * bias.travel * u);
        return (
          <div key={i} style={{ position: 'absolute', inset: 0, ...st }}>
            <CapText layout={l} x={x} capTop={top + quoteTop + i * quote.lineHeightPx} align={align} color={c.ink} />
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: roundTo(center ? x - 60 * u : x, 2), top: Math.round(top + ruleTop), width: 120 * u, height: 2 * u, background: c.accent, transform: `scaleX(${roundTo(draw, 4)})`, transformOrigin: center ? 'center' : 'left' }} />
      <div style={{ position: 'absolute', inset: 0, ...rowIn }}>
        <div style={{ position: 'absolute', left: roundTo(rowX, 2), top: roundTo(top + rowTop, 2), width: avatar, height: avatar, borderRadius: avatar / 2, overflow: 'hidden', background: c.accent }}>
          {slots.avatar ? <Img src={slots.avatar} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /> : <CapText layout={ini} x={avatar / 2} capTop={(avatar - ini.capHeight) / 2} align="center" color={ink} />}
        </div>
        <CapText layout={name} x={rowX + avatar + 22 * u} capTop={top + rowTop + (role ? avatar / 2 - name.capHeight - 7 * u : (avatar - name.capHeight) / 2)} color={c.ink} />
        {role ? <CapText layout={role} x={rowX + avatar + 22 * u} capTop={top + rowTop + avatar / 2 + 7 * u} color={c.muted} /> : null}
        {slots.logo ? (
          <div style={{ position: 'absolute', left: roundTo(rowX + avatar + 22 * u + textW + 48 * u, 2), top: roundTo(top + rowTop + (avatar - logoH) / 2, 2), height: logoH, width: logoH * 3, display: 'flex', alignItems: 'center' }}>
            <Img src={slots.logo} style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain', display: 'block' }} />
          </div>
        ) : null}
      </div>
    </Background>
  );
}
