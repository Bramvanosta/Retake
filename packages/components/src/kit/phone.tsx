/**
 * A phone drawn in CSS for full-screen phone cards (L2.9: studio/phone-lockscreen, studio/phone-home-badge), in the
 * family of studio/layout-phone: a metal band tinted from the theme, a thin glass bezel, a rounded display, the Dynamic
 * Island, side buttons and the reference soft shadow. `phoneCardGeometry` places it in any output format (centred, or
 * left with a text column beside it; lifted in tall formats) — mirrored by the cards' manifest `anchor` expressions.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { ThemeTokens } from '../types.js';
import { cardShadow, deviceTones } from './devices.js';
import type { DeviceFinish, ShadowKind } from './devices.js';
import { roundTo } from './motion.js';
import { cssFontFamily, darkLight, mixColors, nightTone, withAlpha } from './style.js';

/** Display width / height of the drawn phone (a modern 6.1" phone). */
export const PHONE_DISPLAY_ASPECT = 0.462;

export interface PhoneCardGeometry {
  /** The display (output px). */
  display: { x: number; y: number; w: number; h: number };
  /** The body (band) around it. */
  body: { x: number; y: number; w: number; h: number };
  /** Text column beside the phone (layout left in wide formats), else below it (vertical). */
  text?: { x: number; y: number; w: number; h: number };
  radius: number;
  /** Bezel + band, output px. */
  edge: number;
}

/**
 * Where a phone card's phone goes in a frame `width` × `height` (output px, `unit` = output px per design px):
 * display height = min(height param, frame height − 160 design px), width × 0.462; centred, or (layout `left`, in wide
 * formats) left of a text column; in a tall format the phone is lifted 120 design px to leave room below.
 */
export function phoneCardGeometry(opts: { width: number; height: number; unit: number; displayHeight: number; layout: 'center' | 'left'; withText: boolean }): PhoneCardGeometry {
  const u = opts.unit;
  const fw = opts.width / u;
  const fh = opts.height / u;
  const sh = Math.min(opts.displayHeight, fh - 160);
  const sw = Math.round(sh * PHONE_DISPLAY_ASPECT);
  const e = Math.round(sh * 0.017) + Math.round(sh * 0.006);
  const bw = sw + 2 * e;
  const bh = sh + 2 * e;
  const wide = Math.min(1, Math.floor(fw / fh));
  const side = opts.layout === 'left' && wide === 1 ? 1 : 0;
  const gap = Math.round(fw * 0.05);
  const cw = Math.min(700, fw - bw - 3 * gap);
  const x = side ? Math.round((fw - bw - gap - cw) / 2) : Math.round((fw - bw) / 2);
  // Tall formats keep room below the phone (text, brand mark): the phone sits 120 design px above the centre.
  const lift = wide === 0 ? 120 : 0;
  const y = Math.round((fh - bh) / 2) - lift;
  const out: PhoneCardGeometry = {
    display: { x: (x + e) * u, y: (y + e) * u, w: sw * u, h: sh * u },
    body: { x: x * u, y: y * u, w: bw * u, h: bh * u },
    radius: Math.round(sw * 0.13) * u,
    edge: e * u,
  };
  if (opts.withText) {
    out.text = side ? { x: (x + bw + gap) * u, y: (fh / 2 - 160) * u, w: cw * u, h: 320 * u } : { x: gap * u, y: (y + bh + 40) * u, w: (fw - 2 * gap) * u, h: (fh - y - bh - 60) * u };
  }
  return out;
}

/** A wallpaper from the theme: the accent glowing into the night tone (a soft radial blend, no image). */
export function wallpaperCss(theme: ThemeTokens, mood: 'accent' | 'night' | 'paper' = 'accent'): string {
  const night = nightTone(theme);
  const { light } = darkLight(theme);
  const a = theme.colors.accent;
  if (mood === 'paper') {
    return `radial-gradient(120% 75% at 30% 15%, ${mixColors(light, a, 0.08)} 0%, ${mixColors(light, a, 0.22)} 55%, ${mixColors(light, night, 0.3)} 100%)`;
  }
  if (mood === 'night') {
    return `radial-gradient(120% 80% at 70% 10%, ${mixColors(night, a, 0.35)} 0%, ${night} 60%, ${mixColors(night, '#000000', 0.35)} 100%)`;
  }
  return [
    `radial-gradient(90% 55% at 25% 18%, ${withAlpha(mixColors(a, light, 0.35), 0.95)} 0%, ${withAlpha(a, 0)} 70%)`,
    `radial-gradient(110% 70% at 85% 80%, ${withAlpha(mixColors(a, night, 0.15), 0.9)} 0%, ${withAlpha(a, 0)} 70%)`,
    `linear-gradient(170deg, ${mixColors(a, night, 0.35)} 0%, ${mixColors(night, a, 0.2)} 100%)`,
  ].join(', ');
}

