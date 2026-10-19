import { clamp, cssFontFamily, darkLight, fadeOut, fitText, measureText, progress, readableOn, roundTo, safeAreaRect, useCurrentFrame, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { placement: 'auto' | 'above' | 'below'; max_width: number };

/** A callout pill next to `anchor` (output px) with a pointer, or a lower third without an anchor. */
export default function Overlay({ theme, slots, params, unit, width, height, fps, durationInFrames, anchor }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const tones = darkLight(theme);
  const font = 26 * unit;
  const padX = 22 * unit;
  const padY = 14 * unit;
  const kicker = slots.kicker ? slots.kicker.toUpperCase() : '';
  const kickerWidth = kicker ? measureText(kicker, { family: theme.fonts.body, weight: 700, size: 16 * unit, letterSpacing: 0.12 }) + 14 * unit : 0;
  const fit = fitText({
    text: slots.text ?? '',
    width: params.max_width * unit - 2 * padX - kickerWidth,
    maxFontSize: font,
    minFontSize: 16 * unit,
    fontFamily: theme.fonts.body,
    fontWeight: 600,
  });
  const w = roundTo(fit.width + kickerWidth + 2 * padX);
  const h = roundTo(fit.fontSize * 1.15 + 2 * padY);
  const safe = safeAreaRect(width, height, 0.035);
  const gap = 18 * unit;
  let x: number;
  let y: number;
  let below = false;
  if (anchor) {
    const room = anchor.y - safe.y;
    below = params.placement === 'below' || (params.placement === 'auto' && room < h + gap);
    x = clamp(anchor.x + anchor.w / 2 - w / 2, safe.x, safe.x + safe.w - w);
    y = below ? Math.min(anchor.y + anchor.h + gap, safe.y + safe.h - h) : Math.max(anchor.y - gap - h, safe.y);
  } else {
    x = safe.x;
    y = safe.y + safe.h - h - 40 * unit;
  }
  const pop = progress(frame, fps, { duration: 0.35, ease: 'entrance' });
  const opacity = roundTo(clamp(pop * 1.5) * fadeOut(frame, fps, durationInFrames, { duration: 0.3 }), 4);
  const pointerX = anchor ? clamp(anchor.x + anchor.w / 2 - x, 18 * unit, w - 18 * unit) : 0;
  const arrow = 9 * unit;
  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(x),
        top: roundTo(y),
        width: w,
        height: h,
        opacity,
        transform: `scale(${roundTo(0.92 + 0.08 * pop, 4)})`,
        transformOrigin: anchor ? `${pointerX}px ${below ? 0 : h}px` : 'left bottom',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: h / 2,
          background: tones.dark,
          boxShadow: `0 ${8 * unit}px ${24 * unit}px ${withAlpha(tones.dark, 0.25)}`,
          display: 'flex',
          alignItems: 'center',
          padding: `0 ${padX}px`,
          whiteSpace: 'nowrap',
          fontFamily: cssFontFamily(theme.fonts.body),
        }}
      >
        {kicker ? (
          <span style={{ fontSize: 16 * unit, fontWeight: 700, letterSpacing: '0.12em', color: readableOn(tones.dark, theme.colors.accent, withAlpha(tones.light, 0.7)), marginRight: 14 * unit }}>
            {kicker}
          </span>
        ) : null}
        <span style={{ fontSize: fit.fontSize, fontWeight: 600, color: tones.light }}>{fit.lines.join(' ')}</span>
      </div>
      {anchor ? (
        <div
          style={{
            position: 'absolute',
            left: pointerX - arrow,
            top: below ? -arrow + 1 : h - 1,
            width: 0,
            height: 0,
            borderLeft: `${arrow}px solid transparent`,
            borderRight: `${arrow}px solid transparent`,
            ...(below ? { borderBottom: `${arrow}px solid ${tones.dark}` } : { borderTop: `${arrow}px solid ${tones.dark}` }),
          }}
        />
      ) : null}
    </div>
  );
}
