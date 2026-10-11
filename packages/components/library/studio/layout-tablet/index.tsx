import type { ReactNode } from 'react';
import { Background, backgroundCss, cardShadow, deviceTones, mixColors, roundTo } from '@demo-studio/components/kit';
import type { ComponentProps, LayoutRects } from '@demo-studio/components/kit';

type Params = { height: number; width: number; finish: 'dark' | 'light'; shadow: 'none' | 'soft' | 'strong' };

/** Tablet proportions accepted for the display (width / height); other captures are letterboxed in it. */
export const TABLET_ASPECT = { min: 0.62, max: 1.6 } as const;

/**
 * The default rects (design px × unit) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects`, the manifest geometry evaluated by the planner. Mirrors component.yaml (the library test checks it).
 */
export function defaultRects(params: Pick<Params, 'height' | 'width'>, variant: 'landscape' | 'vertical', unit: number, aspect = 820 / 1180): LayoutRects {
  const s = (v: number) => v * unit;
  // Geometry vars are kept to 3 decimals (evalLayoutGeometry): so is the clamped aspect here.
  const a = Math.round(Math.min(Math.max(aspect, TABLET_ASPECT.min), TABLET_ASPECT.max) * 1000) / 1000;
  const land = a > 1;
  if (variant === 'vertical') {
    const e = land ? 36 : 50;
    const sw = land ? 940 : Math.min(Math.round(1240 * a), 960);
    const sh = Math.round(sw / a);
    const bw = sw + 2 * e;
    const bh = sh + 2 * e;
    const x = Math.round((1080 - bw) / 2);
    const y = Math.round((1688 - bh) / 2);
    return {
      frame: { x: s(x), y: s(y), w: s(bw), h: s(bh) },
      screen: { x: s(x + e), y: s(y + e), w: s(sw), h: s(sh) },
      caption: { x: s(40), y: s(y + bh + 24), w: s(1000), h: s(220) },
      brandmark: { x: s(700), y: s(1840), w: s(340), h: s(40) },
      radius: s(Math.round(Math.min(sw, sh) * 0.03)),
    };
  }
  if (land) {
    const e = Math.round(params.width * 0.034);
    const room = 878 - 2 * e;
    const sh = Math.min(Math.round(params.width / a), room);
    const sw = Math.min(params.width, Math.round(room * a));
    const bw = sw + 2 * e;
    const bh = sh + 2 * e;
    const x = Math.round((1920 - bw) / 2);
    const y = Math.round((958 - bh) / 2);
    return {
      frame: { x: s(x), y: s(y), w: s(bw), h: s(bh) },
      screen: { x: s(x + e), y: s(y + e), w: s(sw), h: s(sh) },
      caption: { x: s(x), y: s(y + bh + 12), w: s(bw - 340), h: s(110) },
      brandmark: { x: s(x + bw - 320), y: s(y + bh + 47), w: s(320), h: s(40) },
      radius: s(Math.round(Math.min(sw, sh) * 0.03)),
    };
  }
  const e = Math.round(params.height * 0.048);
  const sh = params.height;
  const sw = Math.round(sh * a);
  const bw = sw + 2 * e;
  const bh = sh + 2 * e;
  const x = Math.round((1920 - bw - 96 - 640) / 2);
  const y = Math.round((1080 - bh) / 2);
  return {
    frame: { x: s(x), y: s(y), w: s(bw), h: s(bh) },
    screen: { x: s(x + e), y: s(y + e), w: s(sw), h: s(sh) },
    caption: { x: s(x + bw + 96), y: s(485), w: s(640), h: s(110) },
    brandmark: { x: s(x + bw + 96 + 320), y: s(965), w: s(320), h: s(40) },
    radius: s(Math.round(Math.min(sw, sh) * 0.03)),
  };
}

/**
 * The capture on an iPad-style tablet drawn in CSS at the planner's rects: a thin metal edge, uniform glass bezels
 * with the camera centred on the top one, a rounded display (the theme background where a capture of another aspect
 * leaves room), the reference soft shadow. Portrait or landscape is the planner's (it follows the capture). Static at
 * every style_bias.
 */
export default function LayoutTablet({ theme, params, unit, variant, screen, rects }: ComponentProps<Params>) {
  const u = unit;
  const r = rects ?? defaultRects(params, variant, u);
  const display = r.display ?? r.screen;
  const body = r.frame;
  const e = Math.max(4 * u, display.x - body.x);
  const t = deviceTones(theme, params.finish);
  const dr = r.radius;
  const edge = Math.max(1.5 * u, e * 0.1);
  const cam = Math.max(3 * u, e * 0.18);

  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: body.x,
          top: body.y,
          width: body.w,
          height: body.h,
          borderRadius: dr + e * 0.92,
          background: `linear-gradient(135deg, ${t.edge} 0%, ${t.body} 30%, ${t.shade} 60%, ${t.body} 100%)`,
          boxShadow: cardShadow(theme, params.shadow, u),
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: edge,
            top: edge,
            right: edge,
            bottom: edge,
            borderRadius: dr + e * 0.92 - edge,
            background: t.glass,
            boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.6, 0.8 * u), 2)}px ${t.rim}`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: body.w / 2 - cam / 2,
            top: (display.y - body.y) / 2 - cam / 2 + edge / 2,
            width: cam,
            height: cam,
            borderRadius: cam / 2,
            background: t.lens,
            boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.5, cam * 0.2), 2)}px ${mixColors(t.lens, t.glass, 0.5)}`,
          }}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: display.x,
          top: display.y,
          width: display.w,
          height: display.h,
          borderRadius: dr,
          background: backgroundCss(theme),
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        <div style={{ position: 'absolute', left: r.screen.x - display.x, top: r.screen.y - display.y, width: r.screen.w, height: r.screen.h }}>
          {screen ? (screen as ReactNode) : null}
        </div>
      </div>
    </Background>
  );
}
