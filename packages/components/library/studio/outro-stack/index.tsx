import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, Wordmark, cssFontFamily, progress, rise, roundTo, stagger, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { logo_size: number; stagger: number };

/** Big logo (fades + scales in), wordmark, rule, tagline, url — centred, staggered. */
export default function OutroStack({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const at = (i: number) => stagger(i, { start: 0.1, step: params.stagger });
  const enter = (i: number) => rise(frame, fps, { delay: at(i), duration: 0.6, distance: 12, unit });
  const pop = progress(frame, fps, { delay: at(0), duration: 0.6, ease: 'entrance' });
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const column = Math.min(width - 320 * unit, 1300 * unit);
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ opacity: roundTo(Math.min(1, pop * 1.3), 4), transform: `scale(${roundTo(0.92 + 0.08 * pop, 4)})`, marginBottom: 36 * unit }}>
          <Logo theme={brand} size={params.logo_size} unit={unit} />
        </div>
        <div style={{ ...enter(1), marginBottom: 34 * unit }}>
          <Wordmark theme={theme} height={64} unit={unit} />
        </div>
        <div style={{ ...enter(2), width: 120 * unit, height: 2 * unit, background: theme.colors.accent, marginBottom: 30 * unit }} />
        {slots.tagline ? (
          <div style={enter(3)}>
            <FitText
              text={slots.tagline}
              width={column}
              maxFontSize={30 * unit}
              minFontSize={20 * unit}
              maxLines={2}
              fontFamily={theme.fonts.body}
              color={theme.colors.muted}
              align="center"
            />
          </div>
        ) : null}
        {slots.url ? (
          <div
            style={{
              ...enter(4),
              marginTop: 18 * unit,
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 18 * unit,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: withAlpha(theme.colors.muted, 0.7),
            }}
          >
            {slots.url}
          </div>
        ) : null}
      </div>
    </Background>
  );
}
