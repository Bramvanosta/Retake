import type { ReactNode } from 'react';
import { Background, darkLight, isDarkBackground, nightTone, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, LayoutRects, ThemeTokens } from '@demo-studio/components/kit';

type Params = { width: number; radius: number; shadow: 'none' | 'soft' | 'strong' };

/**
 * The default rects (design px × unit) for a 16:9 capture — ONLY used outside a plan (unit previews): in a plan the
 * composition passes `rects`, the manifest geometry evaluated by the planner (the single source of truth). Mirrors
 * component.yaml; the library test checks they agree.
 */
export function defaultRects(params: Pick<Params, 'width' | 'radius'>, variant: 'landscape' | 'vertical', unit: number): LayoutRects {
  const s = (v: number) => v * unit;
  if (variant === 'vertical') {
    const h = Math.min(Math.round(1000 / (16 / 9)), 1100);
    const y = Math.round((1688 - h) / 2);
    const card = { x: s(40), y: s(y), w: s(1000), h: s(h) };
    return { screen: card, frame: card, caption: { x: s(40), y: s(y + h + 12), w: s(1000), h: s(220) }, brandmark: { x: s(700), y: s(1840), w: s(340), h: s(40) }, radius: s(params.radius) };
  }
  const h = Math.min(Math.round(params.width / (16 / 9)), 878);
  const w = Math.min(params.width, Math.floor(878 * (16 / 9)));
  const x = Math.round((1920 - w) / 2);
  const y = Math.round((958 - h) / 2);
  const card = { x: s(x), y: s(y), w: s(w), h: s(h) };
  return {
    screen: card,
    frame: card,
    caption: { x: s(x), y: s(y + h + 12), w: s(w - 340), h: s(110) },
    brandmark: { x: s(x + w - 320), y: s(y + h + 47), w: s(320), h: s(40) },
    radius: s(params.radius),
  };
}

/**
 * The reference soft shadow (look.md: 0 24 60 at 16 % + 0 2 8 at 8 % of the warm ink), tinted with the theme's dark
 * tone; on a dark background a hairline of the light tone keeps the card's edge readable.
 */
function shadowCss(kind: Params['shadow'], theme: ThemeTokens, unit: number): string {
  const tint = nightTone(theme);
  const parts: string[] = [];
  if (kind !== 'none') {
    const strong = kind === 'strong';
    parts.push(`0 ${(strong ? 32 : 24) * unit}px ${(strong ? 80 : 60) * unit}px ${withAlpha(tint, strong ? 0.3 : 0.16)}`);
    parts.push(`0 ${2 * unit}px ${8 * unit}px ${withAlpha(tint, strong ? 0.14 : 0.08)}`);
  }
  if (isDarkBackground(theme)) parts.push(`0 0 0 ${Math.max(1, unit)}px ${withAlpha(darkLight(theme).light, 0.1)}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** Stand-in for the capture in previews: a quiet app skeleton in theme colours. */
function Skeleton({ theme, unit }: { theme: ThemeTokens; unit: number }) {
  const { dark, light } = darkLight(theme);
  const bar = (w: string, h: number, tint = withAlpha(dark, 0.08)) => <div style={{ width: w, height: h * unit, borderRadius: 6 * unit, background: tint }} />;
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

/**
 * The capture in a rounded card with a soft shadow on the theme background, at the planner's rects (the composition
 * draws the caption in `rects.caption` and the brand mark in `rects.brandmark`). Static at every style_bias: the
 * frame never moves on its own (camera moves are the planner's, transitions the transition component's).
 */
export default function LayoutCard({ theme, params, unit, variant, screen, rects }: ComponentProps<Params>) {
  const r = rects ?? defaultRects(params, variant, unit);
  const card = r.frame;
  const inner = { x: r.screen.x - card.x, y: r.screen.y - card.y, w: r.screen.w, h: r.screen.h };
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: card.x,
          top: card.y,
          width: card.w,
          height: card.h,
          borderRadius: r.radius,
          boxShadow: shadowCss(params.shadow, theme, unit),
          background: nightTone(theme),
          overflow: 'hidden',
          // Clip the capture to the rounded corners on the GPU path too.
          isolation: 'isolate',
        }}
      >
        <div style={{ position: 'absolute', left: inner.x, top: inner.y, width: inner.w, height: inner.h }}>
          {screen ? (screen as ReactNode) : <Skeleton theme={theme} unit={unit} />}
        </div>
      </div>
    </Background>
  );
}
