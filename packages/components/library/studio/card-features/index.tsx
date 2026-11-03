import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  Icon,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  formatMetrics,
  mixColors,
  nightTone,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, ThemeTokens } from '@retake/components/kit';

type Item = { title: string; text?: string; icon?: string };
type Params = { items: Item[]; stagger: number; tone: 'paper' | 'dark' };

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, surface: bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), muted: withAlpha(ink, 0.68) };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, surface: bg, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), muted: readableOn(bg, theme.colors.muted, ink, 3) };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/**
 * Landscape: the title block on the left third, the items stacked on the right, centred vertically. Vertical / square:
 * the title block on top, the items under it. Items appear one by one (`stagger`), the chip pops, the text rises.
 */
export default function CardFeatures({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const items = (params.items ?? []).slice(0, 5);
  const wide = variant === 'landscape';
  const margin = inset(180);
  const inner = width - 2 * margin;
  const titleW = wide ? Math.min(620 * u, inner * 0.38) : inner;
  const listX = wide ? margin + titleW + 120 * u : margin;
  const listW = wide ? width - margin - listX : inner;

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: titleW, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = capTextLayout({ text: slots.title ?? '', width: titleW, maxFontSize: (wide ? 72 : 76) * u, minFontSize: 40 * u, maxLines: 3, lineHeight: 1.06, fontFamily: theme.fonts.display, letterSpacing: -0.01 });

  const chip = 72 * u;
  const textX = chip + 28 * u;
  const rows = items.map((it) => ({
    title: capTextLayout({ text: it.title, width: listW - textX, maxFontSize: 36 * u, minFontSize: 20 * u, maxLines: 2, lineHeight: 1.15, fontFamily: theme.fonts.body, fontWeight: 600 }),
    text: it.text ? capTextLayout({ text: it.text, width: listW - textX, maxFontSize: 25 * u, minFontSize: 16 * u, maxLines: 2, lineHeight: 1.35, fontFamily: theme.fonts.body, fontWeight: 400 }) : null,
  }));
  const rowH = rows.map((r) => Math.max(chip, r.title.band + (r.text ? 16 * u + r.text.band : 0)));
  const rowGap = (items.length > 4 ? 36 : 50) * u;
  const listH = rowH.reduce((s, h) => s + h, 0) + Math.max(0, items.length - 1) * rowGap;

  // Title block: kicker caps, title, rule.
  let ty = 0;
  const kickerTop = kicker ? ty : undefined;
  if (kicker) ty += kicker.capHeight + 34 * u;
  const titleTop = ty;
  ty += title.band + 40 * u;
  const ruleTop = ty;
  ty += 2 * u;
  const titleH = ty;

  let titleY: number;
  let listY: number;
  if (wide) {
    titleY = Math.round((height - titleH) / 2);
    listY = Math.round((height - listH) / 2);
  } else {
    const gap = 90 * u;
    const total = titleH + gap + listH;
    titleY = Math.round((height - total) / 2);
    listY = titleY + titleH + gap;
  }

  const kickerIn = appear(frame, fps, 0.1, 0.45 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.25, 0.5 * bias.pace, 14 * bias.travel * u);
  const draw = progress(frame, fps, { delay: 0.5, duration: 0.5, ease: bias.travel > 1 ? 'entrance' : 'standard' });
  const chipBg = mixColors(c.surface, c.accent, 0.14);

  let y = listY;
  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker && kickerTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={margin} capTop={titleY + kickerTop} color={c.accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...titleIn }}>
        <CapText layout={title} x={margin} capTop={titleY + titleTop} color={c.ink} />
      </div>
      <div style={{ position: 'absolute', left: margin, top: Math.round(titleY + ruleTop), width: 120 * u, height: 2 * u, background: c.accent, transform: `scaleX(${roundTo(draw, 4)})`, transformOrigin: 'left' }} />
      {items.map((it, i) => {
        const top = y;
        y += rowH[i] + rowGap;
        const delay = 0.7 + i * params.stagger;
        const pop = progress(frame, fps, { delay, duration: 0.4 * bias.pace, ease: [0.34, 1.4, 0.64, 1] });
        const rowIn = appear(frame, fps, delay + 0.08, 0.45 * bias.pace, 12 * bias.travel * u);
        const r = rows[i];
        const textTop = top + (r.text ? 0 : (chip - r.title.capHeight) / 2) + (r.text ? Math.max(0, (chip - (r.title.band + 16 * u + r.text.band)) / 2) : 0);
        const number = String(i + 1).padStart(2, '0');
        const numberLayout = capTextLayout({ text: number, width: chip, maxFontSize: 24 * u, minFontSize: 14 * u, maxLines: 1, fontFamily: theme.fonts.body, fontWeight: 700 });
        return (
          <div key={i}>
            <div
              style={{
                position: 'absolute',
                left: listX,
                top: roundTo(top, 2),
                width: chip,
                height: chip,
                borderRadius: chip / 2,
                background: chipBg,
                opacity: roundTo(Math.min(1, pop * 1.5), 4),
                transform: `scale(${roundTo(0.6 + 0.4 * pop, 4)})`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {it.icon ? <Icon name={it.icon} size={roundTo(chip * 0.5, 2)} color={c.accent} strokeWidth={1.9} /> : <CapText layout={numberLayout} x={chip / 2} capTop={(chip - numberLayout.capHeight) / 2} align="center" color={c.accent} />}
            </div>
            <div style={{ position: 'absolute', inset: 0, ...rowIn }}>
              <CapText layout={r.title} x={listX + textX} capTop={textTop} color={c.ink} />
              {r.text ? <CapText layout={r.text} x={listX + textX} capTop={textTop + r.title.band + 16 * u} color={c.muted} /> : null}
            </div>
          </div>
        );
      })}
    </Background>
  );
}
