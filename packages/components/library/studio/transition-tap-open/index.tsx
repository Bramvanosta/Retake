import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { biasMotion, clamp, darkLight, easing, lerp, nightTone, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { duration: number; radius: number; touch: boolean; kind: 'crossfade' };

const zoomEase = easing([0.32, 0, 0.12, 1]);
const pressEase = easing('easeInOut');

/** Share of the transition spent on the tap before the zoom starts. */
export const TAP_SHARE = 0.22;

/**
 * Tap, then zoom out of the tap target. Exiting render (the outgoing segment, holding its last frame): a touch ring
 * appears on the target, presses, and the segment dims a little as the new one grows. Entering render (on top): the
 * incoming segment drawn inside a rounded box that grows from the anchor to the full frame, its content scaled to
 * cover the box (so it reads as the app opening from its notification), fading in over the first frames of the zoom.
 */
export default function TransitionTapOpen({ theme, params, durationInFrames, direction, screen, width, height, unit, anchor }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const bias = biasMotion(theme.style_bias);
  const n = Math.max(1, durationInFrames);
  const p = clamp((frame + 1) / (n + 1));
  const a = anchor && anchor.w > 0 && anchor.h > 0 ? anchor : { x: width * 0.41, y: height * 0.41, w: width * 0.18, h: height * 0.18 };
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const z = zoomEase(clamp((p - TAP_SHARE) / (1 - TAP_SHARE)));
  const { light } = darkLight(theme);
  const night = nightTone(theme);
  if (direction === 'exiting') {
    const tap = clamp(p / TAP_SHARE);
    const press = pressEase(tap);
    const ring = 26 * unit * (0.6 + 0.6 * press);
    const ringOpacity = params.touch ? roundTo(Math.min(1, tap * 2) * (1 - z), 4) : 0;
    return (
      <div style={{ position: 'absolute', inset: 0 }}>
        <div style={{ position: 'absolute', inset: 0, transformOrigin: `${roundTo(cx, 2)}px ${roundTo(cy, 2)}px`, transform: `scale(${roundTo(1 + 0.03 * z * bias.travel, 5)})` }}>{(screen as ReactNode) ?? null}</div>
        <div style={{ position: 'absolute', inset: 0, background: night, opacity: roundTo(0.28 * z, 4) }} />
        {ringOpacity > 0 ? (
          <div
            style={{
              position: 'absolute',
              left: roundTo(cx - ring, 2),
              top: roundTo(cy - ring, 2),
              width: roundTo(2 * ring, 2),
              height: roundTo(2 * ring, 2),
              borderRadius: '50%',
              background: withAlpha(light, 0.35),
              boxShadow: `0 0 0 ${roundTo(2 * unit, 2)}px ${withAlpha(light, 0.85)}, 0 ${4 * unit}px ${16 * unit}px ${withAlpha(night, 0.3)}`,
              opacity: ringOpacity,
            }}
          />
        ) : null}
      </div>
    );
  }
  if (p < TAP_SHARE) return null;
  const x = lerp(a.x, 0, z);
  const y = lerp(a.y, 0, z);
  const w = lerp(a.w, width, z);
  const h = lerp(a.h, height, z);
  const s = Math.max(w / width, h / height);
  const r = lerp(params.radius * unit, 0, z);
  const fade = clamp((p - TAP_SHARE) / 0.18);
  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(x, 2),
        top: roundTo(y, 2),
        width: roundTo(w, 2),
        height: roundTo(h, 2),
        borderRadius: roundTo(r, 2),
        overflow: 'hidden',
        opacity: roundTo(fade, 4),
        boxShadow: `0 ${20 * unit}px ${60 * unit}px ${withAlpha(night, 0.3 * (1 - z))}`,
      }}
    >
      <div style={{ position: 'absolute', left: roundTo((w - width * s) / 2, 2), top: roundTo((h - height * s) / 2, 2), width, height, transform: `scale(${roundTo(s, 5)})`, transformOrigin: '0 0' }}>
        {(screen as ReactNode) ?? null}
      </div>
    </div>
  );
}
