/**
 * Shared React elements for components: theme background, logo, wordmark, safe area, fitted text.
 * They read everything from the theme tokens and size everything with `unit`.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Img } from './renderer.js';
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

/** What the theme's logo is: a `wordmark` (the brand name as an image: drawn alone, sized by its width) or a `mark`. */
export function logoKind(theme: Pick<ThemeTokens, 'logo'>): 'mark' | 'wordmark' {
  return theme.logo?.url && theme.logo.kind === 'wordmark' ? 'wordmark' : 'mark';
}

/**
 * The box the theme logo is drawn in, design px: a mark `height` high (as wide as its aspect says, `undefined` when
 * unknown: the image's own); a wordmark given a `maxWidth` as wide as fits both — at most `maxWidth` wide and `height`
 * high — or, of an unknown aspect, the whole `maxWidth × height` box (the image contained in it).
 */
export function logoBox(theme: Pick<ThemeTokens, 'logo'>, height: number, maxWidth?: number): { width: number | undefined; height: number } {
  const aspect = theme.logo?.aspect;
  if (logoKind(theme) !== 'wordmark' || maxWidth === undefined) return { width: aspect !== undefined ? height * aspect : undefined, height };
  if (aspect === undefined || !(aspect > 0)) return { width: maxWidth, height };
  const width = Math.min(maxWidth, height * aspect);
  return { width, height: width / aspect };
}

/**
 * The theme for a component's `logo` slot: the theme itself when the slot is empty or holds the theme's own logo (its
 * kind and aspect kept), else the slot's image as a mark of unknown aspect.
 */
export function withLogo(theme: ThemeTokens, url: string | undefined): ThemeTokens {
  if (!url || url === theme.logo?.url) return theme;
  return { ...theme, logo: { url, kind: 'mark' } };
}

/**
 * The theme logo at `size` design px high — a wordmark logo (logoKind) given a `maxWidth`: within `maxWidth × size`,
 * as wide as fits (logoBox). Without a logo image, a monogram (the brand initial on the accent colour) stands in when
 * the brand has a name; otherwise nothing is drawn. `monogram` draws the initial even over a logo image (an app icon of
 * a wordmark logo).
 */
export function Logo(props: { theme: ThemeTokens; size: number; maxWidth?: number; unit?: number; monogram?: boolean; style?: CSSProperties }): ReactNode {
  const { theme, size, unit = 1 } = props;
  const px = size * unit;
  if (theme.logo?.url && !props.monogram) {
    if (logoKind(theme) === 'wordmark' && props.maxWidth !== undefined) {
      const box = logoBox(theme, size, props.maxWidth);
      return (
        <Img
          src={theme.logo.url}
          alt={theme.brand.name ?? ''}
          style={{ height: box.height * unit, width: (box.width ?? props.maxWidth) * unit, objectFit: 'contain', display: 'block', ...props.style }}
        />
      );
    }
    return <Img src={theme.logo.url} alt={theme.brand.name ?? ''} style={{ height: px, width: 'auto', objectFit: 'contain', display: 'block', ...props.style }} />;
  }
  const initial = [...(theme.brand.name ?? '').trim()][0];
  if (!initial) return null;
  return (
    <div
      role="img"
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
 * image wordmark and centres on a logo like one). Nothing beside a wordmark logo (logoKind): the logo is the name
 * already — `force` draws it all the same.
 */
export function Wordmark(props: { theme: ThemeTokens; height: number; unit?: number; color?: string; force?: boolean; style?: CSSProperties }): ReactNode {
  const { theme, height, unit = 1 } = props;
  if (logoKind(theme) === 'wordmark' && !props.force) return null;
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

/**
 * The brand mark on clips (the compositions place it): the logo `size` design px high and the wordmark at 0.8 × size
 * beside it — a wordmark logo alone (Wordmark draws nothing beside it), at most `maxWidth` wide (the mark's rect).
 */
export function BrandLockup(props: { theme: ThemeTokens; size: number; maxWidth: number; unit?: number }): ReactNode {
  const { theme, size, unit = 1 } = props;
  return (
    <>
      <Logo theme={theme} size={size} maxWidth={props.maxWidth} unit={unit} />
      <Wordmark theme={theme} height={size * 0.8} unit={unit} />
    </>
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
        // biome-ignore lint/suspicious/noArrayIndexKey: the text's wrapped lines, in order, laid out once per frame: the index is the line number
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
        // biome-ignore lint/suspicious/noArrayIndexKey: the text's wrapped lines, in order, laid out once per frame: the index is the line number
        <div key={i}>{line || ' '}</div>
      ))}
    </div>
  );
}
