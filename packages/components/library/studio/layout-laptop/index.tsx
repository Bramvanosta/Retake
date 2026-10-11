import type { ReactNode } from 'react';
import { Background, darkLight, scaleRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { bezel: 'dark' | 'light' };

/** Lid, screen and base in design px (screen = `geometry.screen` of component.yaml: keep in sync). */
const GEOMETRY = {
  landscape: { lid: { x: 292, y: 40, w: 1336, h: 775 }, screen: { x: 312, y: 66, w: 1296, h: 729 }, base: { x: 220, y: 815, w: 1480, h: 24 }, lidRadius: 28 },
  vertical: { lid: { x: 82, y: 600, w: 916, h: 527 }, screen: { x: 102, y: 618, w: 876, h: 493 }, base: { x: 40, y: 1127, w: 1000, h: 16 }, lidRadius: 20 },
};

/** The capture on a laptop screen: bezel (lid) around it, a thin base with a hinge notch below. */
export default function LayoutLaptop({ theme, params, unit, variant, screen }: ComponentProps<Params>) {
  const g = GEOMETRY[variant === 'vertical' ? 'vertical' : 'landscape'];
  const lid = scaleRect(g.lid, unit);
  const s = scaleRect(g.screen, unit);
  const base = scaleRect(g.base, unit);
  const { dark, light } = darkLight(theme);
  const bezel = params.bezel === 'light' ? `color-mix(in srgb, ${dark} 12%, ${light})` : `color-mix(in srgb, ${dark} 92%, black)`;
  const metal = `color-mix(in srgb, ${dark} 22%, ${light})`;
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: lid.x,
          top: lid.y,
          width: lid.w,
          height: lid.h,
          borderRadius: `${g.lidRadius * unit}px ${g.lidRadius * unit}px ${6 * unit}px ${6 * unit}px`,
          background: bezel,
          boxShadow: `0 ${18 * unit}px ${50 * unit}px ${withAlpha(dark, 0.18)}`,
        }}
      />
      <div style={{ position: 'absolute', left: s.x, top: s.y, width: s.w, height: s.h, overflow: 'hidden', borderRadius: 4 * unit, background: light }}>
        {screen ? (screen as ReactNode) : null}
      </div>
      <div
        style={{
          position: 'absolute',
          left: base.x,
          top: base.y,
          width: base.w,
          height: base.h,
          borderRadius: `${2 * unit}px ${2 * unit}px ${base.h / 1.4}px ${base.h / 1.4}px`,
          background: `linear-gradient(180deg, ${metal} 0%, color-mix(in srgb, ${dark} 35%, ${light}) 100%)`,
          boxShadow: `0 ${10 * unit}px ${24 * unit}px ${withAlpha(dark, 0.2)}`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: base.w / 2 - 110 * unit,
            top: 0,
            width: 220 * unit,
            height: base.h * 0.38,
            borderRadius: `0 0 ${8 * unit}px ${8 * unit}px`,
            background: `color-mix(in srgb, ${dark} 40%, ${light})`,
          }}
        />
      </div>
    </Background>
  );
}
