/**
 * Shared React elements for components: theme background, logo, wordmark, safe area, fitted text.
 * They read everything from the theme tokens and size everything with `unit`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import type { ThemeTokens } from '../types.js';
import { fitText } from './fit-text.js';
import { fontMetrics } from './metrics.js';
import type { CapTextLayout } from './metrics.js';
import { roundTo } from './motion.js';
import type { FitTextOptions } from './fit-text.js';
import { backgroundCss, cssFontFamily, safeAreaRect } from './style.js';

const fill: CSSProperties = { position: 'absolute', inset: 0 };

/** Full-frame theme background (solid colour or gradient). */
export function Background(props: { theme: ThemeTokens; style?: CSSProperties; children?: ReactNode }): ReactNode {
  return <div style={{ ...fill, background: backgroundCss(props.theme), ...props.style }}>{props.children}</div>;
}

/**
 * The theme logo at `size` design px high. Without a logo image, a monogram (the brand initial on the accent colour)
 * stands in when the brand has a name; otherwise nothing is drawn.
 */
export function Logo(props: { theme: ThemeTokens; size: number; unit?: number; style?: CSSProperties }): ReactNode {
  const { theme, size, unit = 1 } = props;
  const px = size * unit;
  if (theme.logo?.url) {
    return <Img src={theme.logo.url} alt={theme.brand.name ?? ''} style={{ height: px, width: 'auto', objectFit: 'contain', display: 'block', ...props.style }} />;
  }
  const initial = [...(theme.brand.name ?? '').trim()][0];
  if (!initial) return null;
  return (
    <div
      aria-label={theme.brand.name}
      style={{
        width: px,
        height: px,
        borderRadius: px * 0.28,
        background: theme.colors.accent,
        color: theme.colors.paper,
        fontFamily: cssFontFamily(theme.fonts.display, 'serif'),
        fontSize: px * 0.6,
        lineHeight: `${px}px`,
        textAlign: 'center',
        ...props.style,
      }}
    >
      {initial.toUpperCase()}
    </div>
  );
}

/**
 * Text size of a brand name drawn as the wordmark, relative to the wordmark's visual height: a tight-cropped wordmark
 * image `height` px tall and the brand name set at `height × WORDMARK_TEXT_SCALE` in the display font look the same
 * size (the ascender band of a display face is ≈ 0.77 em).
 */
export const WORDMARK_TEXT_SCALE = 1.3;

/**
 * The wordmark at `height` design px of VISUAL height: the wordmark image that tall, or the brand name set in the
 * display font at `height × WORDMARK_TEXT_SCALE`, its baseline on the bottom of the box (so it lines up with an
 * image wordmark and centres on a logo like one).
 */
export function Wordmark(props: { theme: ThemeTokens; height: number; unit?: number; color?: string; style?: CSSProperties }): ReactNode {
  const { theme, height, unit = 1 } = props;
  const px = height * unit;
  if (theme.wordmark?.url) {
    return <Img src={theme.wordmark.url} alt={theme.wordmark.text ?? theme.brand.name ?? ''} style={{ height: px, width: 'auto', objectFit: 'contain', display: 'block', ...props.style }} />;
  }
  const text = theme.wordmark?.text ?? theme.brand.name;
  if (!text) return null;
  const size = roundTo(px * WORDMARK_TEXT_SCALE, 3);
  const m = fontMetrics({ family: theme.fonts.display, size });
  // Line box = the visual height; move the baseline (half-leading + ascent from the top) onto the bottom edge.
  const baseline = (px - (m.ascent + m.descent)) / 2 + m.ascent;
  return (
    <span
      style={{
        display: 'block',
        height: px,
        fontFamily: cssFontFamily(theme.fonts.display, 'serif'),
        fontSize: size,
        lineHeight: `${px}px`,
        whiteSpace: 'nowrap',
        color: props.color ?? theme.colors.text,
        transform: `translateY(${roundTo(px - baseline, 2)}px)`,
        ...props.style,
      }}
    >
      {text}
    </span>
  );
}

/** A full-frame box inset by the title-safe margins (`inset` = fraction of each dimension, default 0.05). */
export function SafeArea(props: { width: number; height: number; inset?: number; style?: CSSProperties; children?: ReactNode }): ReactNode {
  const r = safeAreaRect(props.width, props.height, props.inset);
  return <div style={{ position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h, ...props.style }}>{props.children}</div>;
}

export interface FitTextProps extends Omit<FitTextOptions, 'text' | 'measure'> {
  text: string;
  color?: string;
  align?: 'left' | 'center' | 'right';
  style?: CSSProperties;
}

/** Text drawn at the largest size that fits its box (never overflows: cut with "…" below the minimum size). */
export function FitText(props: FitTextProps): ReactNode {
  const { text, color, align = 'left', style, ...opts } = props;
  const lineHeight = opts.lineHeight ?? 1.15;
  const r = fitText({ text, ...opts, lineHeight });
  return (
    <div
      style={{
        fontFamily: cssFontFamily(opts.fontFamily),
        fontWeight: opts.fontWeight,
        fontStyle: opts.fontStyle,
        fontSize: r.fontSize,
        lineHeight,
        letterSpacing: opts.letterSpacing !== undefined ? `${opts.letterSpacing}em` : undefined,
        color,
        textAlign: align,
        width: opts.width,
        ...style,
      }}
    >
      {r.lines.map((line, i) => (
        <div key={i} style={{ whiteSpace: 'pre' }}>
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

export interface CapTextProps {
  /** From `capTextLayout` (the fitted lines, size and cap offsets). */
  layout: CapTextLayout;
  /** Left edge (align left), centre (align center) or right edge (align right) of the text, px. */
  x: number;
  /** Where the cap top of the first line goes, px. */
  capTop: number;
  align?: 'left' | 'center' | 'right';
  color?: string;
  style?: CSSProperties;
}

/**
 * Text placed by its cap band (absolute, in the parent's coordinates): the first line's cap top at `capTop`, whatever
 * the font's ascent/descent. Centred text with letter-spacing is shifted by half the trailing spacing so it looks
 * centred.
 */
export function CapText(props: CapTextProps): ReactNode {
  const { layout: l, x, capTop, align = 'left', color, style } = props;
  const ls = l.font.letterSpacing ?? 0;
  const box = Math.ceil(l.width + 2 * Math.abs(ls) * l.fontSize + 4);
  const left = align === 'left' ? x : align === 'center' ? x - box / 2 : x - box;
  return (
    <div
      style={{
        position: 'absolute',
        left: roundTo(left, 2),
        top: roundTo(capTop + l.boxOffset, 2),
        width: box,
        fontFamily: cssFontFamily(l.font.family),
        fontWeight: l.font.weight,
        fontStyle: l.font.style,
        fontSize: l.fontSize,
        lineHeight: `${roundTo(l.lineHeightPx, 3)}px`,
        letterSpacing: ls ? `${ls}em` : undefined,
        textIndent: align === 'center' && ls ? `${ls}em` : undefined,
        textAlign: align,
        whiteSpace: 'pre',
        color,
        ...style,
      }}
    >
      {l.lines.map((line, i) => (
        <div key={i}>{line || ' '}</div>
      ))}
    </div>
  );
}
