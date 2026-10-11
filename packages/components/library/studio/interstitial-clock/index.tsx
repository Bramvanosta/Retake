import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { Background, FitText, cssFontFamily, darkLight, easing, fadeIn, progress, rise, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { dim: number; turns: number };

const sweep = easing('gentle');

/** A clock (minute hand sweeping, hour hand creeping) and the text over the dimmed last frame. */
export default function InterstitialClock({ theme, slots, params, unit, width, fps, durationInFrames, screen }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { dark, light } = darkLight(theme);
  const veil = roundTo(fadeIn(frame, fps, { duration: 0.5, ease: 'gentle' }) * (screen ? params.dim : 1), 4);
  const clockIn = rise(frame, fps, { delay: 0.25, duration: 0.5, distance: 10, unit });
  const textIn = rise(frame, fps, { delay: 0.4, duration: 0.55, distance: 12, unit });
  const t = progress(frame, fps, { delay: 0.3, duration: Math.max(0.2, durationInFrames / fps - 0.5), ease: sweep });
  const minute = -30 + 360 * params.turns * t;
  const hour = 60 + 30 * params.turns * t;
  const size = 100 * unit;
  const r = 48;
  return (
    <Background theme={theme}>
      {screen ? <div style={{ position: 'absolute', inset: 0 }}>{screen as ReactNode}</div> : null}
      <div style={{ position: 'absolute', inset: 0, background: dark, opacity: veil }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        {slots.kicker ? (
          <div
            style={{
              ...clockIn,
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 18 * unit,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: withAlpha(light, 0.65),
              marginBottom: 28 * unit,
            }}
          >
            {slots.kicker}
          </div>
        ) : null}
        <div style={{ ...clockIn, width: size, height: size, marginBottom: 44 * unit }}>
          <svg width={size} height={size} viewBox="-50 -50 100 100">
            <circle cx={0} cy={0} r={r - 1.5} fill="none" stroke={withAlpha(light, 0.32)} strokeWidth={3} />
            <line x1={0} y1={0} x2={0} y2={-22} stroke={theme.colors.accent} strokeWidth={3.5} strokeLinecap="round" transform={`rotate(${roundTo(hour, 3)})`} />
            <line x1={0} y1={0} x2={0} y2={-34} stroke={light} strokeWidth={3} strokeLinecap="round" transform={`rotate(${roundTo(minute, 3)})`} />
            <circle cx={0} cy={0} r={3.5} fill={light} />
          </svg>
        </div>
        <div style={textIn}>
          <FitText
            text={slots.text ?? ''}
            width={Math.min(width - 320 * unit, 1300 * unit)}
            maxFontSize={72 * unit}
            minFontSize={32 * unit}
            maxLines={2}
            lineHeight={1.1}
            fontFamily={theme.fonts.display}
            color={light}
            align="center"
          />
        </div>
      </div>
    </Background>
  );
}
