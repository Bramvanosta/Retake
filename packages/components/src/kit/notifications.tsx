/**
 * System-style notifications (L2.9): one drawing per style — macOS, Windows, iOS banner, Android heads-up and an in-app
 * toast in the theme's own look — plus where each style sits (`notificationBox`) and how it enters and leaves
 * (`notificationMotion`). Shared by studio/notification, studio/mail-notification and studio/phone-lockscreen.
 *
 * Everything is theme-driven: the body font, the theme's dark / light tones for the light and dark appearances, the
 * accent for the in-app toast and the Android tonal surface, the theme logo as the app icon when none is given. The OS
 * looks are neutral system mock-ups (no OS brand marks).
 */
import type { CSSProperties, ReactNode } from 'react';
import { Img } from './renderer.js';
import type { LayoutRects, ThemeTokens } from '../types.js';
import { Logo } from './elements.js';
import { fitText } from './fit-text.js';
import { clamp, progress, roundTo } from './motion.js';
import { cssFontFamily, darkLight, isDarkBackground, mixColors, nightTone, readableOn, withAlpha } from './style.js';

export type NotificationStyle = 'macos' | 'windows' | 'ios-banner' | 'android' | 'in-app';
export const NOTIFICATION_STYLES: readonly NotificationStyle[] = ['macos', 'windows', 'ios-banner', 'android', 'in-app'];
export type NotificationPlace = 'auto' | 'frame' | 'screen';
export type NotificationAppearance = 'auto' | 'light' | 'dark';

/** Widest card of each style (design px) — mirrored by the `anchor` expressions of the notification manifests. */
export const NOTIFICATION_WIDTH: Readonly<Record<NotificationStyle, number>> = { macos: 430, windows: 380, 'ios-banner': 520, android: 560, 'in-app': 440 };
/** Margin from the edge of the area it sits in (design px). */
export const NOTIFICATION_INSET: Readonly<Record<NotificationStyle, number>> = { macos: 20, windows: 16, 'ios-banner': 14, android: 14, 'in-app': 24 };

export interface NotificationContent {
  /** App name (Windows / Android headers; iOS when there is no title). */
  app?: string;
  title?: string;
  /** Second bold line (a mail subject). */
  subtitle?: string;
  body?: string;
  /** "now", "9:41"… */
  time?: string;
  /** Icon image URL; else `glyph`, else the theme logo. */
  icon?: string;
  glyph?: 'mail';
}

export interface NotificationText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
  weight: number;
}

/** Measured layout of one notification card (output px). */
export interface NotificationLayout {
  style: NotificationStyle;
  w: number;
  h: number;
  pad: number;
  icon: number;
  radius: number;
  header?: number;
  title?: NotificationText;
  subtitle?: NotificationText;
  body?: NotificationText;
  /** Left of the text column. */
  textX: number;
  textW: number;
  unit: number;
}

function text(t: string | undefined, width: number, size: number, weight: number, maxLines: number, family: string, unit: number): NotificationText | undefined {
  if (!t || !t.trim()) return undefined;
  const lineHeight = 1.3;
  const r = fitText({ text: t.trim(), width, maxFontSize: size * unit, minFontSize: size * unit * 0.86, maxLines, lineHeight, fontFamily: family, fontWeight: weight });
  return { lines: r.lines, fontSize: r.fontSize, lineHeight, weight };
}

const textH = (t?: NotificationText) => (t ? t.lines.length * t.fontSize * t.lineHeight : 0);

