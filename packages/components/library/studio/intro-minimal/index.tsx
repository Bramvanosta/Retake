import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, Wordmark, cssFontFamily, fadeIn, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { logo_only: boolean; align: 'center' | 'left' };

/** Title (+ kicker) fading in — or the logo and wordmark alone. */
export default function IntroMinimal({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const center = params.align !== 'left';
  const margin = 160 * unit;
  const a = (delay: number) => roundTo(fadeIn(frame, fps, { delay, duration: 0.6, ease: 'gentle' }), 4);
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const showTitle = !params.logo_only && !!slots.title;
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: center ? 'center' : 'flex-start',
          paddingLeft: center ? 0 : margin,
        }}
      >
        {showTitle ? (
          <>
            {slots.kicker ? (
              <div
                style={{
                  opacity: a(0.15),
                  fontFamily: cssFontFamily(theme.fonts.body),
                  fontWeight: 600,
                  fontSize: 18 * unit,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: theme.colors.accent,
                  marginBottom: 24 * unit,
                }}
              >
                {slots.kicker}
              </div>
            ) : null}
            <div style={{ opacity: a(0.3) }}>
              <FitText
                text={slots.title ?? ''}
                width={Math.min(width - 2 * margin, 1500 * unit)}
                maxFontSize={88 * unit}
                minFontSize={40 * unit}
                maxLines={2}
                lineHeight={1.06}
                letterSpacing={-0.015}
                fontFamily={theme.fonts.display}
                color={theme.colors.text}
                align={center ? 'center' : 'left'}
              />
            </div>
          </>
        ) : (
          <div style={{ opacity: a(0.15), display: 'flex', alignItems: 'center', gap: 22 * unit }}>
            <Logo theme={brand} size={96} unit={unit} />
            <Wordmark theme={theme} height={64} unit={unit} />
          </div>
        )}
      </div>
    </Background>
  );
}
