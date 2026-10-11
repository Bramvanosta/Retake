import type { ReactNode } from 'react';
import { Background, darkLight, scaleRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { body: 'dark' | 'light' };

/** Same rects as `geometry` / `geometry_vertical` in component.yaml (design px). */
const GEOMETRY = {
  landscape: { body: { x: 744, y: 40, w: 432, h: 894 }, screen: { x: 762, y: 58, w: 396, h: 858 }, radius: 64, screenRadius: 48 },
  vertical: { body: { x: 246, y: 206, w: 588, h: 1218 }, screen: { x: 270, y: 230, w: 540, h: 1170 }, radius: 76, screenRadius: 56 },
};

/** The capture on a phone screen: rounded body, screen inset, a speaker slit in the top bezel. */
export default function LayoutPhone({ theme, params, unit, variant, screen }: ComponentProps<Params>) {
  const g = GEOMETRY[variant === 'vertical' ? 'vertical' : 'landscape'];
  const b = scaleRect(g.body, unit);
  const s = scaleRect(g.screen, unit);
  const { dark, light } = darkLight(theme);
  const body = params.body === 'light' ? `color-mix(in srgb, ${dark} 10%, ${light})` : `color-mix(in srgb, ${dark} 92%, black)`;
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: b.x,
          top: b.y,
          width: b.w,
          height: b.h,
          borderRadius: g.radius * unit,
          background: body,
          boxShadow: `0 ${24 * unit}px ${60 * unit}px ${withAlpha(dark, 0.22)}, inset 0 0 0 ${2 * unit}px ${withAlpha(light, 0.08)}`,
        }}
      />
      <div style={{ position: 'absolute', left: s.x, top: s.y, width: s.w, height: s.h, overflow: 'hidden', borderRadius: g.screenRadius * unit, background: dark }}>
        {screen ? (screen as ReactNode) : <div style={{ position: 'absolute', inset: 0, background: light }} />}
      </div>
      <div
        style={{
          position: 'absolute',
          left: b.x + b.w / 2 - 30 * unit,
          top: b.y + (s.y - b.y) / 2 - 2 * unit,
          width: 60 * unit,
          height: 4 * unit,
          borderRadius: 2 * unit,
          background: withAlpha(light, 0.18),
        }}
      />
    </Background>
  );
}
