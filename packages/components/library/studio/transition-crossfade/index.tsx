import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { biasMotion, clamp, easing, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

const ease = easing('easeInOut');

/**
 * Crossfade (docs/reference/look.md: 0.35 s between scenes). The composition renders this component twice over the
 * overlap: around the outgoing segment ('exiting', holding its last frame) and around the incoming one ('entering',
 * drawn on top). Segments are opaque, so fading the entering one in over the exiting one IS the crossfade; progress
 * (f + 1) / (n + 1) keeps every frame of the overlap a true mix (never fully old, never fully new).
 * style_bias balanced / motion: the entering segment also settles from a 1–2 % larger scale and the exiting one eases
 * back by half as much — a hint of depth, no slide, no blur.
 */
export default function TransitionCrossfade({ theme, durationInFrames, direction, screen }: ComponentProps<{ duration: number }>) {
  const frame = useCurrentFrame();
  const bias = biasMotion(theme.style_bias);
  const p = ease(clamp((frame + 1) / Math.max(1, durationInFrames + 1)));
  const zoom = bias.settle * 0.5;
  if (direction === 'exiting') {
    const s = zoom > 0 ? roundTo(1 - zoom * 0.5 * p, 5) : 1;
    return <div style={{ position: 'absolute', inset: 0, opacity: 1, transform: s !== 1 ? `scale(${s})` : undefined }}>{(screen as ReactNode) ?? null}</div>;
  }
  const s = zoom > 0 ? roundTo(1 + zoom * (1 - p), 5) : 1;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: roundTo(p, 4), transform: s !== 1 ? `scale(${s})` : undefined }}>
      {(screen as ReactNode) ?? null}
    </div>
  );
}