/** Lay a notification out for `style` at most `maxWidth` output px wide. */
export function layoutNotification(style: NotificationStyle, c: NotificationContent, theme: ThemeTokens, unit: number, maxWidth?: number): NotificationLayout {
  const u = unit;
  const w = Math.min(NOTIFICATION_WIDTH[style] * u, maxWidth ?? Infinity);
  const font = theme.fonts.body;
  const title = c.title ?? (style === 'ios-banner' || style === 'macos' ? c.app : undefined);
  if (style === 'windows') {
    const pad = 16 * u;
    const header = 34 * u;
    const icon = 48 * u;
    const textX = pad + icon + 14 * u;
    const textW = w - textX - pad;
    const t = text(title, textW, 15, 600, 2, font, u);
    const st = text(c.subtitle, textW, 14, 600, 1, font, u);
    const b = text(c.body, textW, 14, 400, 3, font, u);
    const content = Math.max(icon, textH(t) + textH(st) + textH(b) + 2 * u);
    return { style, w, h: header + content + pad + 4 * u, pad, icon, radius: 8 * u, header, title: t, subtitle: st, body: b, textX, textW, unit: u };
  }
  if (style === 'android') {
    const pad = 18 * u;
    const header = 26 * u;
    const icon = 44 * u;
    const textX = pad;
    const textW = w - 2 * pad - (c.icon ? icon + 12 * u : 0);
    const t = text(title, textW, 17, 600, 1, font, u);
    const st = text(c.subtitle, textW, 15, 600, 1, font, u);
    const b = text(c.body, textW, 15, 400, 2, font, u);
    return { style, w, h: pad + header + 6 * u + textH(t) + textH(st) + textH(b) + pad, pad, icon, radius: 24 * u, header, title: t, subtitle: st, body: b, textX, textW, unit: u };
  }
  if (style === 'in-app') {
    const pad = 18 * u;
    const icon = c.icon || c.glyph ? 36 * u : 0;
    const textX = 6 * u + pad + (icon ? icon + 14 * u : 0);
    const textW = w - textX - pad;
    const t = text(title, textW, 17, 600, 2, font, u);
    const st = text(c.subtitle, textW, 15, 600, 1, font, u);
    const b = text(c.body, textW, 15, 400, 3, font, u);
    const content = Math.max(icon, textH(t) + textH(st) + textH(b) + 2 * u);
    return { style, w, h: content + 2 * pad, pad, icon, radius: 12 * u, title: t, subtitle: st, body: b, textX, textW, unit: u };
  }
  // macOS and iOS: icon left, title + time on the first line, subtitle, body.
  const ios = style === 'ios-banner';
  const pad = (ios ? 16 : 15) * u;
  const icon = (ios ? 42 : 44) * u;
  const textX = pad + icon + 13 * u;
  const timeW = 46 * u;
  const textW = w - textX - pad;
  const t = text(title, textW - timeW, 17, 600, 1, font, u);
  const st = text(c.subtitle, textW, 16, 600, 1, font, u);
  const b = text(c.body, textW, 16, 400, 2, font, u);
  const content = Math.max(icon, textH(t) + textH(st) + textH(b));
  return { style, w, h: content + 2 * pad, pad, icon, radius: (ios ? 24 : 18) * u, title: t, subtitle: st, body: b, textX, textW, unit: u };
}

/** The style's area: the frame (desktop notifications) or the capture's screen rect (phone banners, in-app toasts). */
export function notificationArea(style: NotificationStyle, place: NotificationPlace, width: number, height: number, rects?: LayoutRects): { x: number; y: number; w: number; h: number } {
  const onScreen = place === 'screen' || (place === 'auto' && (style === 'ios-banner' || style === 'android' || style === 'in-app'));
  if (onScreen && rects?.screen) return rects.screen;
  return { x: 0, y: 0, w: width, h: height };
}

/**
 * Where the card sits (output px): macOS and in-app at the top right, Windows at the bottom right, iOS and Android at
 * the top centre of their area. Mirrors the manifests' `anchor` (heights are the measured ones here).
 */
export function notificationBox(layout: NotificationLayout, place: NotificationPlace, width: number, height: number, rects?: LayoutRects): { x: number; y: number; w: number; h: number } {
  const s = layout.style;
  const a = notificationArea(s, place, width, height, rects);
  const inset = NOTIFICATION_INSET[s] * layout.unit;
  const w = Math.min(layout.w, a.w - 2 * inset);
  const right = s === 'macos' || s === 'windows' || s === 'in-app';
  const x = right ? a.x + a.w - inset - w : a.x + (a.w - w) / 2;
  const y = s === 'windows' ? a.y + a.h - inset - layout.h : a.y + inset;
  return { x: roundTo(x, 2), y: roundTo(y, 2), w: roundTo(w, 2), h: roundTo(layout.h, 2) };
}

/**
 * Entrance and exit of a notification (`frame` in the component's frames): macOS and in-app slide in from the right,
 * Windows rises from the bottom, iOS and Android drop from the top with a small scale settle; all leave the way they
 * came over the last 0.35 s. `pace` > 1 slows the entrance (style_bias).
 */
export function notificationMotion(style: NotificationStyle, frame: number, fps: number, durationInFrames: number, unit: number, pace = 1): { opacity: number; transform: string } {
  const enter = progress(frame, fps, { duration: 0.5 * pace, ease: 'entrance' });
  const leave = progress(frame, fps, { delay: durationInFrames / fps - 0.35, duration: 0.35, ease: 'easeIn' });
  const k = enter * (1 - leave);
  const opacity = roundTo(clamp(Math.min(enter * 1.6, 1) * (1 - leave)), 4);
  const away = 1 - k;
  if (style === 'macos' || style === 'in-app') return { opacity, transform: `translateX(${roundTo(away * 440 * unit, 2)}px)` };
  if (style === 'windows') return { opacity, transform: `translateY(${roundTo(away * 120 * unit, 2)}px)` };
  return { opacity, transform: `translateY(${roundTo(-away * 120 * unit, 2)}px) scale(${roundTo(0.96 + 0.04 * k, 4)})` };
}

