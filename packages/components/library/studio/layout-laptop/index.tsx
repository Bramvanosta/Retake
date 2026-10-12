import type { ReactNode } from 'react';
import { Background, backgroundCss, cardShadow, deviceTones, mixColors, nightTone, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, LayoutRects } from '@demo-studio/components/kit';

type Params = { width: number; finish: 'light' | 'dark'; shadow: 'none' | 'soft' | 'strong' };

/** Proportions of the device relative to the display width (design px; mirrors component.yaml). */
function parts(sw: number) {
  return {
    bz: Math.round(sw * 0.022),
    chin: Math.round(sw * 0.03),
    hinge: Math.round(sw * 0.008),
    deck: Math.round(sw * 0.026),
  };
}

/**
 * The default rects (design px × unit) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects`, the manifest geometry evaluated by the planner. Mirrors component.yaml (the library test checks it).
 */
export function defaultRects(params: Pick<Params, 'width'>, variant: 'landscape' | 'vertical' | 'square', unit: number, aspect = 16 / 9): LayoutRects {
  const s = (v: number) => v * unit;
  if (variant === 'square') {
    const sw = 820;
    const { bz, chin, hinge, deck } = parts(sw);
    const h = Math.min(Math.round(sw / aspect), 600);
    const w = Math.min(sw, Math.round(600 * aspect));
    const lw = w + 2 * bz;
    const ov = Math.round(lw * 0.075);
    const bw = lw + 2 * ov;
    const dh = bz + h + chin + hinge + deck;
    const x = Math.round((1080 - bw) / 2);
    const y = Math.round((1000 - dh - 184) / 2);
    return {
      frame: { x: s(x), y: s(y), w: s(bw), h: s(dh) },
      screen: { x: s(x + ov + bz), y: s(y + bz), w: s(w), h: s(h) },
      caption: { x: s(40), y: s(y + dh + 24), w: s(1000), h: s(160) },
      brandmark: { x: s(700), y: s(1010), w: s(340), h: s(40) },
      radius: s(Math.round(sw * 0.008)),
    };
  }
  const vertical = variant === 'vertical';
  const sw = vertical ? 880 : params.width;
  const { bz, chin, hinge, deck } = parts(sw);
  const room = vertical ? 1000 : 878 - bz - chin - hinge - deck;
  const h = Math.min(Math.round(sw / aspect), room);
  const w = Math.min(sw, Math.round(room * aspect));
  const lw = w + 2 * bz;
  const ov = Math.round(lw * 0.075);
  const bw = lw + 2 * ov;
  const dh = bz + h + chin + hinge + deck;
  const x = Math.round(((vertical ? 1080 : 1920) - bw) / 2);
  const y = Math.round(((vertical ? 1688 : 958) - dh) / 2);
  return {
    frame: { x: s(x), y: s(y), w: s(bw), h: s(dh) },
    screen: { x: s(x + ov + bz), y: s(y + bz), w: s(w), h: s(h) },
    caption: vertical ? { x: s(40), y: s(y + dh + 24), w: s(1000), h: s(220) } : { x: s(x + ov), y: s(y + dh + 12), w: s(lw - 340), h: s(110) },
    brandmark: vertical ? { x: s(700), y: s(1840), w: s(340), h: s(40) } : { x: s(x + ov + lw - 320), y: s(y + dh + 47), w: s(320), h: s(40) },
    radius: s(Math.round(sw * 0.008)),
  };
}

/**
 * The capture on the display of a MacBook-style laptop seen from the front, drawn in CSS at the planner's rects: the
 * lid (glass bezel, camera, chin) around the display, the hinge, the aluminium base (front edge with a thumb notch)
 * spanning `rects.frame`, the reference soft shadow and a contact shadow under the base. The display shows the theme
 * background where a capture of another aspect leaves room. Every tone comes from the theme. Static at every
 * style_bias.
 */
