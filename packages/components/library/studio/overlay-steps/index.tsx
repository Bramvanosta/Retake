import { useCurrentFrame } from 'remotion';
import { CapText, biasMotion, capTextLayout, clamp, darkLight, fadeOut, nightTone, placeBeside, progress, readableOn, roundTo, safeAreaRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, Side } from '@demo-studio/components/kit';

type Params = { size: number; placement: 'auto' | 'left' | 'right' | 'above' | 'below'; tone: 'accent' | 'dark'; numbering: 'scene' | 'video'; pulse: boolean };

const ORDER: Record<Params['placement'], Side[]> = {
  auto: ['left', 'above-left', 'above', 'right', 'below-left', 'below', 'above-right', 'below-right'],
  left: ['left', 'above-left', 'below-left', 'right'],
  right: ['right', 'above-right', 'below-right', 'left'],
  above: ['above', 'above-left', 'above-right', 'below'],
  below: ['below', 'below-left', 'below-right', 'above'],
};

/**
 * A numbered badge beside the clicked target (`anchor`, output px), placed by the kit's `placeBeside` inside the
 * capture so it never covers the target; pops in with a slight overshoot as the overlay starts (the cursor reaching the
 * target), a ring pulses on the target at the click (`moment`), and it fades out over the last 0.3 s.
 */
export default function OverlaySteps({ theme, slots, params, unit, width, height, fps, durationInFrames, anchor, rects, moment, variant, avoid }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit * (variant === 'landscape' ? 1 : 1.1);
  const bias = biasMotion(theme.style_bias);
  const d = params.size * u;
  const fill = params.tone === 'dark' ? nightTone(theme) : theme.colors.accent;
  const { dark, light } = darkLight(theme);
  const ink = readableOn(fill, light, readableOn(fill, theme.colors.paper, dark, 3), 3);
  const inset = 10 * u;
  const screen = rects?.screen;
  const bounds = screen ? { x: screen.x + inset, y: screen.y + inset, w: screen.w - 2 * inset, h: screen.h - 2 * inset } : safeAreaRect(width, height, 0.03);
  const target = anchor && anchor.w > 0 ? anchor : anchor ? { x: anchor.x - 1, y: anchor.y - 1, w: 2, h: 2 } : { x: bounds.x + d, y: bounds.y + d, w: 1, h: 1 };
  const place = placeBeside({ target, w: d, h: d, bounds, gap: 10 * u, order: ORDER[params.placement], ...(avoid ? { avoid } : {}) });
  // The badge pops as the overlay starts (the cursor reaching the target); the ring pulses at the click (`moment`).
  const at = (moment ?? 0) / fps;
  const pop = progress(frame, fps, { duration: 0.32 * bias.pace, ease: [0.34, 1.56, 0.64, 1] });
  const show = progress(frame, fps, { duration: 0.12 });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.3 });
  const pulse = progress(frame, fps, { delay: at, duration: 0.6, ease: 'easeOut' });
  const label = capTextLayout({ text: slots.number ?? '', width: d * 0.9, maxFontSize: d * 0.5, minFontSize: d * 0.28, maxLines: 1, lineHeight: 1.1, fontFamily: theme.fonts.body, fontWeight: 700 });
  const ringPad = 6 * u + pulse * 10 * u;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: roundTo(out, 4) }}>
      {params.pulse && anchor && anchor.w > 0 && pulse > 0 && pulse < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(anchor.x - ringPad, 2),
            top: roundTo(anchor.y - ringPad, 2),
            width: roundTo(anchor.w + 2 * ringPad, 2),
            height: roundTo(anchor.h + 2 * ringPad, 2),
            borderRadius: Math.min(16 * u, (anchor.h + 2 * ringPad) / 2),
            boxShadow: `0 0 0 ${roundTo(2.5 * u, 2)}px ${withAlpha(fill, roundTo(0.85 * (1 - pulse), 3))}`,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: roundTo(place.x, 2),
          top: roundTo(place.y, 2),
          width: roundTo(d, 2),
          height: roundTo(d, 2),
          borderRadius: d / 2,
          background: fill,
          opacity: roundTo(clamp(show), 4),
          transform: `scale(${roundTo(0.55 + 0.45 * pop, 4)})`,
          boxShadow: `0 0 0 ${roundTo(2.5 * u, 2)}px ${withAlpha(light, 0.95)}, 0 ${6 * u}px ${16 * u}px ${withAlpha(dark, 0.3)}`,
        }}
      >
        <CapText layout={label} x={d / 2} capTop={(d - label.capHeight) / 2} align="center" color={ink} />
      </div>
    </div>
  );
}
