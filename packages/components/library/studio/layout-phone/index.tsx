import type { ReactNode } from 'react';
import { Background, backgroundCss, backgroundSample, cardShadow, cssFontFamily, darkLight, deviceTones, mixColors, readableOn, roundTo, withAlpha } from '@demo-studio/components/kit';
import type { ComponentProps, LayoutRects } from '@demo-studio/components/kit';

type Params = { height: number; finish: 'dark' | 'light'; island: boolean; status_bar: boolean; shadow: 'none' | 'soft' | 'strong' };

/** Phone proportions accepted for the display (width / height); other captures are letterboxed in it. */
export const PHONE_ASPECT = { min: 0.42, max: 0.62 } as const;

/** Glass bezel, metal band and status bar (design px) for a display `sh` tall (mirrors component.yaml). */
function edges(sh: number, statusBar: boolean) {
  return { bezel: Math.round(sh * 0.017), band: Math.round(sh * 0.006), bar: statusBar ? Math.round(sh * 0.062) : 0 };
}

/**
 * The default rects (design px × unit) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects`, the manifest geometry evaluated by the planner. Mirrors component.yaml (the library test checks it).
 */
export function defaultRects(params: Pick<Params, 'height' | 'status_bar'>, variant: 'landscape' | 'vertical' | 'square', unit: number, aspect = 390 / 844): LayoutRects {
  const s = (v: number) => v * unit;
  const vertical = variant === 'vertical';
  // Geometry vars are kept to 3 decimals (evalLayoutGeometry): so is the clamped aspect here.
  const a = Math.round(Math.min(Math.max(aspect, PHONE_ASPECT.min), PHONE_ASPECT.max) * 1000) / 1000;
  if (variant === 'square') {
    // The phone on the left, the caption column beside it.
    const sh = 900;
    const { bezel, band, bar } = edges(sh, params.status_bar);
    const sw = Math.round((sh - bar) * a);
    const e = bezel + band;
    const bw = sw + 2 * e;
    const bh = sh + 2 * e;
    const cw = 400;
    const x = Math.round((1080 - bw - 50 - cw) / 2);
    const y = Math.round((1080 - bh) / 2);
    return {
      frame: { x: s(x), y: s(y), w: s(bw), h: s(bh) },
      screen: { x: s(x + e), y: s(y + e + bar), w: s(sw), h: s(sh - bar) },
      caption: { x: s(x + bw + 50), y: s(420), w: s(cw), h: s(240) },
      brandmark: { x: s(x + bw + 50 + cw - 320), y: s(1000), w: s(320), h: s(40) },
      radius: s(Math.round(sw * 0.13)),
    };
  }
  const sh = vertical ? 1300 : params.height;
  const { bezel, band, bar } = edges(sh, params.status_bar);
  const sw = Math.round((sh - bar) * a);
  const e = bezel + band;
  const bw = sw + 2 * e;
  const bh = sh + 2 * e;
  const cw = 700;
  const x = vertical ? Math.round((1080 - bw) / 2) : Math.round((1920 - bw - 96 - cw) / 2);
  const y = vertical ? Math.round((1688 - bh) / 2) : Math.round((1080 - bh) / 2);
  return {
    frame: { x: s(x), y: s(y), w: s(bw), h: s(bh) },
    screen: { x: s(x + e), y: s(y + e + bar), w: s(sw), h: s(sh - bar) },
    caption: vertical ? { x: s(40), y: s(y + bh + 24), w: s(1000), h: s(220) } : { x: s(x + bw + 96), y: s(485), w: s(cw), h: s(110) },
    brandmark: vertical ? { x: s(700), y: s(1840), w: s(340), h: s(40) } : { x: s(x + bw + 96 + cw - 320), y: s(965), w: s(320), h: s(40) },
    radius: s(Math.round(sw * 0.13)),
  };
}

/**
 * The capture on an iPhone-style phone drawn in CSS at the planner's rects: a metal band (theme-tinted graphite or
 * silver) with side buttons, a thin glass bezel, a rounded display (the theme background where a capture of another
 * aspect leaves room), the Dynamic Island over the top of the display, the reference soft shadow. Static at every
 * style_bias.
 */
