import type { ReactNode } from 'react';
import { useCurrentFrame } from 'remotion';
import { biasMotion, clamp, easing, nightTone, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { duration: number; through: 'black' | 'night'; color?: string };

const easeIn = easing('easeIn');
const easeOut = easing('easeOut');

/**
 * Dip through a colour. Exiting (frames [0, ⌊n/2⌋) at the end of the outgoing segment): the veil eases in 0 → 1;
 * entering ([⌊n/2⌋, n) at the start of the incoming one): it eases out 1 → 0 — fully opaque at the cut. style_bias
 * balanced / motion: the outgoing segment shrinks a touch, the incoming one settles from slightly larger.
 */
export default function TransitionFadeBlack({ theme, params, durationInFrames, direction, screen }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const bias = biasMotion(theme.style_bias);
  const n = Math.max(1, durationInFrames);
  const half = Math.max(1, Math.floor(n / 2));
  const exiting = direction === 'exiting';
  const p = exiting ? clamp((frame + 1) / half) : clamp((frame - half + 1) / (n - half + 1));
  const veil = exiting ? easeIn(p) : 1 - easeOut(p);
  const color = params.color ?? (params.through === 'night' ? nightTone(theme) : 'black');
  const breath = bias.settle * 0.4;
  const s = breath > 0 ? roundTo(exiting ? 1 - breath * p : 1 + breath * (1 - p), 5) : 1;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, transform: s !== 1 ? `scale(${s})` : undefined }}>{(screen as ReactNode) ?? null}</div>
      <div style={{ position: 'absolute', inset: 0, background: color, opacity: roundTo(veil, 4) }} />
    </div>
  );
}
