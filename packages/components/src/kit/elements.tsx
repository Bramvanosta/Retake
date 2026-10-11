/**
 * Shared React elements for components: theme background, logo, wordmark, safe area, fitted text.
 * They read everything from the theme tokens and size everything with `unit`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import type { ThemeTokens } from '../types.js';
import { fitText } from './fit-text.js';
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

/** The wordmark image at `height` design px, or the brand name set in the display font. */
export function Wordmark(props: { theme: ThemeTokens; height: number; unit?: number; color?: string; style?: CSSProperties }): ReactNode {
  const { theme, height, unit = 1 } = props;
  const px = height * unit;
  if (theme.wordmark?.url) {
    return <Img src={theme.wordmark.url} alt={theme.wordmark.text ?? theme.brand.name ?? ''} style={{ height: px, width: 'auto', objectFit: 'contain', display: 'block', ...props.style }} />;
  }
  const text = theme.wordmark?.text ?? theme.brand.name;
  if (!text) return null;
  return (
    <span
      style={{
        fontFamily: cssFontFamily(theme.fonts.display, 'serif'),
        fontSize: px,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        color: props.color ?? theme.colors.text,
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
