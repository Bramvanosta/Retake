import {
  Background,
  CapText,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  figureAt,
  formatMetrics,
  nightTone,
  parseFigure,
  progress,
  readableOn,
  roundTo,
  useCurrentFrame,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, TextMedia, ThemeTokens } from '@retake/components/kit';

type Params = { from: number; count: number; tone: 'paper' | 'dark'; align: 'center' | 'left' };

const GAP_KICKER_FIGURE = 46;
const GAP_FIGURE_RULE = 48;
const GAP_RULE_LABEL = 40;
const GAP_LABEL_TEXT = 22;
const RULE_W = 120;

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'dark') {
    const bg = nightTone(theme);
    const ink = readableOn(bg, light, theme.colors.paper, 4.5);
    return { bg, ink, accent: readableOn(bg, theme.colors.accent, withAlpha(ink, 0.75), 2.6), muted: withAlpha(ink, 0.68) };
  }
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  return { bg: undefined, ink, accent: readableOn(bg, theme.colors.accent, ink, 2.2), muted: readableOn(bg, theme.colors.muted, ink, 3) };
}

function appear(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { opacity: roundTo(p, 4), transform: `translateY(${roundTo((1 - p) * distance, 2)}px)` };
}

/**
 * The figure is sized once, for its final text, so the counter never changes size; digits are tabular. The counter
 * runs `count` seconds from 0.35 s with a long ease-out landing on the exact text given.
 */
export default function CardFigure({ theme, slots, params, unit, width, height, fps, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const captured = media?.capture as TextMedia | undefined;
  const value = (captured?.value ?? slots.value ?? '').trim() || '—';
  const center = params.align !== 'left';
  const margin = inset(180);
  const column = Math.min(width - 2 * margin, 1400 * u);

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const figure = capTextLayout({ text: value, width: column, maxFontSize: 220 * u, minFontSize: 72 * u, maxLines: 1, lineHeight: 1, fontFamily: theme.fonts.display, letterSpacing: -0.02 });
  const label = slots.label ? capTextLayout({ text: slots.label, width: column, maxFontSize: 40 * u, minFontSize: 24 * u, maxLines: 2, lineHeight: 1.2, fontFamily: theme.fonts.display }) : null;
  const text = slots.text ? capTextLayout({ text: slots.text, width: Math.min(column, 1100 * u), maxFontSize: 26 * u, minFontSize: 18 * u, maxLines: 2, lineHeight: 1.35, fontFamily: theme.fonts.body, fontWeight: 400 }) : null;

  let y = 0;
  let kickerTop: number | undefined;
  if (kicker) {
    kickerTop = y;
    y += kicker.capHeight + GAP_KICKER_FIGURE * u;
  }
  const figureTop = y;
  y += figure.band + GAP_FIGURE_RULE * u;
  const ruleTop = y;
  y += 2 * u;
  let labelTop: number | undefined;
  if (label) {
    y += GAP_RULE_LABEL * u;
    labelTop = y;
    y += label.band;
  }
  let textTop: number | undefined;
  if (text) {
    y += (label ? GAP_LABEL_TEXT : GAP_RULE_LABEL) * u + (label ? 10 * u : 0);
    textTop = y;
    y += text.band;
  }
  const top = Math.round((height - y) / 2);
  const x = center ? width / 2 : margin;
  const align = center ? 'center' : 'left';

  const counting = parseFigure(value) !== null && params.count > 0;
  const p = counting ? progress(frame, fps, { delay: 0.35, duration: params.count, ease: [0.16, 0.84, 0.3, 1] }) : 1;
  const shown = counting ? figureAt(value, p, params.from) : value;
  const live = { ...figure, lines: [shown] };
  const kickerIn = appear(frame, fps, 0.1, 0.45 * bias.pace, 10 * bias.travel * u);
  const figureIn = appear(frame, fps, 0.2, 0.45 * bias.pace, 16 * bias.travel * u);
  const draw = progress(frame, fps, { delay: 0.55, duration: 0.5, ease: bias.travel > 1 ? 'entrance' : 'standard' });
  const labelIn = appear(frame, fps, 0.7, 0.5 * bias.pace, 10 * bias.travel * u);
  const textIn = appear(frame, fps, 0.85, 0.5 * bias.pace, 8 * bias.travel * u);

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker && kickerTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={x} capTop={top + kickerTop} align={align} color={c.accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...figureIn }}>
        <CapText layout={live} x={x} capTop={top + figureTop} align={align} color={c.ink} style={{ fontVariantNumeric: 'tabular-nums lining-nums' }} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: roundTo(center ? x - (RULE_W * u) / 2 : x, 2),
          top: Math.round(top + ruleTop),
          width: RULE_W * u,
          height: 2 * u,
          background: c.accent,
          transform: `scaleX(${roundTo(draw, 4)})`,
          transformOrigin: center ? 'center' : 'left',
        }}
      />
      {label && labelTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...labelIn }}>
          <CapText layout={label} x={x} capTop={top + labelTop} align={align} color={c.ink} />
        </div>
      ) : null}
      {text && textTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...textIn }}>
          <CapText layout={text} x={x} capTop={top + textTop} align={align} color={c.muted} />
        </div>
      ) : null}
    </Background>
  );
}
