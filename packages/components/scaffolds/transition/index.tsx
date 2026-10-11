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
  // Exiting: veil 0 → 1 over the first half. Entering: hidden first half, then veil 1 → 0.
  const veil = entering ? clamp(2 - 2 * p) : clamp(2 * p);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: entering && p < 0.5 ? 0 : 1 }}>
      {content}
      <div style={{ position: 'absolute', inset: 0, background: color, opacity: ease(veil) }} />
    </div>
  );
}
