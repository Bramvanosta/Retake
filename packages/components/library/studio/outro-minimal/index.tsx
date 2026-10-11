import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, Wordmark, fadeIn, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { logo_only: boolean };

/** Logo + tagline (or logo + wordmark), centred, fading in. */
export default function OutroMinimal({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const a = (delay: number) => roundTo(fadeIn(frame, fps, { delay, duration: 0.6, ease: 'gentle' }), 4);
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const tagline = !params.logo_only && slots.tagline ? slots.tagline : undefined;
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ opacity: a(0.1), display: 'flex', alignItems: 'center', gap: 22 * unit, marginBottom: tagline ? 40 * unit : 0 }}>
          <Logo theme={brand} size={tagline ? 88 : 110} unit={unit} />
          {tagline ? null : <Wordmark theme={theme} height={70} unit={unit} />}
        </div>
        {tagline ? (
          <div style={{ opacity: a(0.35) }}>
            <FitText
              text={tagline}
              width={Math.min(width - 320 * unit, 1300 * unit)}
              maxFontSize={52 * unit}
              minFontSize={26 * unit}
              maxLines={2}
              lineHeight={1.12}
              fontFamily={theme.fonts.display}
              color={theme.colors.text}
              align="center"
            />
          </div>
        ) : null}
      </div>
    </Background>
  );
}
