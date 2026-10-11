import { useCurrentFrame } from 'remotion';
import { cssFontFamily, darkLight, fadeOut, fitText, measureText, progress, roundTo, safeAreaRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { side: 'left' | 'right'; max_width: number };

/** Kicker + text on a paper panel with an accent bar, bottom corner of the frame; slides in, fades out. */
export default function OverlayLowerThird({ theme, slots, params, unit, width, height, fps, durationInFrames }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { dark, light } = darkLight(theme);
  const safe = safeAreaRect(width, height, 0.05);
  const padX = 28 * unit;
  const padY = 18 * unit;
  const bar = 6 * unit;
  const kicker = slots.kicker ? slots.kicker.toUpperCase() : '';
  const kickerSize = 15 * unit;
  const fit = fitText({ text: slots.text ?? '', width: params.max_width * unit - 2 * padX - bar, maxFontSize: 34 * unit, minFontSize: 20 * unit, maxLines: 2, lineHeight: 1.18, fontFamily: theme.fonts.display });
  const kickerW = kicker ? measureText(kicker, { family: theme.fonts.body, weight: 700, size: kickerSize, letterSpacing: 0.14 }) : 0;
  const w = roundTo(Math.max(fit.width, kickerW) + 2 * padX + bar + 2 * unit);
  const h = roundTo(fit.height + (kicker ? kickerSize * 1.3 + 6 * unit : 0) + 2 * padY);
  const right = params.side === 'right';
  const x = right ? safe.x + safe.w - w : safe.x;
  const y = safe.y + safe.h - h;
  const enter = progress(frame, fps, { duration: 0.45, ease: 'entrance' });
  const opacity = roundTo(Math.min(enter * 1.4, 1) * fadeOut(frame, fps, durationInFrames, { duration: 0.3 }), 4);
  const shift = roundTo((1 - enter) * 40 * unit * (right ? 1 : -1));
  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(x),
        top: roundTo(y),
        width: w,
        height: h,
        opacity,
        transform: `translateX(${shift}px)`,
        borderRadius: 10 * unit,
        overflow: 'hidden',
        background: withAlpha(light, 0.96),
        boxShadow: `0 ${12 * unit}px ${32 * unit}px ${withAlpha(dark, 0.22)}`,
        display: 'flex',
      }}
    >
      <div style={{ width: bar, background: theme.colors.accent, flex: 'none' }} />
      <div style={{ padding: `${padY}px ${padX}px`, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {kicker ? (
          <div style={{ fontFamily: cssFontFamily(theme.fonts.body), fontWeight: 700, fontSize: kickerSize, letterSpacing: '0.14em', color: theme.colors.accent, marginBottom: 6 * unit, whiteSpace: 'nowrap' }}>
            {kicker}
          </div>
        ) : null}
        <div style={{ fontFamily: cssFontFamily(theme.fonts.display), fontSize: fit.fontSize, lineHeight: 1.18, color: dark }}>
          {fit.lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'pre' }}>
              {l}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
