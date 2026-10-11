import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { clamp, easing } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { through: 'none' | 'paper' | 'text' | 'accent' };

const ease = easing('easeInOut');

/** Crossfade (entering fades in on top), or a dip: exiting fades to the colour, entering fades from it. */
export default function Transition({ theme, params, durationInFrames, direction, screen }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const p = clamp(frame / Math.max(1, durationInFrames));
  const content = (screen as ReactNode) ?? null;
  const entering = direction !== 'exiting';
  if (params.through === 'none') {
    return <div style={{ position: 'absolute', inset: 0, opacity: entering ? ease(p) : 1 }}>{content}</div>;
  }
  const color = theme.colors[params.through];
  // A dip does not overlap: the exiting render covers frames [0, ⌊n/2⌋) (veil 0 → 1, opaque on its last frame), the
  // entering one [⌊n/2⌋, n) (veil 1 → 0).
  const n = Math.max(1, durationInFrames);
  const half = Math.max(1, Math.floor(n / 2));
  const veil = entering ? clamp(1 - (frame - half + 1) / (n - half + 1)) : clamp((frame + 1) / half);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {content}
      <div style={{ position: 'absolute', inset: 0, background: color, opacity: ease(veil) }} />
    </div>
  );
}
