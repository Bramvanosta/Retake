import {
  CapText,
  biasMotion,
  capTextLayout,
  clamp,
  darkLight,
  fadeOut,
  liftToContrast,
  nightTone,
  progress,
  readableOn,
  roundTo,
  safeAreaRect,
  useCurrentFrame,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { placement: 'auto' | 'above' | 'below'; max_width: number; highlight: boolean };

type Box = { x: number; y: number; w: number; h: number };

/** Design px. */
const PAD_X = 20;
const PAD_Y = 13;
const GAP = 16;
const ARROW = 9;
const RING_PAD = 6;
const KICKER_GAP = 12;

/**
 * Where the pill goes: centred on the anchor horizontally, above it (below when there is no room above, or when asked),
 * clamped inside `bounds`; the pointer tip stays on the anchor side. Exported for the tests.
 */
export function placeCallout(opts: { anchor?: Box; w: number; h: number; bounds: Box; gap: number; arrow: number; placement: Params['placement'] }): { x: number; y: number; below: boolean; pointer?: number } {
  const { anchor, w, h, bounds: b, gap, arrow, placement } = opts;
  const maxX = b.x + b.w - w;
  const maxY = b.y + b.h - h;
  if (!anchor) return { x: b.x, y: maxY, below: false };
  const cx = clamp(anchor.x + anchor.w / 2, b.x, b.x + b.w);
  const roomAbove = anchor.y - gap - arrow - h >= b.y;
  const roomBelow = anchor.y + anchor.h + gap + arrow + h <= b.y + b.h;
  const below = placement === 'below' ? true : placement === 'above' ? false : !roomAbove && roomBelow;
  const x = clamp(cx - w / 2, b.x, Math.max(b.x, maxX));
  const y = below ? clamp(anchor.y + anchor.h + gap + arrow, b.y, Math.max(b.y, maxY)) : clamp(anchor.y - gap - arrow - h, b.y, Math.max(b.y, maxY));
  const pointer = clamp(cx - x, h / 2, w - h / 2);
  return { x, y, below, pointer };
}

/**
 * A ring around the target (`anchor`, output px) and a callout pill pointing at it. The pill stays inside the capture
 * (`rects.screen`) when it fits there, else inside the frame's safe area. Motion: the ring draws in (0–0.3 s), the pill
 * pops from its pointer (0.12–0.47 s, scale 0.94 → 1), everything fades out over the last 0.3 s. style_bias balanced
 * / motion: a little more pop.
 */
export default function OverlayCallout({ theme, slots, params, unit, width, height, fps, durationInFrames, anchor, rects }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const night = nightTone(theme);
  const { light } = darkLight(theme);
  const ink = readableOn(night, light, theme.colors.paper, 4.5);
  const accent = liftToContrast(night, theme.colors.accent, ink, 3.5);
  const ringColor = theme.colors.accent;
  const padX = PAD_X * u;
  const padY = PAD_Y * u;
  const kicker = slots.kicker
    ? capTextLayout({ text: slots.kicker, width: 300 * u, maxFontSize: 13 * u, minFontSize: 10 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 700, letterSpacing: 0.14, uppercase: true })
    : null;
  const kickerW = kicker ? kicker.width + KICKER_GAP * u : 0;
  const text = capTextLayout({
    text: slots.text ?? '',
    width: Math.max(80 * u, params.max_width * u - 2 * padX - kickerW),
    maxFontSize: 22 * u,
    minFontSize: 15 * u,
    maxLines: 1,
    lineHeight: 1.2,
    fontFamily: theme.fonts.body,
    fontWeight: 600,
  });
  const capH = Math.max(text.capHeight, kicker?.capHeight ?? 0);
  const h = roundTo(capH + 2 * padY + 12 * u, 2);
  const w = roundTo(text.width + kickerW + 2 * padX, 2);
  const safe = safeAreaRect(width, height, 0.03);
  const inset = 16 * u;
  const screen = rects?.screen;
  const fitsScreen = screen && screen.w - 2 * inset >= w && screen.h - 2 * inset >= h * 3;
  const bounds: Box = fitsScreen ? { x: screen.x + inset, y: screen.y + inset, w: screen.w - 2 * inset, h: screen.h - 2 * inset } : safe;
  const place = placeCallout({ anchor, w, h, bounds, gap: GAP * u, arrow: ARROW * u, placement: params.placement });

  const ring = progress(frame, fps, { duration: 0.3, ease: 'entrance' });
  const pop = progress(frame, fps, { delay: 0.12, duration: 0.35 * bias.pace, ease: 'entrance' });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.3 });
  const scale = roundTo(1 - (0.06 + 0.02 * (bias.travel - 1)) * (1 - pop), 4);
  const arrow = ARROW * u;
  const midY = place.y + h / 2;
  const textCapTop = midY - capH / 2;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: roundTo(out, 4) }}>
      {anchor && params.highlight && anchor.w > 0 && anchor.h > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(anchor.x - RING_PAD * u, 2),
            top: roundTo(anchor.y - RING_PAD * u, 2),
            width: roundTo(anchor.w + 2 * RING_PAD * u, 2),
            height: roundTo(anchor.h + 2 * RING_PAD * u, 2),
            borderRadius: Math.min(14 * u, (anchor.h + 2 * RING_PAD * u) / 2),
            boxShadow: `0 0 0 ${roundTo(2.5 * u, 2)}px ${ringColor}, 0 0 ${18 * u}px ${withAlpha(ringColor, 0.35)}`,
            opacity: roundTo(ring, 4),
            transform: `scale(${roundTo(1.06 - 0.06 * ring, 4)})`,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: roundTo(place.x, 2),
          top: roundTo(place.y, 2),
          width: w,
          height: h,
          opacity: roundTo(clamp(pop * 1.4), 4),
          transform: `scale(${scale})`,
          transformOrigin: place.pointer !== undefined ? `${roundTo(place.pointer, 2)}px ${place.below ? 0 : h}px` : 'left bottom',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: h / 2,
            background: night,
            boxShadow: `0 ${8 * u}px ${24 * u}px ${withAlpha(night, 0.28)}, inset 0 0 0 ${Math.max(1, u)}px ${withAlpha(ink, 0.08)}`,
          }}
        />
        {place.pointer !== undefined ? (
          <svg
            width={arrow * 2}
            height={arrow + 1}
            viewBox={`0 0 ${arrow * 2} ${arrow + 1}`}
            style={{ position: 'absolute', left: roundTo(place.pointer - arrow, 2), top: place.below ? -arrow : h - 0.5, overflow: 'visible' }}
          >
            <path d={place.below ? `M0 ${arrow + 1} L${arrow} 0 L${arrow * 2} ${arrow + 1} Z` : `M0 0 L${arrow} ${arrow} L${arrow * 2} 0 Z`} fill={night} />
          </svg>
        ) : null}
        {kicker ? <CapText layout={kicker} x={padX} capTop={textCapTop - place.y + (capH - kicker.capHeight) / 2} color={accent} /> : null}
        <CapText layout={text} x={padX + kickerW} capTop={textCapTop - place.y + (capH - text.capHeight) / 2} color={ink} />
      </div>
    </div>
  );
}
