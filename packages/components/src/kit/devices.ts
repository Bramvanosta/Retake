/**
 * Helpers for frames around a capture (cards, browser windows, devices) and for captions drawn over it (pure, no
 * React): the reference soft shadow, device tones derived from the theme, the address-bar split of a URL and the box
 * of a caption band over the capture. Shared by the built-in layouts, studio/caption-overlay and the review.
 */
import type { ThemeTokens } from '../types.js';
import { darkLight, isDarkBackground, luminance, mixColors, nightTone, withAlpha } from './style.js';

/**
 * Neutral SYSTEM colours of operating-system mock-ups — not brand colours: the window controls ("traffic lights") of
 * a macOS-style window. Layouts offer a theme-tinted alternative (`controls: theme`).
 */
export const SYSTEM_COLORS = {
  close: '#ff5f57',
  minimize: '#febc2e',
  zoom: '#28c840',
} as const;

export type ShadowKind = 'none' | 'soft' | 'strong';

/**
 * The reference soft shadow under a card, window or device (docs/reference/look.md: 0 24 60 at 16 % + 0 2 8 at 8 % of
 * the warm ink), tinted with the theme's night tone; `strong` is deeper. On a dark background a hairline of the light
 * tone keeps the edge readable.
 */
export function cardShadow(theme: Pick<ThemeTokens, 'colors' | 'background'>, kind: ShadowKind, unit: number): string {
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

export type DeviceFinish = 'dark' | 'light';

/** Colours of a device mock-up, all derived from the theme (so a device looks native in every theme). */
export interface DeviceTones {
  /** Screen glass and bezel: the theme's night tone, a touch deeper. */
  glass: string;
  /** Body / frame band. */
  body: string;
  /** Lighter edge of the body (top highlight). */
  edge: string;
  /** Darker side of the body (bottom shade). */
  shade: string;
  /** Hairline around the glass. */
  rim: string;
  /** Camera lens. */
  lens: string;
}

/**
 * Device tones from the theme's dark and light colours: `dark` = a graphite body, `light` = a silver one (the theme's
 * light tone mixed towards its dark one). Warm themes get warm metals, cool themes cool ones.
 */
export function deviceTones(theme: Pick<ThemeTokens, 'colors'>, finish: DeviceFinish): DeviceTones {
  const { dark, light } = darkLight(theme);
  const night = nightTone(theme);
  const glass = mixColors(night, dark, 0.35);
  if (finish === 'light') {
    const body = mixColors(light, dark, 0.2);
    return {
      glass,
      body,
      edge: mixColors(light, dark, 0.06),
      shade: mixColors(light, dark, 0.42),
      rim: mixColors(glass, light, 0.12),
      lens: mixColors(glass, light, 0.18),
    };
  }
  const body = mixColors(dark, light, 0.22);
  return {
    glass,
    body,
    edge: mixColors(dark, light, 0.42),
    shade: mixColors(dark, light, 0.08),
    rim: mixColors(glass, light, 0.1),
    lens: mixColors(glass, light, 0.2),
  };
}

/** Whether a colour reads as dark (relative luminance < 0.18); unknown notations count as light. */
export function isDarkColor(color: string): boolean {
  const l = luminance(color);
  return l !== undefined && l < 0.18;
}

/** A URL split for an address bar: scheme hidden, host emphasised, path quieter. */
export interface AddressParts {
  secure: boolean;
  host: string;
  /** Path + query (no fragment), "" for the root. */
  path: string;
}

/** "https://shop.example.com/catalogue?x=1#top" → {secure: true, host: "shop.example.com", path: "/catalogue?x=1"}. */
export function addressParts(url: string | undefined): AddressParts | undefined {
  if (!url) return undefined;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)/i.exec(url.trim());
  if (!m) return { secure: false, host: url.trim(), path: '' };
  const path = m[3] === '/' ? '' : m[3];
  return { secure: m[1].toLowerCase() === 'https', host: m[2], path };
}

export interface CaptionBandInput {
  /** The layout's evaluated rects (output px), when the caption is drawn in a clip. */
  rects?: { screen: { x: number; y: number; w: number; h: number } };
  /** The layout's caption rect (output px). */
  area?: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  unit: number;
  /** `over` = over the bottom of the capture; `area` = in the layout's caption rect. */
  position: 'over' | 'area';
  /** Widest band, design px. */
  maxWidth: number;
}

/** Narrowest capture a band is drawn over (design px); narrower captures (phones) use the caption area. */
export const CAPTION_BAND_MIN_SCREEN = 900;
/** Inset of the band from the bottom / sides of the capture (design px). */
export const CAPTION_BAND_INSET = 40;
/** Horizontal padding inside the band (design px). */
export const CAPTION_BAND_PAD_X = 34;

/**
 * Where studio/caption-overlay draws its band: `box` = the widest band (it shrinks to its text, centred in it, bottom
 * aligned); `over` tells whether it lies over the capture. Over the capture when asked and the capture is wide enough,
 * else in the layout's caption area, else over the bottom of the frame. The review measures captions in this box.
 */
export function captionBandBox(i: CaptionBandInput): { box: { x: number; y: number; w: number; h: number }; over: boolean } {
  const u = i.unit;
  const screen = i.rects?.screen;
  const height = 150 * u;
  if (i.position === 'over' && screen && screen.w >= CAPTION_BAND_MIN_SCREEN * u) {
    const w = Math.min(i.maxWidth * u, screen.w - 2 * CAPTION_BAND_INSET * u);
    const h = Math.min(height, screen.h * 0.4);
    return { box: { x: screen.x + (screen.w - w) / 2, y: screen.y + screen.h - CAPTION_BAND_INSET * u - h, w, h }, over: true };
  }
  if (i.area) {
    const w = Math.min(i.maxWidth * u, i.area.w);
    return { box: { x: i.area.x + (i.area.w - w) / 2, y: i.area.y, w, h: i.area.h }, over: false };
  }
  const w = Math.min(i.maxWidth * u, i.width - 2 * 120 * u);
  return { box: { x: (i.width - w) / 2, y: i.height - 64 * u - height, w, h: height }, over: true };
}