/** Colours of a card for its style and appearance (auto: dark on a dark theme background). */
export function notificationTones(style: NotificationStyle, theme: ThemeTokens, appearance: NotificationAppearance) {
  const { dark, light } = darkLight(theme);
  const isDark = appearance === 'dark' || (appearance === 'auto' && isDarkBackground(theme));
  const night = nightTone(theme);
  if (style === 'in-app') {
    const bg = theme.colors.paper;
    const ink = readableOn(bg, theme.colors.text, dark, 4.5);
    return { bg, ink, muted: readableOn(bg, theme.colors.muted, ink, 3), border: withAlpha(ink, 0.08), accent: readableOn(bg, theme.colors.accent, ink, 2.6), shadow: withAlpha(night, 0.22) };
  }
  if (style === 'android') {
    const bg = isDark ? mixColors(night, theme.colors.accent, 0.12) : mixColors('#fbfaf9', theme.colors.accent, 0.07);
    const ink = isDark ? '#f2f0ef' : '#1d1b1a';
    return { bg, ink, muted: withAlpha(ink, 0.66), border: 'transparent', accent: theme.colors.accent, shadow: withAlpha(night, 0.26) };
  }
  const bg = isDark ? (style === 'windows' ? '#2c2c2c' : 'rgba(44, 44, 48, 0.96)') : style === 'windows' ? '#f3f3f3' : 'rgba(248, 248, 250, 0.97)';
  const ink = isDark ? '#f5f5f7' : '#1d1d1f';
  void light;
  return { bg, ink, muted: withAlpha(ink, 0.58), border: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.09)', accent: theme.colors.accent, shadow: withAlpha(night, 0.24) };
}

