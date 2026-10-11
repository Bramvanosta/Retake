import type { CSSProperties, ReactNode } from 'react';
import { Background, darkLight, scaleRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components/kit';

type Params = { radius: number; shadow: 'none' | 'soft' | 'strong' };

/** Same screen rects as `geometry` / `geometry_vertical` in component.yaml (design px). */
const GEOMETRY = {
  landscape: { screen: { x: 180, y: 54, w: 1560, h: 878 } },
  vertical: { screen: { x: 40, y: 600, w: 1000, h: 563 } },
};

function shadowCss(kind: Params['shadow'], color: string, unit: number): string {
  if (kind === 'none') return 'none';
  const strong = kind === 'strong';
  return `0 ${(strong ? 30 : 20) * unit}px ${(strong ? 80 : 60) * unit}px ${withAlpha(color, strong ? 0.3 : 0.16)}`;
}

/** Stand-in for the capture in previews: a quiet app skeleton in theme colours. */
function Skeleton({ theme, unit }: { theme: ThemeTokens; unit: number }) {
  const ink = darkLight(theme).dark;
  const bar = (w: string, h: number, extra: CSSProperties = {}): ReactNode => (
    <div style={{ width: w, height: h * unit, borderRadius: 6 * unit, background: withAlpha(ink, 0.08), ...extra }} />
  );
  return (
    <div style={{ position: 'absolute', inset: 0, background: darkLight(theme).light, padding: 40 * unit, display: 'flex', flexDirection: 'column', gap: 24 * unit }}>
      {bar('100%', 44)}
      <div style={{ display: 'flex', gap: 24 * unit, flex: 1 }}>
        {bar('22%', 0, { height: 'auto' })}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 18 * unit }}>
          {bar('60%', 36, { background: withAlpha(theme.colors.accent, 0.18) })}
          {bar('100%', 120)}
          {bar('100%', 120)}
          {bar('80%', 120)}
        </div>
      </div>
    </div>
  );
}

/**
 * The capture in a rounded card on the theme background. The composition draws the caption component in the
 * `caption` rect and the theme's brand mark in the `brandmark` rect of the geometry: a layout draws neither.
 */
export default function Layout({ theme, params, unit, variant, screen }: ComponentProps<Params>) {
  const g = GEOMETRY[variant === 'vertical' ? 'vertical' : 'landscape'];
  const s = scaleRect(g.screen, unit);
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: s.x,
          top: s.y,
          width: s.w,
          height: s.h,
          borderRadius: params.radius * unit,
          overflow: 'hidden',
          boxShadow: shadowCss(params.shadow, darkLight(theme).dark, unit),
          background: darkLight(theme).light,
        }}
      >
        {screen ? (screen as ReactNode) : <Skeleton theme={theme} unit={unit} />}
      </div>
    </Background>
  );
}
