import { useCurrentFrame } from 'remotion';
import {
  Background,
  CapText,
  Logo,
  Wordmark,
  backgroundSample,
  biasMotion,
  capTextLayout,
  darkLight,
  progress,
  readableOn,
  roundTo,
} from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { logo_only: boolean; align: 'center' | 'left' };

/** Design px (reference intro): kicker 18 → 43 px gap → title 96; logo-only row: logo 96 + wordmark 50 (visual height). */
const GAP_KICKER_TITLE = 43;
const LOGO = 96;
const WORDMARK = 50;
const ROW_GAP = 24;

function fade(frame: number, fps: number, delay: number, duration: number, distance: number) {
  const p = progress(frame, fps, { delay, duration, ease: 'easeInOut' });
  return { p, style: { opacity: roundTo(p, 4), transform: distance > 0 ? `translateY(${roundTo((1 - p) * distance, 2)}px)` : undefined } };
}

/**
 * Kicker + title fading in, centred by their cap bands (style_bias real: a pure fade; balanced / motion: a short rise
 * and a tracking settle on the title) — or, with logo_only, the logo and the wordmark on one row fading (and, livelier,
 * settling) in.
 */
export default function IntroMinimal({ theme, slots, params, unit, width, height, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const center = params.align !== 'left';
  const margin = 160 * u;
  const column = Math.min(width - 2 * margin, 1500 * u);
  const bg = backgroundSample(theme);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  const accent = readableOn(bg, theme.colors.accent, ink, 2.2);
  const lively = bias.travel > 1;

  if (params.logo_only || !slots.title) {
    const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
    const row = fade(frame, fps, 0.15, 0.6 * bias.pace, lively ? 8 * bias.travel * u : 0);
    const s = bias.settle > 0 ? roundTo(1 - 2 * bias.settle * (1 - row.p), 4) : 1;
    return (
      <Background theme={theme}>
        <div
          style={{
            position: 'absolute',
            left: center ? 0 : margin,
            width: center ? width : column,
            top: Math.round((height - LOGO * u) / 2),
            height: LOGO * u,
            display: 'flex',
            alignItems: 'center',
            justifyContent: center ? 'center' : 'flex-start',
            gap: ROW_GAP * u,
            opacity: row.style.opacity,
            transform: [row.style.transform, s !== 1 ? `scale(${s})` : ''].filter(Boolean).join(' ') || undefined,
          }}
        >
          <Logo theme={brand} size={LOGO} unit={u} />
          <Wordmark theme={theme} height={WORDMARK} unit={u} color={ink} />
        </div>
      </Background>
    );
  }

  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: column, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = capTextLayout({ text: slots.title, width: column, maxFontSize: 96 * u, minFontSize: 56 * u, maxLines: 2, lineHeight: 1.05, fontFamily: theme.fonts.display, letterSpacing: -0.015 });
  const kickerBand = kicker ? kicker.capHeight + GAP_KICKER_TITLE * u : 0;
  const top = Math.round((height - kickerBand - title.band) / 2);
  const x = center ? width / 2 : margin;
  const align = center ? 'center' : 'left';
  const kickerIn = fade(frame, fps, 0.15, 0.5 * bias.pace, lively ? 10 * bias.travel * u : 0);
  const titleIn = fade(frame, fps, 0.35, 0.6 * bias.pace, lively ? 14 * bias.travel * u : 0);
  const tracking = bias.tracking > 0 ? roundTo(-0.015 + bias.tracking * (1 - titleIn.p), 4) : undefined;

  return (
    <Background theme={theme}>
      {kicker ? (
        <div style={{ position: 'absolute', inset: 0, ...kickerIn.style }}>
          <CapText layout={kicker} x={x} capTop={top} align={align} color={accent} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, ...titleIn.style }}>
        <CapText layout={title} x={x} capTop={top + kickerBand} align={align} color={ink} style={tracking !== undefined ? { letterSpacing: `${tracking}em` } : undefined} />
      </div>
    </Background>
  );
}
