import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  nightTone,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components/kit';

type Params = { align: 'center' | 'left'; rule: boolean; tone: 'paper' | 'dark' };

/**
 * Design px, in the rhythm of the reference intro: kicker body SemiBold 18 uppercase +0.18 em; title display 84 (two
 * lines at most, tight); accent rule 120 × 2; text body 28 in the muted colour (two lines at most). Gaps between the
 * visual bands (kicker caps → title caps, title baseline → rule → text caps).
 */
const GAP_KICKER_TITLE = 40;
const GAP_TITLE_RULE = 44;
const GAP_RULE_TEXT = 34;
const GAP_TITLE_TEXT = 40;
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
 * A chapter card: kicker, title, accent rule (drawn from the centre) and text, centred as a stack by their cap bands,
 * staggered in (kicker 0.15 s, title 0.3 s, rule 0.55 s, text 0.65 s), then held. style_bias balanced / motion: more
 * rise and a softer pace.
 */
export default function CardTitle({ theme, slots, params, unit, width, height, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const center = params.align !== 'left';
  const margin = 180 * u;
  const column = Math.min(width - 2 * margin, 1400 * u);

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = capTextLayout({ text: slots.title ?? '', width: column, maxFontSize: 84 * u, minFontSize: 44 * u, maxLines: 2, lineHeight: 1.06, fontFamily: theme.fonts.display, letterSpacing: -0.012 });
  const text = slots.text
    ? capTextLayout({ text: slots.text, width: Math.min(column, 1100 * u), maxFontSize: 28 * u, minFontSize: 18 * u, maxLines: 2, lineHeight: 1.35, fontFamily: theme.fonts.body, fontWeight: 400 })
    : null;

  // Bands and gaps, then centre the stack.
  let y = 0;
  let kickerTop: number | undefined;
  if (kicker) {
    kickerTop = y;
    y += kicker.capHeight + GAP_KICKER_TITLE * u;
  }
  const titleTop = y;
  y += title.band;
  let ruleTop: number | undefined;
  if (params.rule) {
    y += GAP_TITLE_RULE * u;
    ruleTop = y;
    y += 2 * u;
  }
  let textTop: number | undefined;
  if (text) {
    y += (params.rule ? GAP_RULE_TEXT : GAP_TITLE_TEXT) * u;
    textTop = y;
    y += text.band;
  }
  const top = Math.round((height - y) / 2);
  const x = center ? width / 2 : margin;
  const align = center ? 'center' : 'left';

  const kickerIn = appear(frame, fps, 0.15, 0.45 * bias.pace, 10 * bias.travel * u);
  const titleIn = appear(frame, fps, 0.3, 0.5 * bias.pace, 14 * bias.travel * u);
  const draw = progress(frame, fps, { delay: 0.55, duration: 0.5, ease: bias.travel > 1 ? 'entrance' : 'standard' });
  const textIn = appear(frame, fps, 0.65, 0.5 * bias.pace, 8 * bias.travel * u);

  return (
    <Background theme={theme} style={c.bg ? { background: c.bg } : undefined}>
      {kicker && kickerTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn }}>
          <CapText layout={kicker} x={x} capTop={top + kickerTop} align={align} color={c.accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...titleIn }}>
        <CapText layout={title} x={x} capTop={top + titleTop} align={align} color={c.ink} />
      </div>
      {ruleTop !== undefined ? (
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
      ) : null}
      {text && textTop !== undefined ? (
        <div style={{ position: 'absolute', inset: 0, ...textIn }}>
          <CapText layout={text} x={x} capTop={top + textTop} align={align} color={c.muted} />
        </div>
      ) : null}
    </Background>
  );
}
