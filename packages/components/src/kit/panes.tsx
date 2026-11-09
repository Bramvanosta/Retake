/**
 * Pieces of multi-page layouts (L2.11: studio/layout-split, studio/layout-pip): a compact browser bar above a page, the
 * label of a page, a phone drawn around an inset page. Every colour from the theme (the window controls are system
 * colours); sizes in design px × unit.
 */
import type { ReactNode } from 'react';
import type { ThemeTokens } from '../types.js';
import { SYSTEM_COLORS, addressParts, cardShadow, deviceTones } from './devices.js';
import type { ShadowKind } from './devices.js';
import { capTextLayout } from './metrics.js';
import { CapText } from './elements.js';
import { insetPhoneEdge } from './frame-geometry.js';
import { roundTo } from './motion.js';
import { cssFontFamily, darkLight, isDarkBackground, liftToContrast, mixColors, nightTone, backgroundSample, readableOn, withAlpha } from './style.js';

/** Height of the compact browser bar above each page of a split screen (design px). */
export const PANE_BAR = 40;
/** Height of the browser bar above the main page of a picture in picture (design px, as studio/layout-browser). */
export const PIP_BAR = 52;
/** Height of the label row above each page of a split screen (design px). */
export const PANE_LABEL_ROW = 44;

/** Bar tones from the theme: a light bar is the theme's light tone, a dark one its night tone lifted a little. */
export function barTones(theme: ThemeTokens): { bar: string; field: string; ink: string; quiet: string; hairline: string; dark: boolean } {
  const { dark, light } = darkLight(theme);
  if (isDarkBackground(theme)) {
    const base = mixColors(nightTone(theme), light, 0.07);
    return { bar: base, field: mixColors(base, light, 0.09), ink: mixColors(light, base, 0.08), quiet: mixColors(light, base, 0.45), hairline: withAlpha(light, 0.1), dark: true };
  }
  return { bar: mixColors(light, dark, 0.025), field: mixColors(light, dark, 0.065), ink: mixColors(dark, light, 0.06), quiet: mixColors(dark, light, 0.5), hairline: withAlpha(dark, 0.11), dark: false };
}

/**
 * A compact macOS-style window bar (traffic lights, an address field with the page's URL as the video shows it — its
 * display URL, host emphasised, path quieter; without `url`, a local page without one, the theme's `brand.url`),
 * `w × h` output px, drawn at the top-left of its parent.
 */
export function WindowBar({ theme, w, h, url, unit }: { theme: ThemeTokens; w: number; h: number; url?: string; unit: number }): ReactNode {
  const u = unit;
  const t = barTones(theme);
  const dot = Math.max(6, h * 0.26);
  const field = { w: Math.min(w * 0.56, 560 * u), h: h * 0.64 };
  const parts = addressParts(url);
  const size = Math.max(9, h * 0.32);
  const host = parts?.host ?? theme.brand.url ?? '';
  const path = parts?.path && parts.path !== '/' ? parts.path : '';
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, background: t.bar, borderBottom: `${Math.max(1, u)}px solid ${t.hairline}`, boxSizing: 'border-box' }}>
      <div style={{ position: 'absolute', left: h * 0.42, top: (h - dot) / 2, display: 'flex', gap: dot * 0.62 }}>
        {[SYSTEM_COLORS.close, SYSTEM_COLORS.minimize, SYSTEM_COLORS.zoom].map((c, i) => (
          <span key={i} style={{ width: dot, height: dot, borderRadius: dot / 2, background: c, display: 'block', boxShadow: `inset 0 0 0 ${Math.max(0.5, dot / 24)}px ${withAlpha(t.ink, 0.12)}` }} />
        ))}
      </div>
      <div
        style={{
          position: 'absolute',
          left: (w - field.w) / 2,
          top: (h - field.h) / 2,
          width: field.w,
          height: field.h,
          borderRadius: field.h * 0.3,
          background: t.field,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          whiteSpace: 'pre',
          fontFamily: cssFontFamily(theme.fonts.body),
          fontSize: size,
          padding: `0 ${size}px`,
          boxSizing: 'border-box',
        }}
      >
        <span style={{ color: t.ink, fontWeight: 500 }}>{host}</span>
        {path ? <span style={{ color: t.quiet, overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</span> : null}
      </div>
    </div>
  );
}

