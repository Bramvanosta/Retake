import { Background, FitText, Logo, Wordmark, cssFontFamily, rise, stagger, useCurrentFrame } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { align: 'center' | 'left'; rule: boolean; stagger: number };

/** Logo + wordmark, kicker, title, accent rule: each line rises in after the previous one. */
export default function Intro({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const center = params.align !== 'left';
  const margin = 160 * unit;
  const column = Math.min(width - 2 * margin, 1400 * unit);
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { start: 0.2, step: params.stagger }), unit });
  const brand = slots.logo ? { ...theme, logo: { url: slots.logo } } : theme;
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
        <div style={{ ...enter(0), display: 'flex', alignItems: 'center', gap: 20 * unit, marginBottom: 44 * unit }}>
          <Logo theme={brand} size={64} unit={unit} />
          <Wordmark theme={theme} height={40} unit={unit} />
        </div>
        {slots.kicker ? (
          <div
            style={{
              ...enter(1),
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 22 * unit,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: theme.colors.accent,
              marginBottom: 18 * unit,
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
            minFontSize={40 * unit}
            maxLines={2}
            lineHeight={1.08}
            fontFamily={theme.fonts.display}
            color={theme.colors.text}
            align={center ? 'center' : 'left'}
          />
        </div>
        {params.rule ? (
          <div style={{ ...enter(3), width: 72 * unit, height: 4 * unit, borderRadius: 2 * unit, background: theme.colors.accent, marginTop: 36 * unit }} />
        ) : null}
      </div>
    </Background>
  );
}
