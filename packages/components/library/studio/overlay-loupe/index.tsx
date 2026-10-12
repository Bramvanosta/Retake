import { useCurrentFrame } from 'remotion';
import type { ReactNode } from 'react';
import { biasMotion, clamp, darkLight, fadeOut, loupeLens, progress, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, LoupePlacement } from '@demo-studio/components/kit';

type Params = { zoom: number; max_width: number; placement: LoupePlacement; ring: boolean };

/**
 * A lens beside the field: `screen` (the capture region `region`, live) in a rounded box of the region's aspect,
 * magnified `zoom` × the capture's on-screen scale (`anchor.w / region.w`), at least LOUPE_MIN_SCALE × unit, at most
 * `max_width` and the capture's width; pointer toward the field, ring on it.
 */
export default function OverlayLoupe({ theme, params, unit, width, height, fps, durationInFrames, anchor, rects, region, screen, variant, avoid }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  if (!anchor || !region || region.w <= 0 || region.h <= 0 || anchor.w <= 0) return null;
  const u = unit;
  const bias = biasMotion(theme.style_bias);
  const { dark, light } = darkLight(theme);
  // Geometry shared with the composition (kit loupeLens): the lens box beside the field, clear of `avoid`.
  const lens = loupeLens({ anchor, region, ...(rects?.screen ? { screen: rects.screen } : {}), width, height, unit, variant, zoom: params.zoom, maxWidth: params.max_width, placement: params.placement, ...(avoid ? { avoid } : {}) });
  const { w, h, border } = lens;
  const place = lens.box;
  const open = progress(frame, fps, { duration: 0.28 * bias.pace, ease: 'entrance' });
  const out = fadeOut(frame, fps, durationInFrames, { duration: 0.3 });
  const radius = Math.min(16 * u, (h + 2 * border) / 3);
  const below = place.side.startsWith('below');
  const above = place.side.startsWith('above');
  const cx = clamp(anchor.x + Math.min(anchor.w, 200 * u) / 2, place.x + radius + 12 * u, place.x + place.w - radius - 12 * u);
  const arrow = 12 * u;
  const ringColor = theme.colors.accent;
  const origin = below ? `${roundTo(cx - place.x, 2)}px 0px` : above ? `${roundTo(cx - place.x, 2)}px 100%` : 'center';
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: roundTo(out * clamp(open * 1.4), 4) }}>
      {params.ring ? (
        <div
          style={{
            position: 'absolute',
            left: roundTo(anchor.x, 2),
            top: roundTo(anchor.y, 2),
            width: roundTo(anchor.w, 2),
            height: roundTo(anchor.h, 2),
            borderRadius: Math.min(12 * u, anchor.h / 2),
            boxShadow: `0 0 0 ${roundTo(2 * u, 2)}px ${withAlpha(ringColor, 0.9)}`,
          }}
        />
      ) : null}
      <div style={{ position: 'absolute', left: roundTo(place.x, 2), top: roundTo(place.y, 2), width: roundTo(place.w, 2), height: roundTo(place.h, 2), transform: `scale(${roundTo(0.9 + 0.1 * open, 4)})`, transformOrigin: origin }}>
        {below || above ? (
          <svg width={arrow * 2} height={arrow + 2} viewBox={`0 0 ${arrow * 2} ${arrow + 2}`} style={{ position: 'absolute', left: roundTo(cx - place.x - arrow, 2), top: below ? -arrow : place.h - 1, overflow: 'visible' }}>
            <path d={below ? `M0 ${arrow + 2} L${arrow} 0 L${arrow * 2} ${arrow + 2} Z` : `M0 0 L${arrow} ${arrow} L${arrow * 2} 0 Z`} fill={light} />
          </svg>
        ) : null}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: radius,
            background: light,
            boxShadow: `0 ${12 * u}px ${36 * u}px ${withAlpha(dark, 0.3)}, 0 0 0 ${Math.max(1, u)}px ${withAlpha(dark, 0.12)}`,
          }}
        />
        <div style={{ position: 'absolute', left: border, top: border, width: w, height: h, borderRadius: Math.max(0, radius - border), overflow: 'hidden', background: light }}>
          {screen as ReactNode}
        </div>
      </div>
    </div>
  );
}
