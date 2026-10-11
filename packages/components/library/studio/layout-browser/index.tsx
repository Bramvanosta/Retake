import type { ReactNode } from 'react';
import { Background, cssFontFamily, darkLight, scaleRect, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

type Params = { radius: number; shadow: 'none' | 'soft' | 'strong'; show_url: boolean };

/** Same rects as `geometry` / `geometry_vertical` in component.yaml (design px). */
const GEOMETRY = {
  landscape: { frame: { x: 216, y: 36, w: 1488, h: 877 }, chrome: 40 },
  vertical: { frame: { x: 40, y: 520, w: 1000, h: 603 }, chrome: 40 },
};

function shadowCss(kind: Params['shadow'], color: string, unit: number): string {
  if (kind === 'none') return 'none';
  const strong = kind === 'strong';
  return `0 ${(strong ? 32 : 22) * unit}px ${(strong ? 80 : 56) * unit}px ${withAlpha(color, strong ? 0.28 : 0.16)}, 0 ${2 * unit}px ${8 * unit}px ${withAlpha(color, 0.08)}`;
}

/** "https://shop.example.com/catalogue?x=1" → "shop.example.com/catalogue". */
function displayUrl(url: string | undefined): string {
  if (!url) return '';
  return url.replace(/^[a-z]+:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '');
}

/** The capture in a browser window: chrome bar (dots + URL pill) above the screen. */
export default function LayoutBrowser({ theme, params, unit, variant, screen, url }: ComponentProps<Params>) {
  const g = GEOMETRY[variant === 'vertical' ? 'vertical' : 'landscape'];
  const f = scaleRect(g.frame, unit);
  const bar = g.chrome * unit;
  const { dark, light } = darkLight(theme);
  const chromeBg = `color-mix(in srgb, ${dark} 6%, ${light})`;
  const dot = 12 * unit;
  const shown = params.show_url ? displayUrl(url) : '';
  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: f.x,
          top: f.y,
          width: f.w,
          height: f.h,
          borderRadius: params.radius * unit,
          overflow: 'hidden',
          boxShadow: shadowCss(params.shadow, dark, unit),
          background: light,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            height: bar,
            background: chromeBg,
            borderBottom: `${Math.max(1, unit)}px solid ${withAlpha(dark, 0.1)}`,
            display: 'flex',
            alignItems: 'center',
            boxSizing: 'border-box',
            padding: `0 ${16 * unit}px`,
          }}
        >
          <div style={{ display: 'flex', gap: 8 * unit }}>
            {[0.22, 0.16, 0.12].map((a) => (
              <span key={a} style={{ width: dot, height: dot, borderRadius: dot / 2, background: withAlpha(dark, a), display: 'inline-block' }} />
            ))}
          </div>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
            {shown ? (
              <div
                style={{
                  maxWidth: '60%',
                  height: 26 * unit,
                  lineHeight: `${26 * unit}px`,
                  padding: `0 ${18 * unit}px`,
                  borderRadius: 13 * unit,
                  background: withAlpha(dark, 0.06),
                  color: withAlpha(dark, 0.62),
                  fontFamily: cssFontFamily(theme.fonts.body),
                  fontSize: 15 * unit,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {shown}
              </div>
            ) : null}
          </div>
          <div style={{ width: 3 * dot + 16 * unit }} />
        </div>
        <div style={{ position: 'absolute', left: 0, top: bar, right: 0, bottom: 0, overflow: 'hidden', background: light }}>
          {screen ? (screen as ReactNode) : null}
        </div>
      </div>
    </Background>
  );
}
