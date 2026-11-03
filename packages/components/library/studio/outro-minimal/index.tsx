import { useCurrentFrame } from 'remotion';
import { Background, CapText, Logo, Wordmark, backgroundSample, biasMotion, capTextLayout, darkLight, progress, readableOn, roundTo, formatMetrics } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { logo_only: boolean };

/** Design px: logo 110, 56 px to the tagline caps (display 52); logo-only row: logo 110 + wordmark 64 (visual height). */
const LOGO = 110;
const GAP_LOGO_TAGLINE = 56;
const WORDMARK = 64;

/**
 * Logo (fades in while scaling 0.94 → 1) and one closing line (0.35 s later, a short rise), centred as a stack by
 * their bands — or, with logo_only, the logo and the wordmark on one row. style_bias balanced / motion: more rise and
 * a softer pace.
 */
export default function OutroMinimal({ theme, slots, params, unit, width, height, fps, variant }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const bg = backgroundSample(theme);
  const { dark, light } = darkLight(theme);
  const ink = readableOn(bg, theme.colors.text, readableOn(bg, dark, light) === dark ? dark : light);
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const logoP = progress(frame, fps, { delay: 0.1, duration: 0.6 * bias.pace, ease: 'easeInOut' });
  const logoScale = roundTo(0.94 + 0.06 * progress(frame, fps, { delay: 0.1, duration: 0.7 * bias.pace, ease: 'entrance' }), 4);
  const tagline = !params.logo_only && slots.tagline ? slots.tagline : undefined;

  if (!tagline) {
    return (
      <Background theme={theme}>
        <div
          style={{
            position: 'absolute',
            left: 0,
            width,
            top: Math.round((height - LOGO * u) / 2),
            height: LOGO * u,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 26 * u,
            opacity: roundTo(logoP, 4),
            transform: `scale(${logoScale})`,
          }}
        >
          <Logo theme={brand} size={LOGO} unit={u} />
          <Wordmark theme={theme} height={WORDMARK} unit={u} color={ink} />
        </div>
      </Background>
    );
  }

  const line = capTextLayout({ text: tagline, width: Math.min(width - 2 * inset(160), 1300 * u), maxFontSize: 52 * u, minFontSize: 28 * u, maxLines: 2, lineHeight: 1.12, fontFamily: theme.fonts.display });
  const stack = LOGO * u + GAP_LOGO_TAGLINE * u + line.band;
  const top = Math.round((height - stack) / 2);
  const lineP = progress(frame, fps, { delay: 0.45, duration: 0.5 * bias.pace, ease: 'easeInOut' });
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          width,
          top,
          height: LOGO * u,
          display: 'flex',
          justifyContent: 'center',
          opacity: roundTo(logoP, 4),
          transform: `scale(${logoScale})`,
        }}
      >
        <Logo theme={brand} size={LOGO} unit={u} />
      </div>
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(lineP, 4), transform: `translateY(${roundTo((1 - lineP) * 10 * bias.travel * u, 2)}px)` }}>
        <CapText layout={line} x={width / 2} capTop={top + (LOGO + GAP_LOGO_TAGLINE) * u} align="center" color={ink} />
      </div>
    </Background>
  );
}
