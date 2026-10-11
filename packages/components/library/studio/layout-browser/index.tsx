import type { ReactNode } from 'react';
import {
  Background,
  SYSTEM_COLORS,
  addressParts,
  backgroundCss,
  cardShadow,
  cssFontFamily,
  darkLight,
  fitText,
  isDarkBackground,
  measureText,
  mixColors,
  nightTone,
  roundTo,
  withAlpha,
} from '@demo-studio/components/kit';
import type { ComponentProps, LayoutRects, ThemeTokens } from '@demo-studio/components/kit';

type Params = {
  width: number;
  radius: number;
  shadow: 'none' | 'soft' | 'strong';
  show_url: boolean;
  tabs: boolean;
  chrome: 'auto' | 'light' | 'dark';
  controls: 'color' | 'theme';
};

/** Chrome heights (design px): the toolbar, and the tab strip above it when `tabs`. */
export const TOOLBAR = 52;
export const TAB_STRIP = 34;

/**
 * The default rects (design px × unit) — ONLY used outside a plan (unit tests): in a plan the composition passes
 * `rects`, the manifest geometry evaluated by the planner. Mirrors component.yaml (the library test checks it).
 */
export function defaultRects(params: Pick<Params, 'width' | 'radius' | 'tabs'>, variant: 'landscape' | 'vertical', unit: number, aspect = 16 / 9): LayoutRects {
  const s = (v: number) => v * unit;
  const bar = TOOLBAR + (params.tabs ? TAB_STRIP : 0);
  if (variant === 'vertical') {
    const h = Math.min(Math.round(1000 / aspect), 1100);
    const w = Math.min(1000, Math.round(1100 * aspect));
    const x = Math.round((1080 - w) / 2);
    const y = Math.round((1688 - bar - h) / 2);
    return {
      frame: { x: s(x), y: s(y), w: s(w), h: s(bar + h) },
      chrome: { x: s(x), y: s(y), w: s(w), h: s(bar) },
      screen: { x: s(x), y: s(y + bar), w: s(w), h: s(h) },
      caption: { x: s(40), y: s(y + bar + h + 12), w: s(1000), h: s(220) },
      brandmark: { x: s(700), y: s(1840), w: s(340), h: s(40) },
      radius: s(params.radius),
    };
  }
  const maxh = 878 - bar;
  const h = Math.min(Math.round(params.width / aspect), maxh);
  const w = Math.min(params.width, Math.round(maxh * aspect));
  const x = Math.round((1920 - w) / 2);
  const y = Math.round((958 - bar - h) / 2);
  const cw = Math.max(w - 340, 640);
  const cx = Math.min(x, Math.round((1920 - cw) / 2));
  return {
    frame: { x: s(x), y: s(y), w: s(w), h: s(bar + h) },
    chrome: { x: s(x), y: s(y), w: s(w), h: s(bar) },
    screen: { x: s(x), y: s(y + bar), w: s(w), h: s(h) },
    caption: { x: s(cx), y: s(y + bar + h + 12), w: s(cw), h: s(110) },
    brandmark: { x: s(Math.max(x + w - 320, cx + cw + 20)), y: s(y + bar + h + 47), w: s(320), h: s(40) },
    radius: s(params.radius),
  };
}

interface Tones {
  dark: boolean;
  toolbar: string;
  strip: string;
  field: string;
  ink: string;
  quiet: string;
  hairline: string;
}

/** Toolbar colours from the theme: a light chrome is the theme's light tone, a dark one its night tone lifted a little. */
function tones(theme: ThemeTokens, chrome: Params['chrome']): Tones {
  const { dark, light } = darkLight(theme);
  const isDark = chrome === 'dark' || (chrome === 'auto' && isDarkBackground(theme));
  if (isDark) {
    const base = mixColors(nightTone(theme), light, 0.07);
    return {
      dark: true,
      toolbar: base,
      strip: mixColors(base, dark, 0.45),
      field: mixColors(base, light, 0.09),
      ink: mixColors(light, base, 0.08),
      quiet: mixColors(light, base, 0.45),
      hairline: withAlpha(light, 0.1),
    };
  }
  return {
    dark: false,
    toolbar: mixColors(light, dark, 0.025),
    strip: mixColors(light, dark, 0.075),
    field: mixColors(light, dark, 0.065),
    ink: mixColors(dark, light, 0.06),
    quiet: mixColors(dark, light, 0.5),
    hairline: withAlpha(dark, 0.11),
  };
}

