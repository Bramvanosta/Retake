import type { ReactNode } from 'react';
import { Background } from '@retake/components/kit';
import type { ComponentProps, LayoutRects } from '@retake/components/kit';

/** The default rects (design px × unit) — only outside a plan (unit tests); mirrors component.yaml. */
export function defaultRects(variant: 'landscape' | 'vertical' | 'square', unit: number): LayoutRects {
  const s = (v: number) => v * unit;
  if (variant === 'square') return { screen: { x: 0, y: 0, w: s(1080), h: s(1080) }, frame: { x: 0, y: 0, w: s(1080), h: s(1080) }, caption: { x: s(60), y: s(820), w: s(960), h: s(200) }, radius: 0 };
  if (variant === 'vertical') return { screen: { x: 0, y: 0, w: s(1080), h: s(1920) }, frame: { x: 0, y: 0, w: s(1080), h: s(1920) }, caption: { x: s(60), y: s(1560), w: s(960), h: s(220) }, radius: 0 };
  return { screen: { x: 0, y: 0, w: s(1920), h: s(1080) }, frame: { x: 0, y: 0, w: s(1920), h: s(1080) }, caption: { x: s(260), y: s(890), w: s(1400), h: s(150) }, radius: 0 };
}

/**
 * The capture edge to edge at the planner's screen rect (the capture fitted to its own aspect): the theme background
 * shows only where a capture of another aspect leaves room (letterbox / pillarbox). The caption component draws over
 * the bottom of the capture (the layout's caption rect).
 */
export default function LayoutRaw({ theme, unit, variant, screen, rects }: ComponentProps) {
  const r = rects ?? defaultRects(variant, unit);
  const s = r.screen;
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', left: s.x, top: s.y, width: s.w, height: s.h, overflow: 'hidden' }}>{screen ? (screen as ReactNode) : null}</div>
    </Background>
  );
}
