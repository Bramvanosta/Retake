import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { Background, CapText, biasMotion, capTextLayout, darkLight, nightTone, progress, readableOn, roundTo, withAlpha, formatMetrics } from '@retake/components/kit';
import type { ComponentProps, ThemeTokens } from '@retake/components/kit';

type Params = { tone: 'dark' | 'paper'; dim: number };

/** Design px from the frame centre: kicker caps centred −78, text caps centred +4, line 72 below (160 × 2). */
const KICKER_CENTRE = -78;
const TEXT_CENTRE = 4;
const LINE_OFFSET = 72;
const LINE_W = 160;

function palette(theme: ThemeTokens, tone: Params['tone']) {
  const { dark, light } = darkLight(theme);
  if (tone === 'paper') {
    const card = theme.colors.paper;
    const ink = readableOn(card, theme.colors.text, card === light ? dark : light, 4.5);
    return { card, ink, kicker: readableOn(card, theme.colors.accent, withAlpha(ink, 0.7), 2.6), track: withAlpha(ink, 0.14), fill: readableOn(card, theme.colors.accent, ink, 2) };
  }
  const card = nightTone(theme);
  const ink = readableOn(card, light, theme.colors.paper, 4.5);
  return { card, ink, kicker: withAlpha(ink, 0.66), track: withAlpha(ink, 0.22), fill: readableOn(card, theme.colors.accent, withAlpha(ink, 0.85), 2) };
}

/**
 * "Time passes" without a clock: the last frame (`screen`) dims under the veil (0.5 s, gently at first), the kicker and
 * the text rise in centred, and an accent line fills across the card's duration. style_bias balanced / motion: more
 * rise and a softer pace.
 */
export default function InterstitialPlain({ theme, slots, params, unit, width, height, fps, durationInFrames, screen, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const c = palette(theme, params.tone);
  const seconds = durationInFrames / fps;
  const veil = roundTo(progress(frame, fps, { duration: 0.5, ease: 'easeIn' }) * (screen ? params.dim : 1), 4);
  const kickerP = progress(frame, fps, { delay: 0.12, duration: 0.5 * bias.pace, ease: 'easeInOut' });
  const textP = progress(frame, fps, { delay: 0.2, duration: 0.55 * bias.pace, ease: 'easeInOut' });
  const run = progress(frame, fps, { delay: 0.35, duration: Math.max(0.3, seconds - 0.6), ease: 'linear' });
  const text = capTextLayout({ text: slots.text ?? '', width: Math.min(width - 2 * inset(160), 1300 * u), maxFontSize: 68 * u, minFontSize: 34 * u, maxLines: 2, lineHeight: 1.1, fontFamily: theme.fonts.display });
  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: Math.min(width - 2 * inset(160), 1100 * u), maxFontSize: 16 * u, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.16, uppercase: true })
    : null;
  const lift = (text.lines.length - 1) * text.lineHeightPx * 0.5;
  const cy = height / 2 - lift;
  const textCapTop = cy + TEXT_CENTRE * u - text.capHeight / 2;
  const lineY = cy + TEXT_CENTRE * u + text.capHeight / 2 + (text.lines.length - 1) * text.lineHeightPx + LINE_OFFSET * u - 30 * u;

  return (
    <Background theme={theme}>
      {screen ? <div style={{ position: 'absolute', inset: 0 }}>{screen as ReactNode}</div> : null}
      <div style={{ position: 'absolute', inset: 0, background: c.card, opacity: veil }} />
      {kicker ? (
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(kickerP, 4), transform: `translateY(${roundTo((1 - kickerP) * 10 * bias.travel * u, 2)}px)` }}>
          <CapText layout={kicker} x={width / 2} capTop={cy + KICKER_CENTRE * u - kicker.capHeight / 2} align="center" color={c.kicker} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(textP, 4), transform: `translateY(${roundTo((1 - textP) * 18 * bias.travel * u, 2)}px)` }}>
        <CapText layout={text} x={width / 2} capTop={textCapTop} align="center" color={c.ink} />
      </div>
      <div
        style={{
          position: 'absolute',
          left: roundTo(width / 2 - (LINE_W * u) / 2, 2),
          top: roundTo(lineY, 2),
          width: LINE_W * u,
          height: 2 * u,
          borderRadius: u,
          background: c.track,
          opacity: roundTo(textP, 4),
          overflow: 'hidden',
        }}
      >
        <div style={{ width: '100%', height: '100%', background: c.fill, transform: `scaleX(${roundTo(run, 4)})`, transformOrigin: 'left center' }} />
      </div>
    </Background>
  );
}
