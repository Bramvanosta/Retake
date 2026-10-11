import { useCurrentFrame } from 'remotion';
import { Background, FitText, cssFontFamily, rise, stagger } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { align: 'center' | 'left' };

/** Kicker, title and optional text, rising in on the theme background. */
export default function CardTitle({ theme, slots, params, unit, width, fps }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const center = params.align !== 'left';
  const margin = 180 * unit;
  const column = Math.min(width - 2 * margin, 1300 * unit);
  const enter = (i: number) => rise(frame, fps, { delay: stagger(i, { start: 0.1, step: 0.1 }), unit });
  const align = center ? 'center' : 'left';
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
        {slots.kicker ? (
          <div
            style={{
              ...enter(0),
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 20 * unit,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: theme.colors.accent,
              marginBottom: 18 * unit,
            }}
          >
            {slots.kicker}
          </div>
        ) : null}
        <div style={enter(1)}>
          <FitText
            text={slots.title ?? ''}
            width={column}
            maxFontSize={84 * unit}
            minFontSize={36 * unit}
            maxLines={2}
            lineHeight={1.08}
            fontFamily={theme.fonts.display}
            color={theme.colors.text}
            align={align}
          />
        </div>
        {slots.text ? (
          <div style={{ ...enter(2), marginTop: 24 * unit }}>
            <FitText
              text={slots.text}
              width={column}
              maxFontSize={30 * unit}
              minFontSize={18 * unit}
              maxLines={3}
              lineHeight={1.35}
              fontFamily={theme.fonts.body}
              color={theme.colors.muted}
              align={align}
            />
          </div>
        ) : null}
      </div>
    </Background>
  );
}