export default function LayoutPhone({ theme, params, unit, variant, screen, rects }: ComponentProps<Params>) {
  const u = unit;
  const r = rects ?? defaultRects(params, variant, u);
  const sh = variant === 'vertical' ? 1300 : variant === 'square' ? 900 : params.height;
  const { bezel, band, bar } = edges(sh, params.status_bar);
  // The capture area (the declared screen rect, the capture letterboxed in it when its aspect differs) and the display
  // glass: the capture area with the status bar above it.
  const area = r.display ?? r.screen;
  const display = { x: area.x, y: area.y - bar * u, w: area.w, h: area.h + bar * u };
  const e = (bezel + band) * u;
  const body = { x: display.x - e, y: display.y - e, w: display.w + 2 * e, h: display.h + 2 * e };
  const t = deviceTones(theme, params.finish);
  const dr = r.radius;
  const islandW = display.w * 0.32;
  const islandH = display.w * 0.094;
  const islandTop = display.w * 0.028;
  const lens = islandH * 0.42;
  const ink = readableOn(backgroundSample(theme), theme.colors.text, darkLight(theme).dark, 4.5);
  const glyph = display.w * 0.031;
  const midY = display.y + islandTop + islandH / 2;
  const earW = (display.w - islandW) / 2;
  const button = (side: 'left' | 'right', at: number, len: number) => (
    <div
      key={`${side}-${at}`}
      style={{
        position: 'absolute',
        left: side === 'left' ? body.x - 2.6 * u : body.x + body.w - 0.4 * u,
        top: body.y + body.h * at,
        width: 3 * u,
        height: body.h * len,
        borderRadius: 1.5 * u,
        background: `linear-gradient(${side === 'left' ? 90 : 270}deg, ${t.shade} 0%, ${t.body} 100%)`,
      }}
    />
  );

  return (
    <Background theme={theme}>
      {button('left', 0.17, 0.035)}
      {button('left', 0.235, 0.065)}
      {button('left', 0.315, 0.065)}
      {button('right', 0.255, 0.1)}
      {/* Metal band. */}
      <div
        style={{
          position: 'absolute',
          left: body.x,
          top: body.y,
          width: body.w,
          height: body.h,
          borderRadius: dr + e,
          background: `linear-gradient(135deg, ${t.edge} 0%, ${t.body} 22%, ${t.shade} 55%, ${t.body} 82%, ${t.edge} 100%)`,
          boxShadow: cardShadow(theme, params.shadow, u),
        }}
      >
        {/* Glass bezel. */}
        <div
          style={{
            position: 'absolute',
            left: band * u,
            top: band * u,
            right: band * u,
            bottom: band * u,
            borderRadius: dr + bezel * u,
            background: t.glass,
            boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.6, 0.8 * u), 2)}px ${t.rim}`,
          }}
        />
      </div>
      {/* Display. */}
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
      {bar > 0 ? (
        <div style={{ position: 'absolute', left: display.x, top: display.y, width: display.w, height: bar * u, color: ink, fontFamily: cssFontFamily(theme.fonts.body), pointerEvents: 'none' }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              width: earW,
              top: midY - display.y - glyph * 0.75,
              height: glyph * 1.5,
              lineHeight: `${roundTo(glyph * 1.5, 2)}px`,
              textAlign: 'center',
              fontSize: glyph * 1.32,
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            9:41
          </div>
          <svg
            width={earW}
            height={glyph * 1.5}
            viewBox={`0 0 ${roundTo(earW / glyph, 3)} 1.5`}
            style={{ position: 'absolute', left: display.w - earW, top: midY - display.y - glyph * 0.75, overflow: 'visible' }}
          >
            <g transform={`translate(${roundTo(earW / glyph / 2 - 2.55, 3)} 0.25)`} fill={ink}>
              {[0.35, 0.55, 0.78, 1].map((hgt, i) => (
                <rect key={i} x={i * 0.3} y={1 - hgt} width={0.2} height={hgt} rx={0.06} />
              ))}
              {[0.85, 0.55].map((rad) => (
                <path
                  key={rad}
                  d={`M${roundTo(2.05 - 0.707 * rad, 3)} ${roundTo(1 - 0.707 * rad, 3)} A${rad} ${rad} 0 0 1 ${roundTo(2.05 + 0.707 * rad, 3)} ${roundTo(1 - 0.707 * rad, 3)}`}
                  stroke={ink}
                  strokeWidth={0.15}
                  strokeLinecap="round"
                  fill="none"
                />
              ))}
              <circle cx={2.05} cy={0.86} r={0.12} />
              <rect x={3.1} y={0.08} width={1.9} height={0.84} rx={0.24} fill="none" stroke={withAlpha(ink, 0.45)} strokeWidth={0.08} />
              <rect x={3.22} y={0.2} width={1.4} height={0.6} rx={0.14} />
              <rect x={5.08} y={0.36} width={0.12} height={0.3} rx={0.05} fill={withAlpha(ink, 0.45)} />
            </g>
          </svg>
        </div>
      ) : null}
      {params.island ? (
        <div
          style={{
            position: 'absolute',
            left: display.x + (display.w - islandW) / 2,
            top: display.y + islandTop,
            width: islandW,
            height: islandH,
            borderRadius: islandH / 2,
            background: t.glass,
            boxShadow: `0 0 0 ${roundTo(Math.max(0.5, 0.6 * u), 2)}px ${withAlpha(t.glass, 0.35)}`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: islandW - islandH / 2 - lens / 2 - islandH * 0.08,
              top: (islandH - lens) / 2,
              width: lens,
              height: lens,
              borderRadius: lens / 2,
              background: mixColors(t.glass, t.lens, 0.6),
            }}
          />
        </div>
      ) : null}
    </Background>
  );
}
