import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, Wordmark, cssFontFamily, rise, stagger } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { logo_size: number; stagger: number };

/** Big logo, wordmark, rule, tagline, url — centred, staggered. */
export default function Outro({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { start: 0.15, step: params.stagger }), unit });
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const column = Math.min(width - 320 * unit, 1300 * unit);
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ ...enter(0), marginBottom: 28 * unit }}>
          <Logo theme={brand} size={params.logo_size} unit={unit} />
        </div>
        <div style={{ ...enter(1), marginBottom: 32 * unit }}>
          <Wordmark theme={theme} height={52} unit={unit} />
        </div>
        <div style={{ ...enter(2), width: 64 * unit, height: 3 * unit, borderRadius: 2 * unit, background: theme.colors.accent, marginBottom: 32 * unit }} />
        {slots.tagline ? (
          <div style={enter(3)}>
            <FitText
              text={slots.tagline}
              width={column}
              maxFontSize={48 * unit}
              minFontSize={24 * unit}
              maxLines={2}
              fontFamily={theme.fonts.display}
              color={theme.colors.text}
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
              fontSize: 24 * unit,
              letterSpacing: '0.02em',
              color: theme.colors.muted,
            }}
          >
            {slots.url}
          </div>
        ) : null}
      </div>
    </Background>
  );
}
