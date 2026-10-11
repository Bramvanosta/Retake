import { useCurrentFrame } from 'remotion';
import { Background, FitText, Logo, Wordmark, cssFontFamily, progress, rise, roundTo, stagger } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { align: 'center' | 'left'; rule: boolean; stagger: number };

/** Logo + wordmark, kicker, title, accent rule: each line rises in after the previous one. */
export default function IntroStack({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const center = params.align !== 'left';
  const margin = 160 * unit;
  const column = Math.min(width - 2 * margin, 1500 * unit);
  const at = (i: number) => stagger(i, { start: 0.15, step: params.stagger });
  const enter = (i: number) => rise(frame, fps, { delay: at(i), duration: 0.6, distance: 14, unit });
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
  const draw = progress(frame, fps, { delay: at(3), duration: 0.5, ease: 'standard' });
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
        <div style={{ ...enter(0), display: 'flex', alignItems: 'center', gap: 18 * unit, marginBottom: 56 * unit }}>
          <Logo theme={brand} size={64} unit={unit} />
          <Wordmark theme={theme} height={44} unit={unit} />
        </div>
        {slots.kicker ? (
          <div
            style={{
              ...enter(1),
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 18 * unit,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: theme.colors.accent,
              marginBottom: 26 * unit,
            }}
          >
            {slots.kicker}
          </div>
        ) : null}
        <div style={enter(2)}>
          <FitText
            text={slots.title ?? ''}
            width={column}
            maxFontSize={96 * unit}
            minFontSize={44 * unit}
            maxLines={2}
            lineHeight={1.06}
            letterSpacing={-0.015}
            fontFamily={theme.fonts.display}
            color={theme.colors.text}
            align={center ? 'center' : 'left'}
          />
        </div>
        {params.rule ? (
          <div
            style={{
              width: 120 * unit,
              height: 2 * unit,
              background: theme.colors.accent,
              marginTop: 40 * unit,
              transform: `scaleX(${roundTo(draw, 4)})`,
              transformOrigin: center ? 'center' : 'left',
            }}
          />
        ) : null}
      </div>
    </Background>
  );
}