/** A stroked icon on a 24-unit grid. */
function Icon({ d, size, color, stroke = 1.8 }: { d: string; size: number; color: string; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flex: 'none' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICONS = {
  back: 'M15 5l-7 7 7 7',
  forward: 'M9 5l7 7-7 7',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z',
  reload: 'M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4',
  share: 'M12 15V4M8 8l4-4 4 4M6 12v8h12v-8',
  plus: 'M12 5v14M5 12h14',
  sidebar: 'M4 5h16v14H4zM10 5v14',
};

function Controls({ size, gap, mode, t }: { size: number; gap: number; mode: Params['controls']; t: Tones }) {
  const colours =
    mode === 'theme'
      ? [withAlpha(t.ink, 0.22), withAlpha(t.ink, 0.16), withAlpha(t.ink, 0.12)]
      : [SYSTEM_COLORS.close, SYSTEM_COLORS.minimize, SYSTEM_COLORS.zoom];
  return (
    <div style={{ display: 'flex', gap, flex: 'none' }}>
      {colours.map((c, i) => (
        <span key={i} style={{ width: size, height: size, borderRadius: size / 2, background: c, boxShadow: `inset 0 0 0 ${Math.max(0.5, size / 24)}px ${withAlpha(t.dark ? t.toolbar : t.ink, 0.12)}`, display: 'block' }} />
      ))}
    </div>
  );
}

/** The address field: lock + host (emphasised) + path (quieter), centred, cut with "…" when too long. */
function Address({ url, width, height, u, t, font }: { url: string | undefined; width: number; height: number; u: number; t: Tones; font: string }) {
  const parts = addressParts(url);
  const size = 15 * u;
  const lock = parts?.secure ? 14 * u : 0;
  const reload = 15 * u;
  const pad = 14 * u;
  const room = width - 2 * pad - (lock ? lock + 7 * u : 0) - reload - 10 * u;
  let host = parts?.host ?? '';
  let path = parts?.path ?? '';
  const font400 = { family: font, size, weight: 400 };
  const font500 = { family: font, size, weight: 500 };
  const hostW = measureText(host, font500);
  if (hostW > room) {
    host = fitText({ text: host, width: room, maxFontSize: size, minFontSize: size, fontFamily: font, fontWeight: 500 }).lines[0] ?? '';
    path = '';
  } else if (path) {
    const left = room - hostW;
    path = left > 30 * u ? (fitText({ text: path, width: left, maxFontSize: size, minFontSize: size, fontFamily: font }).lines[0] ?? '') : '';
    if (measureText(path, font400) > left) path = '';
  }
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 9 * u,
        background: t.field,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7 * u,
        padding: `0 ${pad}px`,
        boxSizing: 'border-box',
        position: 'relative',
        fontFamily: cssFontFamily(font),
        fontSize: size,
        whiteSpace: 'pre',
      }}
    >
      {lock ? <Icon d={ICONS.lock} size={lock} color={t.quiet} stroke={2} /> : null}
      <span style={{ color: t.ink, fontWeight: 500 }}>{host}</span>
      {path ? <span style={{ color: t.quiet, marginLeft: -7 * u }}>{path}</span> : null}
      <div style={{ position: 'absolute', right: 10 * u, top: (height - reload) / 2 }}>
        <Icon d={ICONS.reload} size={reload} color={t.quiet} stroke={2} />
      </div>
    </div>
  );
}

/**
 * The capture in a macOS-style browser window at the planner's rects: the chrome bar (`rects.chrome`: traffic lights,
 * back / forward, an address field with the clip's real URL, share / new-tab icons; with `tabs` a tab strip above),
 * the page below it, the reference soft shadow and a hairline edge. Every colour comes from the theme (the classic
 * window controls are system colours, `controls: theme` tints them). Static at every style_bias: a frame never moves
 * on its own.
 */