/**
 * The label of a page above it (kicker style: an accent rule and uppercase body type): the acting page's in the accent
 * colour with a longer rule, the other one quieter. `y` is the top of the label row (PANE_LABEL_ROW × unit tall).
 */
export function PaneLabel({ theme, x, y, w, label, acting, unit }: { theme: ThemeTokens; x: number; y: number; w: number; label: string; acting: number; unit: number }): ReactNode {
  const u = unit;
  const k = theme.captions?.kicker;
  const size = (k?.size ?? 15) * u;
  const bg = backgroundSample(theme);
  const accent = liftToContrast(bg, theme.colors.accent, readableOn(bg, theme.colors.text, theme.colors.paper, 4.5), 3);
  const quiet = readableOn(bg, theme.colors.muted, theme.colors.text, 3);
  const color = mixColors(quiet, accent, acting);
  const rule = (18 + 18 * acting) * u;
  const gap = 12 * u;
  const layout = capTextLayout({
    text: label.toUpperCase(),
    width: Math.max(10, w - rule - gap),
    maxFontSize: size,
    minFontSize: size * 0.7,
    maxLines: 1,
    lineHeight: 1.1,
    fontFamily: k?.font ?? theme.fonts.body,
    fontWeight: k?.weight ?? 600,
    letterSpacing: k?.letter_spacing ?? 0.14,
  });
  const centre = y + (PANE_LABEL_ROW * u) / 2;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
      <div style={{ position: 'absolute', left: roundTo(x, 2), top: roundTo(centre - u, 2), width: roundTo(rule, 2), height: Math.max(1, 2 * u), background: accent, opacity: roundTo(0.55 + 0.45 * acting, 3) }} />
      <CapText layout={layout} x={x + rule + gap} capTop={centre - layout.capHeight / 2} color={color} />
    </div>
  );
}

/** A plain card around an inset page that is not a phone: rounded, the strong shadow, a hairline edge of the light tone. */
export function InsetCard({ theme, rect, radius, unit, children }: { theme: ThemeTokens; rect: { x: number; y: number; w: number; h: number }; radius: number; unit: number; children?: ReactNode }): ReactNode {
  const { light } = darkLight(theme);
  const edge = Math.max(2, 4 * unit);
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x - edge,
        top: rect.y - edge,
        width: rect.w + 2 * edge,
        height: rect.h + 2 * edge,
        borderRadius: radius + edge,
        background: light,
        boxShadow: cardShadow(theme, 'strong', unit),
      }}
    >
      <div style={{ position: 'absolute', left: edge, top: edge, width: rect.w, height: rect.h, borderRadius: radius, overflow: 'hidden', isolation: 'isolate', background: nightTone(theme) }}>{children}</div>
    </div>
  );
}

/**
 * A phone drawn around an inset page (picture in picture): a metal band tinted from the theme, a thin glass bezel, the
 * rounded display showing the page — no island or status bar over it (the page shows whole) — and a strong shadow so
 * it reads over the main page.
 */
export function InsetPhone({ theme, display, unit, shadow = 'strong', children }: { theme: ThemeTokens; display: { x: number; y: number; w: number; h: number }; unit: number; shadow?: ShadowKind; children?: ReactNode }): ReactNode {
  const t = deviceTones(theme, 'dark');
  const e = insetPhoneEdge(display.h);
  const radius = Math.round(display.w * 0.12);
  const band = Math.max(1, (e * 6) / 23);
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0 }}>
      <div
        style={{
          position: 'absolute',
          left: display.x - e,
          top: display.y - e,
          width: display.w + 2 * e,
          height: display.h + 2 * e,
          borderRadius: radius + e,
          background: `linear-gradient(135deg, ${t.edge} 0%, ${t.body} 22%, ${t.shade} 55%, ${t.body} 82%, ${t.edge} 100%)`,
          boxShadow: cardShadow(theme, shadow, unit),
        }}
      >
        <div style={{ position: 'absolute', inset: band, borderRadius: radius + e - band, background: t.glass, boxShadow: `inset 0 0 0 ${roundTo(Math.max(0.6, 0.8 * unit), 2)}px ${t.rim}` }} />
      </div>
      <div style={{ position: 'absolute', left: display.x, top: display.y, width: display.w, height: display.h, borderRadius: radius, overflow: 'hidden', isolation: 'isolate', background: t.glass }}>
        {children}
      </div>
    </div>
  );
}
