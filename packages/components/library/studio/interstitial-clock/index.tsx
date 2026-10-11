import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { Background, CapText, biasMotion, capTextLayout, darkLight, mixColors, nightTone, progress, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { dim: number; turns: number };

/**
 * Reference values (docs/reference/look.md "Interstitial", design px): a 100 px clock (3 px ring between the night
 * tone and the paper, round-capped hands: minute 34 px in the paper colour, hour 22 px in the accent) centred at
 * y ≈ 480, the text in the display font at 72 px, paper colour, cap-centred at y ≈ 612; the night tone is the
 * theme's dark colour (`colors.dark`, else the text colour of a light theme).
 */
const CLOCK = 100;
const CLOCK_CENTRE = -60; // from the frame centre
const TEXT_CENTRE = 72; // cap centre, from the frame centre

/**
 * "Time passes": from the last frame of the previous clip (`screen`, drawn as it was), a warm night veil fades in over
 * 0.6 s (gently at first) until the card is fully dark; the clock and the text fade in on top (the text with a short rise) while the
 * minute hand sweeps about one turn (eased) and the hour hand creeps; the next clip then crossfades in.
 * style_bias balanced / motion: the clock settles from a slightly smaller scale and its ring draws itself.
 */
export default function InterstitialClock({ theme, slots, params, unit, width, height, fps, durationInFrames, screen }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const night = nightTone(theme);
  const { light } = darkLight(theme);
  const paper = night === light ? darkLight(theme).dark : light;
  const ring = mixColors(night, paper, 0.25);
  const seconds = durationInFrames / fps;

  // The veil starts gently (the last frame stays readable while the clock and the text begin to appear, as in the
  // reference) and closes to a full dark card by 0.6 s.
  const veil = roundTo(progress(frame, fps, { duration: 0.6, ease: 'easeIn' }) * (screen ? params.dim : 1), 4);
  const clockP = progress(frame, fps, { delay: 0.1, duration: 0.55 * bias.pace, ease: 'easeInOut' });
  const textP = progress(frame, fps, { delay: 0.15, duration: 0.6 * bias.pace, ease: 'easeInOut' });
  const sweep = progress(frame, fps, { delay: 0.35, duration: Math.max(0.3, seconds - 0.5), ease: 'easeInOut' });
  const minute = roundTo(360 * params.turns * sweep, 3);
  const hour = roundTo(60 + 30 * params.turns * sweep, 3);
  const drawRing = bias.travel > 1 ? progress(frame, fps, { delay: 0.15, duration: 0.7, ease: 'entrance' }) : 1;
  const clockScale = bias.settle > 0 ? roundTo(1 - 2 * bias.settle * (1 - clockP), 4) : 1;

  const text = capTextLayout({
    text: slots.text ?? '',
    width: Math.min(width - 320 * u, 1400 * u),
    maxFontSize: 72 * u,
    minFontSize: 36 * u,
    maxLines: 2,
    lineHeight: 1.1,
    fontFamily: theme.fonts.display,
  });
  // A second text line grows the block downwards: lift everything by half of it to stay balanced.
  const lift = (text.lines.length - 1) * text.lineHeightPx * 0.5;
  const cy = height / 2 + CLOCK_CENTRE * u - lift;
  const size = CLOCK * u;
  const textCapTop = height / 2 + TEXT_CENTRE * u - lift - text.capHeight / 2;
  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: Math.min(width - 320 * u, 1200 * u), maxFontSize: 16 * u, minFontSize: 11 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.16, uppercase: true })
    : null;
  const r = 48.5;
  const circumference = 2 * Math.PI * r;

  return (
    <Background theme={theme}>
      {screen ? <div style={{ position: 'absolute', inset: 0 }}>{screen as ReactNode}</div> : null}
      <div style={{ position: 'absolute', inset: 0, background: night, opacity: veil }} />
      {kicker ? (
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(clockP, 4) }}>
          <CapText layout={kicker} x={width / 2} capTop={cy - size / 2 - 44 * u - kicker.capHeight} align="center" color={withAlpha(paper, 0.65)} />
        </div>
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: roundTo(width / 2 - size / 2, 2),
          top: roundTo(cy - size / 2, 2),
          width: size,
          height: size,
          opacity: roundTo(clockP, 4),
          transform: clockScale !== 1 ? `scale(${clockScale})` : undefined,
        }}
      >
        <svg width={size} height={size} viewBox="-50 -50 100 100" style={{ display: 'block', overflow: 'visible' }}>
          <circle
            cx={0}
            cy={0}
            r={r}
            fill="none"
            stroke={ring}
            strokeWidth={3}
            strokeDasharray={drawRing < 1 ? `${roundTo(circumference * drawRing, 3)} ${roundTo(circumference, 3)}` : undefined}
            transform={drawRing < 1 ? 'rotate(-90)' : undefined}
          />
          <line x1={0} y1={0} x2={0} y2={-22} stroke={theme.colors.accent} strokeWidth={4.5} strokeLinecap="round" transform={`rotate(${hour})`} />
          <line x1={0} y1={0} x2={0} y2={-34} stroke={paper} strokeWidth={3.5} strokeLinecap="round" transform={`rotate(${minute})`} />
          <circle cx={0} cy={0} r={4} fill={paper} />
        </svg>
      </div>
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(textP, 4), transform: `translateY(${roundTo((1 - textP) * 22 * bias.travel * u, 2)}px)` }}>
        <CapText layout={text} x={width / 2} capTop={textCapTop} align="center" color={paper} />
      </div>
    </Background>
  );
}