export default function LayoutLaptop({ theme, params, unit, variant, screen, rects }: ComponentProps<Params>) {
  const u = unit;
  const r = rects ?? defaultRects(params, variant, u);
  const sw = variant === 'vertical' ? 880 : variant === 'square' ? 820 : params.width;
  const p = parts(sw);
  const bz = p.bz * u;
  const chin = p.chin * u;
  const hinge = p.hinge * u;
  const deck = p.deck * u;
  const t = deviceTones(theme, params.finish);
  const display = r.display ?? r.screen;
  const lid = { x: display.x - bz, y: display.y - bz, w: display.w + 2 * bz, h: bz + display.h + chin };
  const base = { x: r.frame.x, y: r.frame.y + r.frame.h - deck, w: r.frame.w, h: deck };
  const hingeTop = lid.y + lid.h;
  const lidRadius = Math.round(sw * 0.028) * u;
  const cam = Math.max(3 * u, bz * 0.26);
  const notchW = base.w * 0.13;
  const notchH = deck * 0.34;
  const night = nightTone(theme);

  return (
    <Background theme={theme}>
      {/* Contact shadow under the base. */}
      <div
        style={{
          position: 'absolute',
          left: base.x + base.w * 0.04,
          top: base.y + deck * 0.55,
          width: base.w * 0.92,
          height: deck * 1.3,
          borderRadius: '50%',
          background: `radial-gradient(ellipse at 50% 40%, ${withAlpha(night, 0.32)} 0%, ${withAlpha(night, 0)} 70%)`,
        }}
      />
      {/* Lid: glass bezel with an aluminium rim. */}
      <div
        style={{
          position: 'absolute',
          left: lid.x,
          top: lid.y,
          width: lid.w,
          height: lid.h,
          borderRadius: `${lidRadius}px ${lidRadius}px ${3 * u}px ${3 * u}px`,
          background: t.glass,
          boxShadow: [`0 0 0 ${roundTo(1.6 * u, 2)}px ${t.body}`, `0 0 0 ${roundTo(2.4 * u, 2)}px ${withAlpha(t.shade, 0.6)}`, cardShadow(theme, params.shadow, u)].filter((x) => x !== 'none').join(', '),
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: lid.w / 2 - cam / 2,
            top: bz / 2 - cam / 2,
            width: cam,
            height: cam,
            borderRadius: cam / 2,
            background: t.lens,
            boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.5, cam * 0.18), 2)}px ${mixColors(t.lens, t.glass, 0.5)}`,
          }}
        />
      </div>
      {/* Display: the theme background where a capture of another aspect leaves room, the capture on top. */}
      <div
        style={{
          position: 'absolute',
          left: display.x,
          top: display.y,
          width: display.w,
          height: display.h,
          borderRadius: `${r.radius}px ${r.radius}px ${roundTo(r.radius * 0.3, 2)}px ${roundTo(r.radius * 0.3, 2)}px`,
          background: backgroundCss(theme),
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        <div style={{ position: 'absolute', left: r.screen.x - display.x, top: r.screen.y - display.y, width: r.screen.w, height: r.screen.h }}>
          {screen ? (screen as ReactNode) : null}
        </div>
      </div>
      {/* Hinge. */}
      <div
        style={{
          position: 'absolute',
          left: lid.x + lid.w * 0.015,
          top: hingeTop,
          width: lid.w * 0.97,
          height: hinge + 1 * u,
          background: `linear-gradient(180deg, ${mixColors(t.glass, t.shade, 0.5)} 0%, ${t.shade} 100%)`,
          borderRadius: `0 0 ${2 * u}px ${2 * u}px`,
        }}
      />
      {/* Base: the front edge of the aluminium case, with the thumb notch. */}
      <div
        style={{
          position: 'absolute',
          left: base.x,
          top: base.y,
          width: base.w,
          height: base.h,
          borderRadius: `${2 * u}px ${2 * u}px ${deck * 0.9}px ${deck * 0.9}px / ${2 * u}px ${2 * u}px ${deck * 0.75}px ${deck * 0.75}px`,
          background: `linear-gradient(180deg, ${t.edge} 0%, ${t.body} 28%, ${mixColors(t.body, t.shade, 0.55)} 72%, ${t.shade} 100%)`,
          boxShadow: `inset 0 ${Math.max(1, u)}px 0 ${withAlpha(t.edge, 0.9)}, 0 ${2 * u}px ${6 * u}px ${withAlpha(night, 0.14)}`,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: (base.w - notchW) / 2,
            top: 0,
            width: notchW,
            height: notchH,
            borderRadius: `0 0 ${notchH}px ${notchH}px`,
            background: `linear-gradient(180deg, ${mixColors(t.shade, t.body, 0.3)} 0%, ${t.body} 100%)`,
          }}
        />
      </div>
    </Background>
  );
}
