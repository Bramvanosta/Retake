import { Img, useCurrentFrame } from 'remotion';
import {
  Background,
  SYSTEM_COLORS,
  CapText,
  biasMotion,
  backgroundSample,
  capTextLayout,
  clamp,
  darkLight,
  easing,
  formatMetrics,
  nightTone,
  progress,
  readableOn,
  roundTo,
  withAlpha,
} from '@retake/components/kit';
import type { ComponentProps, DocumentMedia } from '@retake/components/kit';

type Params = { motion: 'zoom' | 'scroll' | 'static'; pages: string; focus: 'top' | 'center' | 'bottom'; zoom: number; shadow: 'soft' | 'strong' };

type Page = { url?: string; w: number; h: number; number: number };

/** A4 in points. */
const A4 = { w: 595.28, h: 841.89 };

/** Page numbers (1-based) selected by a `pages` param among `count` pages. */
export function selectPages(spec: string, count: number, motion: Params['motion']): number[] {
  const all = Array.from({ length: count }, (_, i) => i + 1);
  const s = spec.trim().toLowerCase();
  if (s === 'all' || (s === 'auto' && motion === 'scroll')) return all;
  if (s === 'auto' || s === '') return count > 0 ? [1] : [];
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) if (n >= 1 && n <= count && !out.includes(n)) out.push(n);
  }
  return out.length ? out : count > 0 ? [1] : [];
}

/** A neutral sheet (no document): a header rule in the accent and quiet text lines. */
function BlankSheet({ w, h, ink, accent }: { w: number; h: number; ink: string; accent: string }) {
  const rows = Array.from({ length: 14 }, (_, i) => i);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: w * 0.1, top: h * 0.07, width: w * 0.32, height: h * 0.022, background: withAlpha(accent, 0.85), borderRadius: 2 }} />
      <div style={{ position: 'absolute', left: w * 0.1, right: w * 0.1, top: h * 0.12, height: Math.max(1, h * 0.002), background: withAlpha(ink, 0.25) }} />
      {rows.map((i) => (
        <div key={i} style={{ position: 'absolute', left: w * 0.1, top: h * (0.17 + i * 0.045), width: w * (i % 5 === 4 ? 0.45 : 0.8 - (i % 3) * 0.06), height: h * 0.011, background: withAlpha(ink, 0.12), borderRadius: 2 }} />
      ))}
    </div>
  );
}

/**
 * The page(s) of a document on the theme background with a paper shadow. zoom: one page settles, then pushes in
 * slowly towards `focus`; scroll: the selected pages stacked, scrolled eased from the top of the first to the bottom of
 * the last; static: one page (or two side by side). Optional kicker + title on the left.
 */
