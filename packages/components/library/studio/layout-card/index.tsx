import type { ReactNode } from 'react';
import { Background, darkLight, scaleRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, ThemeTokens } from '@demo-studio/components/kit';

type Params = { width: number; radius: number; shadow: 'none' | 'soft' | 'strong' };

/**
 * Screen rect in design px: the `geometry` / `geometry_vertical` of component.yaml (keep in sync). The planner places
 * captions and overlays from the declared geometry, so the card is drawn exactly there: `width` is accepted (themes
 * pass it) but only takes effect once the planner derives geometry from params (L2.5).
 */
function screenRect(variant: 'landscape' | 'vertical') {
  return variant === 'vertical' ? { x: 40, y: 560, w: 1000, h: 562.5 } : { x: 180, y: 40, w: 1560, h: 877.5 };
}

function shadowCss(kind: Params['shadow'], color: string, unit: number): string {
  if (kind === 'none') return 'none';
  const strong = kind === 'strong';
  return [
    `0 ${(strong ? 32 : 24) * unit}px ${(strong ? 80 : 60) * unit}px ${withAlpha(color, strong ? 0.28 : 0.16)}`,
    `0 ${2 * unit}px ${8 * unit}px ${withAlpha(color, strong ? 0.12 : 0.08)}`,
  ].join(', ');
}

/** Stand-in for the capture in previews: a quiet app skeleton in theme colours. */
function Skeleton({ theme, unit }: { theme: ThemeTokens; unit: number }) {
  const { dark, light } = darkLight(theme);
  const bar = (w: string, h: number, tint = withAlpha(dark, 0.08)) => (
    <div style={{ width: w, height: h * unit, borderRadius: 6 * unit, background: tint }} />
  );
  return (
    <div style={{ position: 'absolute', inset: 0, background: light, padding: 40 * unit, display: 'flex', flexDirection: 'column', gap: 22 * unit }}>
      {bar('100%', 44)}
      {bar('55%', 34, withAlpha(theme.colors.accent, 0.18))}
      {bar('100%', 130)}
      {bar('100%', 130)}
      {bar('80%', 130)}
    </div>
  );
}

/** The capture in a rounded card on the theme background (the composition draws the caption and the brand mark). */
export default function LayoutCard({ theme, params, unit, variant, screen }: ComponentProps<Params>) {
  const s = scaleRect(screenRect(variant), unit);
  const { dark, light } = darkLight(theme);
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
          boxShadow: shadowCss(params.shadow, dark, unit),
          background: light,
        }}
      >
        {screen ? (screen as ReactNode) : <Skeleton theme={theme} unit={unit} />}
      </div>
    </Background>
  );
}
