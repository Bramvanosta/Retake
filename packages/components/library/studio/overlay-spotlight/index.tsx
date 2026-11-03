import { useId } from 'react';
import { useCurrentFrame } from 'remotion';
import { SYSTEM_COLORS, biasMotion, clamp, fadeOut, nightTone, progress, roundTo, withAlpha } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

type Params = { dim: number; padding: number; radius: number; feather: number; ring: boolean; area: 'screen' | 'frame' };

/**
 * Dim everything but the target (`anchor`, output px — it moves when the planner's track glides to the next target):
 * an SVG mask with a blurred rounded cut-out over the capture rect (or the whole frame), in the theme's night tone.
 */
export default function OverlaySpotlight({ theme, params, unit, width, height, fps, durationInFrames, anchor, rects }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  if (!anchor || anchor.w <= 0 || anchor.h <= 0) return null;
  const night = nightTone(theme);
  // style_bias: the livelier biases ease the dim in and out a little more slowly.
  const pace = biasMotion(theme.style_bias).pace;
  const fadeInP = progress(frame, fps, { duration: 0.3 * pace, ease: 'standard' });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.3 * pace });
  const alpha = roundTo(clamp(params.dim) * fadeInP * out, 4);
  if (alpha <= 0) return null;
  const pad = params.padding * unit;
  const hole = { x: anchor.x - pad, y: anchor.y - pad, w: anchor.w + 2 * pad, h: anchor.h + 2 * pad };
  const r = Math.min(params.radius * unit, hole.h / 2, hole.w / 2);
  const feather = params.feather * unit;
  const screen = rects?.screen;
  const area = params.area === 'screen' && screen ? screen : { x: 0, y: 0, w: width, h: height };
  const areaR = params.area === 'screen' && screen ? (rects?.chrome ? 0 : (rects?.radius ?? 0)) : 0;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <defs>
        <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={roundTo(feather / 2, 2)} />
        </filter>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          <rect x={area.x} y={area.y} width={area.w} height={area.h} rx={areaR} fill={SYSTEM_COLORS.white} />
          <rect x={roundTo(hole.x, 2)} y={roundTo(hole.y, 2)} width={roundTo(hole.w, 2)} height={roundTo(hole.h, 2)} rx={roundTo(r, 2)} fill={SYSTEM_COLORS.black} filter={feather > 0 ? `url(#${id}-soft)` : undefined} />
        </mask>
      </defs>
      <rect x={0} y={0} width={width} height={height} fill={night} opacity={alpha} mask={`url(#${id}-mask)`} />
      {params.ring ? (
        <rect
          x={roundTo(hole.x, 2)}
          y={roundTo(hole.y, 2)}
          width={roundTo(hole.w, 2)}
          height={roundTo(hole.h, 2)}
          rx={roundTo(r, 2)}
          fill="none"
          stroke={withAlpha(theme.colors.accent, 0.9)}
          strokeWidth={roundTo(2 * unit, 2)}
          opacity={roundTo(fadeInP * out, 4)}
        />
      ) : null}
    </svg>
  );
}