export default function DocumentPdf({ theme, slots, params, unit, width, height, fps, durationInFrames, variant, media }: ComponentProps<Params>) {
  const frame = useCurrentFrame();
  const { u, inset } = formatMetrics(variant, unit);
  const bias = biasMotion(theme.style_bias);
  const doc: DocumentMedia | undefined = media?.document?.kind === 'document' ? media.document : undefined;
  const all: Page[] = doc?.pages.length ? doc.pages.map((p) => ({ url: p.url, w: p.width_pt, h: p.height_pt, number: p.number })) : [{ w: A4.w, h: A4.h, number: 1 }];
  const chosen = selectPages(params.pages, all.length, params.motion).map((n) => all[n - 1]);
  const pages = params.motion === 'static' ? chosen.slice(0, 2) : params.motion === 'zoom' ? chosen.slice(0, 1) : chosen.slice(0, 8);
  const { dark } = darkLight(theme);
  const bg = backgroundSample(theme);
  const ink = readableOn(bg, theme.colors.text, dark, 4.5);
  const accent = readableOn(bg, theme.colors.accent, ink, 2.6);
  const night = nightTone(theme);
  const shadowA = params.shadow === 'strong' ? 0.3 : 0.18;
  const paperShadow = `0 ${30 * unit}px ${70 * unit}px ${withAlpha(night, shadowA)}, 0 ${4 * unit}px ${12 * unit}px ${withAlpha(night, shadowA * 0.6)}, 0 0 0 ${Math.max(0.5, unit)}px ${withAlpha(night, 0.08)}`;

  // Text column (landscape / square) or none.
  const hasText = !!(slots.title || slots.kicker) && variant !== 'vertical';
  const margin = inset(110);
  const textW = hasText ? Math.min(560 * u, width * 0.34) : 0;
  const gap = hasText ? 90 * u : 0;
  const areaX = margin + textW + gap;
  const areaW = width - areaX - margin;
  const vMargin = (variant === 'vertical' ? 160 : 70) * unit;
  const areaH = height - 2 * vMargin;

  const enter = progress(frame, fps, { duration: 0.6 * bias.pace, ease: 'entrance' });
  const textIn = progress(frame, fps, { delay: 0.25, duration: 0.5 * bias.pace, ease: 'entrance' });
  const rise = roundTo((1 - enter) * 30 * bias.travel * unit, 2);
  const T = durationInFrames / fps;

  const sheet = (p: Page, w: number, h: number, key: string, style: Record<string, unknown> = {}) => (
    <div key={key} style={{ position: 'absolute', width: w, height: h, background: SYSTEM_COLORS.page, boxShadow: paperShadow, overflow: 'hidden', ...style }}>
      {p.url ? <Img src={p.url} style={{ width: w, height: h, display: 'block' }} /> : <BlankSheet w={w} h={h} ink={dark} accent={theme.colors.accent} />}
    </div>
  );

  let content;
  if (params.motion === 'scroll') {
    const pw = Math.min(areaW * 0.86, 820 * u);
    const g = 34 * u;
    const heights = pages.map((p) => (pw * p.h) / p.w);
    const total = heights.reduce((a, b) => a + b, 0) + g * (pages.length - 1);
    const travel = Math.max(0, total - areaH);
    const sp = easing('easeInOut')(clamp((frame / fps - 0.9) / Math.max(0.5, T - 1.6)));
    let y = vMargin + (total < areaH ? (areaH - total) / 2 : 0) - travel * sp + rise;
    const left = areaX + (areaW - pw) / 2;
    content = pages.map((p, i) => {
      const top = y;
      y += heights[i] + g;
      return sheet(p, pw, heights[i], `p${p.number}`, { left, top: roundTo(top, 2) });
    });
  } else {
    // One page (zoom / static) or a spread (static, two pages).
    const n = pages.length;
    const g = 40 * u;
    const ratio = pages.reduce((a, p) => a + p.w / p.h, 0);
    const ph = Math.min(areaH, (areaW - g * (n - 1)) / ratio);
    const widths = pages.map((p) => (ph * p.w) / p.h);
    const total = widths.reduce((a, b) => a + b, 0) + g * (n - 1);
    let x = areaX + (areaW - total) / 2;
    const top = vMargin + (areaH - ph) / 2;
    const zp = params.motion === 'zoom' ? easing('easeInOut')(clamp((frame / fps - 0.5) / Math.max(0.5, T - 0.7))) : 0;
    const scale = roundTo(1 + (params.zoom - 1) * zp * Math.min(1.4, bias.travel), 5);
    const oy = params.focus === 'top' ? '22%' : params.focus === 'bottom' ? '80%' : '50%';
    content = (
      <div style={{ position: 'absolute', inset: 0, transform: `translateY(${rise}px) scale(${scale})`, transformOrigin: `${roundTo(areaX + areaW / 2, 1)}px ${oy}` }}>
        {pages.map((p, i) => {
          const el = sheet(p, widths[i], ph, `p${p.number}`, { left: roundTo(x, 2), top: roundTo(top, 2) });
          x += widths[i] + g;
          return el;
        })}
      </div>
    );
  }

  const kicker = hasText && slots.kicker
    ? capTextLayout({ text: slots.kicker, width: textW, maxFontSize: 18 * u, minFontSize: 12 * u, maxLines: 1, lineHeight: 1.2, fontFamily: theme.fonts.body, fontWeight: 600, letterSpacing: 0.18, uppercase: true })
    : null;
  const title = hasText && slots.title
    ? capTextLayout({ text: slots.title, width: textW, maxFontSize: 60 * u, minFontSize: 34 * u, maxLines: 3, lineHeight: 1.08, fontFamily: theme.fonts.display, letterSpacing: -0.01 })
    : null;
  const stack = (kicker ? kicker.capHeight + 30 * u : 0) + (title ? title.band : 0);
  const textTop = height / 2 - stack / 2;

  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, opacity: roundTo(Math.min(1, enter * 1.5), 4) }}>{content}</div>
      {hasText ? (
        <div style={{ position: 'absolute', inset: 0, opacity: roundTo(textIn, 4), transform: `translateY(${roundTo((1 - textIn) * 10 * bias.travel * u, 2)}px)` }}>
          {kicker ? <CapText layout={kicker} x={margin} capTop={textTop} color={accent} /> : null}
          {title ? <CapText layout={title} x={margin} capTop={textTop + (kicker ? kicker.capHeight + 30 * u : 0)} color={ink} /> : null}
          <div style={{ position: 'absolute', left: margin, top: roundTo(textTop + stack + 34 * u, 2), width: 90 * u, height: 2 * u, background: accent }} />
        </div>
      ) : null}
    </Background>
  );
}
