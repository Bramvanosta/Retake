import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { clamp, easing, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

const ease = easing('easeInOut');

/** Dip through a colour: exiting = first half (veil 0 → 1), entering = second half (veil 1 → 0). */
export default function TransitionFadeBlack({ params, durationInFrames, direction, screen }: ComponentProps<{ duration: number; color: string }>) {
  const frame = useCurrentFrame();
  const n = Math.max(1, durationInFrames);
  const half = Math.max(1, Math.floor(n / 2));
  // Frames [0, ⌊n/2⌋) belong to the outgoing segment, [⌊n/2⌋, n) to the incoming one; fully opaque at the cut.
  const veil = direction === 'exiting' ? clamp((frame + 1) / half) : clamp(1 - (frame - half + 1) / (n - half + 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {(screen as ReactNode) ?? null}
      <div style={{ position: 'absolute', inset: 0, background: params.color, opacity: roundTo(ease(veil), 4) }} />
    </div>
  );
}