/** Status bar glyphs (signal, wifi, battery) in `ink`, `h` px tall. */
export function StatusGlyphs({ ink, h }: { ink: string; h: number }): ReactNode {
  return (
    <svg width={h * 5.3} height={h} viewBox="0 0 5.3 1" style={{ display: 'block', overflow: 'visible' }}>
      <g fill={ink}>
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
        <rect x={3.1} y={0.08} width={1.9} height={0.84} rx={0.24} fill="none" stroke={withAlpha(ink, 0.5)} strokeWidth={0.08} />
        <rect x={3.22} y={0.2} width={1.4} height={0.6} rx={0.14} />
        <rect x={5.08} y={0.36} width={0.12} height={0.3} rx={0.05} fill={withAlpha(ink, 0.5)} />
      </g>
    </svg>
  );
}

/**
 * The phone: band, bezel, display (its content = `children`, positioned in display coordinates), Dynamic Island and
 * an optional status bar (`time` on the left — lock screens leave it empty — and the glyphs on the right).
 */
export function PhoneDevice(props: {
  theme: ThemeTokens;
  geometry: PhoneCardGeometry;
  finish?: DeviceFinish;
  shadow?: ShadowKind;
  unit: number;
  /** Status bar ink and time (omit `time` on a lock screen). */
  status?: { ink: string; time?: string };
  children?: ReactNode;
  style?: CSSProperties;
}): ReactNode {
  const { theme, geometry: g, unit: u } = props;
  const t = deviceTones(theme, props.finish ?? 'dark');
  const d = g.display;
  const b = g.body;
  const band = Math.max(1, (g.edge * 6) / 23);
  const islandW = d.w * 0.3;
  const islandH = d.w * 0.088;
  const islandTop = d.w * 0.028;
  const lens = islandH * 0.42;
  const glyph = d.w * 0.031;
  const earW = (d.w - islandW) / 2;
  const midY = islandTop + islandH / 2;
  const button = (side: 'left' | 'right', at: number, len: number) => (
    <div
      key={`${side}-${at}`}
      style={{
        position: 'absolute',
        left: side === 'left' ? b.x - 2.6 * u : b.x + b.w - 0.4 * u,
        top: b.y + b.h * at,
        width: 3 * u,
        height: b.h * len,
        borderRadius: 1.5 * u,
        background: `linear-gradient(${side === 'left' ? 90 : 270}deg, ${t.shade} 0%, ${t.body} 100%)`,
      }}
    />
  );
  return (
    <div style={{ position: 'absolute', inset: 0, ...props.style }}>
      {button('left', 0.17, 0.035)}
      {button('left', 0.235, 0.065)}
      {button('left', 0.315, 0.065)}
      {button('right', 0.255, 0.1)}
      <div
        style={{
          position: 'absolute',
          left: b.x,
          top: b.y,
          width: b.w,
          height: b.h,
          borderRadius: g.radius + g.edge,
          background: `linear-gradient(135deg, ${t.edge} 0%, ${t.body} 22%, ${t.shade} 55%, ${t.body} 82%, ${t.edge} 100%)`,
          boxShadow: cardShadow(theme, props.shadow ?? 'soft', u),
        }}
      >
        <div style={{ position: 'absolute', inset: band, borderRadius: g.radius + g.edge - band, background: t.glass, boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.6, 0.8 * u), 2)}px ${t.rim}` }} />
      </div>
      <div style={{ position: 'absolute', left: d.x, top: d.y, width: d.w, height: d.h, borderRadius: g.radius, overflow: 'hidden', isolation: 'isolate', background: t.glass }}>
        {props.children}
        {props.status ? (
          <div
            style={{ position: 'absolute', left: 0, top: 0, width: d.w, height: islandTop * 2 + islandH, color: props.status.ink, fontFamily: cssFontFamily(theme.fonts.body), pointerEvents: 'none' }}
          >
            {props.status.time ? (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  width: earW,
                  top: midY - glyph * 0.75,
                  height: glyph * 1.5,
                  lineHeight: `${roundTo(glyph * 1.5, 2)}px`,
                  textAlign: 'center',
                  fontSize: glyph * 1.32,
                  fontWeight: 600,
                }}
              >
                {props.status.time}
              </div>
            ) : null}
            <div style={{ position: 'absolute', left: d.w - earW + (earW - glyph * 5.3) / 2, top: midY - glyph * 0.5 }}>
              <StatusGlyphs ink={props.status.ink} h={glyph} />
            </div>
          </div>
        ) : null}
        <div
          style={{
            position: 'absolute',
            left: (d.w - islandW) / 2,
            top: islandTop,
            width: islandW,
            height: islandH,
            borderRadius: islandH / 2,
            background: t.glass,
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
      </div>
    </div>
  );
}