export default function LayoutBrowser({ theme, params, unit, variant, screen, url, rects }: ComponentProps<Params>) {
  const u = unit;
  const r = rects ?? defaultRects(params, variant, u);
  const win = r.frame;
  const bar = r.chrome ? r.chrome.h : (TOOLBAR + (params.tabs ? TAB_STRIP : 0)) * u;
  const strip = params.tabs ? Math.min(TAB_STRIP * u, bar / 2) : 0;
  const toolbar = bar - strip;
  const t = tones(theme, params.chrome);
  const font = theme.fonts.body;
  const page = r.display ?? { x: win.x, y: win.y + bar, w: win.w, h: win.h - bar };
  const shot = r.screen;
  const fieldW = Math.min(win.w * 0.46, 760 * u);
  const fieldH = 32 * u;
  const host = addressParts(url)?.host ?? theme.brand.url ?? '';
  const iconSize = 18 * u;
  const showIcons = win.w >= 700 * u;

  return (
    <Background theme={theme}>
      <div
        style={{
          position: 'absolute',
          left: win.x,
          top: win.y,
          width: win.w,
          height: win.h,
          borderRadius: r.radius,
          boxShadow: cardShadow(theme, params.shadow, u),
          background: t.toolbar,
          overflow: 'hidden',
          isolation: 'isolate',
        }}
      >
        {params.tabs ? (
          <div style={{ position: 'absolute', left: 0, top: 0, width: win.w, height: strip, background: t.strip, display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ position: 'absolute', left: 18 * u, top: (strip - 12 * u) / 2 + 2 * u }}>
              <Controls size={12 * u} gap={8 * u} mode={params.controls} t={t} />
            </div>
            <div
              style={{
                marginLeft: 92 * u,
                width: Math.min(260 * u, win.w * 0.3),
                height: strip - 6 * u,
                borderRadius: `${8 * u}px ${8 * u}px 0 0`,
                background: t.toolbar,
                display: 'flex',
                alignItems: 'center',
                gap: 8 * u,
                padding: `0 ${12 * u}px`,
                boxSizing: 'border-box',
                fontFamily: cssFontFamily(font),
                fontSize: 13 * u,
                fontWeight: 500,
                color: t.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              <span style={{ width: 14 * u, height: 14 * u, borderRadius: 4 * u, background: withAlpha(theme.colors.accent, 0.85), flex: 'none' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{host}</span>
            </div>
            <div style={{ marginLeft: 8 * u, marginBottom: 6 * u }}>
              <Icon d={ICONS.plus} size={15 * u} color={t.quiet} />
            </div>
          </div>
        ) : null}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: strip,
            width: win.w,
            height: toolbar,
            display: 'flex',
            alignItems: 'center',
            boxSizing: 'border-box',
            padding: `0 ${18 * u}px`,
            gap: 14 * u,
            borderBottom: `${Math.max(1, u)}px solid ${t.hairline}`,
          }}
        >
          {params.tabs ? null : <Controls size={12 * u} gap={8 * u} mode={params.controls} t={t} />}
          {showIcons ? (
            <div style={{ display: 'flex', gap: 10 * u, marginLeft: params.tabs ? 0 : 10 * u }}>
              <Icon d={ICONS.back} size={iconSize} color={t.quiet} stroke={2} />
              <Icon d={ICONS.forward} size={iconSize} color={withAlpha(t.quiet, 0.55)} stroke={2} />
            </div>
          ) : null}
          <div style={{ position: 'absolute', left: (win.w - fieldW) / 2, top: (toolbar - fieldH) / 2 }}>
            {params.show_url ? <Address url={url} width={fieldW} height={fieldH} u={u} t={t} font={font} /> : <div style={{ width: fieldW, height: fieldH, borderRadius: 9 * u, background: t.field }} />}
          </div>
          {showIcons ? (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 16 * u }}>
              <Icon d={ICONS.share} size={iconSize} color={t.quiet} />
              <Icon d={ICONS.plus} size={iconSize} color={t.quiet} />
              <Icon d={ICONS.sidebar} size={iconSize} color={t.quiet} />
            </div>
          ) : null}
        </div>
        {/* The page area: the theme background shows where a capture of another aspect leaves room. */}
        <div style={{ position: 'absolute', left: page.x - win.x, top: page.y - win.y, width: page.w, height: page.h, background: backgroundCss(theme), overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: roundTo(shot.x - page.x, 3), top: roundTo(shot.y - page.y, 3), width: shot.w, height: shot.h }}>
            {screen ? (screen as ReactNode) : null}
          </div>
        </div>
      </div>
      {/* Hairline edge on top of everything (a window reads as a window on any background). */}
      <div style={{ position: 'absolute', left: win.x, top: win.y, width: win.w, height: win.h, borderRadius: r.radius, boxShadow: `inset 0 0 0 ${Math.max(1, u)}px ${t.hairline}`, pointerEvents: 'none' }} />
    </Background>
  );
}
