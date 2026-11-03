import { useCurrentFrame } from 'remotion';
import { CapText, biasMotion, capTextLayout, darkLight, fadeOut, nightTone, progress, readableOn, roundTo, safeAreaRect, withAlpha } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { side: 'left' | 'right'; max_width: number };

/** Design px. */
const PAD_X = 26;
const PAD_Y = 20;
const BAR = 5;
const KICKER_GAP = 14;
const INSET = 36;

/**
 * Kicker + text on a paper panel with an accent bar, at the bottom corner of the capture (`rects.screen`, 36 px in) —
 * of the frame's safe area outside a clip. Slides in from its side (0.45 s), the text rising a moment later; fades out
 * over the last 0.3 s. style_bias balanced / motion: a longer slide.
 */
export default function OverlayLowerThird({ theme, slots, params, unit, width, height, fps, durationInFrames, rects }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const { dark, light } = darkLight(theme);
  const panel = light;
  const ink = readableOn(panel, theme.colors.text, dark, 4.5);
  const accent = readableOn(panel, theme.colors.accent, ink, 2.6);
  const screen = rects?.screen;
  const area = screen && screen.w > 600 * u ? { x: screen.x + INSET * u, y: screen.y + INSET * u, w: screen.w - 2 * INSET * u, h: screen.h - 2 * INSET * u } : safeAreaRect(width, height, 0.05);
  const maxW = Math.min(params.max_width * u, area.w);
  const padX = PAD_X * u;
  const padY = PAD_Y * u;
  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: maxW - 2 * padX - BAR * u, maxFontSize: 14 * u, minFontSize: 10 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 700, letterSpacing: 0.14, uppercase: true })
    : null;
  const text = capTextLayout({ text: slots.text ?? '', width: maxW - 2 * padX - BAR * u, maxFontSize: 36 * u, minFontSize: 22 * u, maxLines: 2, lineHeight: 1.16, fontFamily: theme.fonts.display });
  const kickerBand = kicker ? kicker.capHeight + KICKER_GAP * u : 0;
  const contentH = kickerBand + text.band + text.fontSize * 0.2;
  const w = roundTo(Math.max(text.width, kicker?.width ?? 0) + 2 * padX + BAR * u, 2);
  const h = roundTo(contentH + 2 * padY, 2);
  const right = params.side === 'right';
  const x = right ? area.x + area.w - w : area.x;
  const y = area.y + area.h - h;
  const enter = progress(frame, fps, { duration: 0.45 * bias.pace, ease: 'entrance' });
  const textIn = progress(frame, fps, { delay: 0.1, duration: 0.4 * bias.pace, ease: 'entrance' });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.3 });
  const shift = roundTo((1 - enter) * 36 * bias.travel * u * (right ? 1 : -1), 2);
  const left = BAR * u + padX;

  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(x, 2),
        top: roundTo(y, 2),
        width: w,
        height: h,
        opacity: roundTo(Math.min(1, enter * 1.4) * out, 4),
        transform: `translateX(${shift}px)`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 12 * u,
          overflow: 'hidden',
          background: withAlpha(panel, 0.97),
          boxShadow: `0 ${14 * u}px ${36 * u}px ${withAlpha(nightTone(theme), 0.22)}, 0 ${2 * u}px ${6 * u}px ${withAlpha(nightTone(theme), 0.08)}`,
        }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: BAR * u, background: accent }} />
      </div>
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(textIn, 4), transform: `translateY(${roundTo((1 - textIn) * 6 * u, 2)}px)` }}>
        {kicker ? <CapText layout={kicker} x={left} capTop={padY} color={accent} /> : null}
        <CapText layout={text} x={left} capTop={padY + kickerBand} color={ink} />
      </div>
    </div>
  );
}
