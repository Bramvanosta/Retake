import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { Background, FitText, cssFontFamily, darkLight, fadeIn, progress, readableOn, rise, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { tone: 'dark' | 'paper'; dim: number };

/** Text + kicker over the dimmed last frame (dark) or the theme paper; an accent line runs while it is shown. */
export default function InterstitialPlain({ theme, slots, params, unit, width, fps, durationInFrames, screen }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const dark = params.tone !== 'paper';
  const tones = darkLight(theme);
  // tone paper: a card in the theme's paper colour (dark on a dark theme) with text-coloured type.
  const card = dark ? tones.dark : theme.colors.paper;
  const ink = dark ? tones.light : readableOn(theme.colors.paper, theme.colors.text, tones.dark === theme.colors.paper ? tones.light : tones.dark);
  const veil = fadeIn(frame, fps, { duration: 0.35 }) * (screen ? params.dim : 1);
  const run = progress(frame, fps, { delay: 0.2, duration: Math.max(0.1, durationInFrames / fps - 0.4), ease: 'linear' });
  const line = 240 * unit;
  return (
    <Background theme={theme}>
      {screen ? <div style={{ position: 'absolute', inset: 0 }}>{screen as ReactNode}</div> : null}
      <div style={{ position: 'absolute', inset: 0, background: withAlpha(card, dark ? 1 : 0.96), opacity: veil }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        {slots.kicker ? (
          <div
            style={{
              ...rise(frame, fps, { delay: 0.1, unit }),
              fontFamily: cssFontFamily(theme.fonts.body),
              fontWeight: 600,
              fontSize: 20 * unit,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: dark ? withAlpha(tones.light, 0.7) : readableOn(card, theme.colors.accent, ink, 2.2),
              marginBottom: 16 * unit,
            }}
          >
            {slots.kicker}
          </div>
        ) : null}
        <div style={rise(frame, fps, { delay: 0.2, unit })}>
          <FitText
            text={slots.text ?? ''}
            width={Math.min(width - 320 * unit, 1200 * unit)}
            maxFontSize={64 * unit}
            minFontSize={28 * unit}
            maxLines={2}
            fontFamily={theme.fonts.display}
            color={ink}
            align="center"
          />
        </div>
        <div style={{ position: 'relative', width: line, height: 2 * unit, marginTop: 36 * unit, background: withAlpha(ink, 0.18), borderRadius: unit }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: line * run, background: theme.colors.accent, borderRadius: unit }} />
        </div>
      </div>
    </Background>
  );
}
