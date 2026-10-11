import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { clamp, easing, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

const ease = easing('gentle');

/** Crossfade: the entering segment fades in on top; the exiting one stays fully visible underneath. */
export default function TransitionCrossfade({ durationInFrames, direction, screen }: ComponentProps<{ duration: number }>) {
  const frame = useCurrentFrame();
  const p = clamp((frame + 1) / Math.max(1, durationInFrames + 1));
  const opacity = direction === 'exiting' ? 1 : roundTo(ease(p), 4);
  return <div style={{ position: 'absolute', inset: 0, opacity }}>{(screen as ReactNode) ?? null}</div>;
}