/** A rounded app icon: an image, a mail glyph on the accent, or the theme logo on the paper. */
export function AppIcon(props: { theme: ThemeTokens; size: number; url?: string; glyph?: 'mail'; radius?: number; style?: CSSProperties }): ReactNode {
  const { theme, size, url, glyph } = props;
  const radius = props.radius ?? size * 0.225;
  const base: CSSProperties = { width: size, height: size, borderRadius: radius, overflow: 'hidden', flex: 'none', position: 'relative', ...props.style };
  if (url) return <Img src={url} style={{ ...base, objectFit: 'cover', display: 'block' }} />;
  if (glyph === 'mail') {
    const a = theme.colors.accent;
    const top = mixColors(a, '#ffffff', 0.28);
    return (
      <div style={{ ...base, background: `linear-gradient(180deg, ${top} 0%, ${a} 100%)` }}>
        <svg viewBox="0 0 24 24" width={size} height={size} style={{ position: 'absolute', inset: 0 }}>
          <rect x="4.2" y="6.6" width="15.6" height="10.8" rx="1.6" fill="#ffffff" />
          <path d="M4.6 7.4 L12 12.9 L19.4 7.4" fill="none" stroke={a} strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }
  const { dark, light } = darkLight(theme);
  return (
    <div style={{ ...base, background: light, boxShadow: `inset 0 0 0 ${Math.max(0.5, size * 0.02)}px ${withAlpha(dark, 0.1)}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Logo theme={theme} size={size * 0.62} />
    </div>
  );
}

function Lines({ t, color, style }: { t?: NotificationText; color: string; style?: CSSProperties }): ReactNode {
  if (!t) return null;
  return (
    <div style={{ fontSize: t.fontSize, lineHeight: `${roundTo(t.fontSize * t.lineHeight, 2)}px`, fontWeight: t.weight, color, whiteSpace: 'pre', ...style }}>
      {t.lines.map((l, i) => (
        <div key={i}>{l || ' '}</div>
      ))}
    </div>
  );
}

/** One notification card drawn at its layout's size (the parent positions it). */
export function NotificationCard(props: { theme: ThemeTokens; layout: NotificationLayout; content: NotificationContent; appearance?: NotificationAppearance; style?: CSSProperties }): ReactNode {
  const { theme, layout: l, content: c } = props;
  const u = l.unit;
  const tone = notificationTones(l.style, theme, props.appearance ?? 'auto');
  const font = cssFontFamily(theme.fonts.body);
  const time = c.time ?? 'now';
  const shell: CSSProperties = {
    position: 'relative',
    width: l.w,
    height: l.h,
    borderRadius: l.radius,
    background: tone.bg,
    boxShadow: `0 ${10 * u}px ${30 * u}px ${tone.shadow}, 0 ${1 * u}px ${3 * u}px ${withAlpha(nightTone(theme), 0.1)}${tone.border !== 'transparent' ? `, inset 0 0 0 ${Math.max(0.5, u)}px ${tone.border}` : ''}`,
    fontFamily: font,
    color: tone.ink,
    overflow: 'hidden',
    ...props.style,
  };
  const icon = <AppIcon theme={theme} size={l.icon} url={c.icon} glyph={c.glyph} />;
  const header = l.header ?? 0;
  if (l.style === 'windows') {
    const small = 16 * u;
    return (
      <div style={shell}>
        <div style={{ position: 'absolute', left: l.pad, right: l.pad, top: 0, height: header, display: 'flex', alignItems: 'center', gap: 8 * u, fontSize: 12.5 * u, color: tone.muted }}>
          <AppIcon theme={theme} size={small} url={c.icon} glyph={c.glyph} radius={3 * u} />
          <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>{c.app ?? theme.brand.name ?? ''}</span>
          <span style={{ letterSpacing: '0.1em' }}>···</span>
          <svg width={12 * u} height={12 * u} viewBox="0 0 12 12" style={{ marginLeft: 10 * u }}>
            <path d="M2 2 L10 10 M10 2 L2 10" stroke={tone.muted} strokeWidth="1.2" />
          </svg>
        </div>
        <div style={{ position: 'absolute', left: l.pad, top: header + 2 * u }}>{icon}</div>
        <div style={{ position: 'absolute', left: l.textX, top: header, width: l.textW }}>
          <Lines t={l.title} color={tone.ink} />
          <Lines t={l.subtitle} color={tone.ink} />
          <Lines t={l.body} color={tone.muted} />
        </div>
      </div>
    );
  }
  if (l.style === 'android') {
    const small = 18 * u;
    return (
      <div style={shell}>
        <div style={{ position: 'absolute', left: l.pad, right: l.pad, top: l.pad, height: header, display: 'flex', alignItems: 'center', gap: 8 * u, fontSize: 13 * u, color: tone.muted }}>
          <div style={{ width: small, height: small, borderRadius: small / 2, background: tone.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {c.glyph === 'mail' ? (
              <svg viewBox="0 0 24 24" width={small * 0.8} height={small * 0.8}>
                <rect x="4" y="6.5" width="16" height="11" rx="1.6" fill="#ffffff" />
              </svg>
            ) : (
              <div style={{ width: small * 0.36, height: small * 0.36, borderRadius: small, background: '#ffffff' }} />
            )}
          </div>
          <span style={{ whiteSpace: 'nowrap' }}>{c.app ?? theme.brand.name ?? ''}</span>
          <span>•</span>
          <span>{time}</span>
        </div>
        <div style={{ position: 'absolute', left: l.textX, top: l.pad + header + 6 * u, width: l.textW }}>
          <Lines t={l.title} color={tone.ink} />
          <Lines t={l.subtitle} color={tone.ink} />
          <Lines t={l.body} color={tone.muted} />
        </div>
        {c.icon ? <div style={{ position: 'absolute', right: l.pad, top: l.pad + header + 6 * u }}><AppIcon theme={theme} size={l.icon} url={c.icon} radius={l.icon / 2} /></div> : null}
      </div>
    );
  }
  if (l.style === 'in-app') {
    return (
      <div style={shell}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5 * u, background: tone.accent }} />
        {l.icon ? <div style={{ position: 'absolute', left: 6 * u + l.pad, top: l.pad }}>{icon}</div> : null}
        <div style={{ position: 'absolute', left: l.textX, top: l.pad, width: l.textW }}>
          <Lines t={l.title} color={tone.ink} />
          <Lines t={l.subtitle} color={tone.ink} />
          <Lines t={l.body} color={tone.muted} />
        </div>
      </div>
    );
  }
  return (
    <div style={shell}>
      <div style={{ position: 'absolute', left: l.pad, top: l.pad }}>{icon}</div>
      <div style={{ position: 'absolute', left: l.textX, top: l.pad, width: l.textW }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Lines t={l.title} color={tone.ink} />
          <span style={{ fontSize: (l.style === 'ios-banner' ? 14 : 13) * u, color: tone.muted, whiteSpace: 'nowrap', marginLeft: 8 * u }}>{time}</span>
        </div>
        <Lines t={l.subtitle} color={tone.ink} />
        <Lines t={l.body} color={l.style === 'ios-banner' ? tone.ink : tone.muted} />
      </div>
    </div>
  );
}

/** "now" for a moment within a minute of `at`, else "<n> min ago" / "HH:MM" — for notification times (deterministic). */
export function formatClock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}:${m[2]}` : undefined;
}
