/**
 * L5.13b: the "two takes" mark (declension « Nette », BACKLOG BL-124) — the previous take as an outline behind, the new
 * one in front with a play triangle, on a plate. The ONE source of its drawing: the Studio's title bar and Welcome
 * (ui-kit AppMark, coloured by the `--ui-mark-*` tokens), the favicon (bundle.ts) and the desktop app's icon files
 * (`pnpm -F @retake/ui gen:mark` → apps/desktop/icons/, a test compares them) all read `MARK`. Pure: no colour of its own
 * (a palette is passed: tokens.ts `MARK_INK` for the icon and the favicon), no DOM, no file.
 *
 * Three variants by the size the mark is seen at (a 100-unit grid, the plate 96 units with 22-unit corners):
 * - `full` (≥ 64 px: the desktop icon, Welcome) — the back take a 6-unit outline, the front take filled, the play
 *   triangle in the plate's colour;
 * - `small` (21 – 63 px: Finder's 32 pt slot) — larger frames, an 8-unit outline, no triangle;
 * - `tiny` (≤ 20 px: the favicon, the title bar, Finder's 16 pt slot) — both takes filled, no triangle.
 * (`markVariantFor` holds these bands; the docs quote them.)
 */

export type MarkVariant = 'full' | 'small' | 'tiny';
export const MARK_VARIANTS: readonly MarkVariant[] = ['full', 'small', 'tiny'];

/** The mark's three colours: the plate (also the triangle), the back take, the front take. */
export interface MarkPalette {
  plate: string;
  back: string;
  front: string;
}

/** How a shape is painted: the plate, a filled back take, an outlined back take, the front take, the triangle. */
export type MarkPaint = 'plate' | 'back' | 'outline' | 'front' | 'play';

export interface MarkRect {
  kind: 'rect';
  paint: Exclude<MarkPaint, 'play'>;
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  /** An outline's width (paint `outline` only). */
  stroke?: number;
}

export interface MarkPath {
  kind: 'path';
  paint: 'play';
  d: string;
  /** The triangle's stroke (its own colour, round joins: softer corners). */
  stroke: number;
}

export type MarkShape = MarkRect | MarkPath;

/** The grid's size (`viewBox="0 0 100 100"`). */
export const MARK_GRID = 100;

const PLATE: MarkRect = { kind: 'rect', paint: 'plate', x: 2, y: 2, width: 96, height: 96, rx: 22 };

/** The drawing of each variant, back to front. */
export const MARK: Readonly<Record<MarkVariant, readonly MarkShape[]>> = {
  full: [
    PLATE,
    { kind: 'rect', paint: 'outline', x: 17, y: 21, width: 50, height: 36, rx: 7, stroke: 6 },
    { kind: 'rect', paint: 'front', x: 33, y: 43, width: 50, height: 36, rx: 7 },
    { kind: 'path', paint: 'play', d: 'M53 54 L53 68 L64.5 61 Z', stroke: 2.5 },
  ],
  small: [PLATE, { kind: 'rect', paint: 'outline', x: 15, y: 19, width: 52, height: 38, rx: 7, stroke: 8 }, { kind: 'rect', paint: 'front', x: 33, y: 43, width: 52, height: 38, rx: 7 }],
  tiny: [PLATE, { kind: 'rect', paint: 'back', x: 12, y: 16, width: 56, height: 40, rx: 7 }, { kind: 'rect', paint: 'front', x: 32, y: 40, width: 56, height: 42, rx: 7 }],
};

/** The variant for a size the mark is seen at (CSS px, or points for an icon slot). */
export function markVariantFor(size: number): MarkVariant {
  return size <= 20 ? 'tiny' : size < 64 ? 'small' : 'full';
}

/**
 * macOS's icon grid (a 1024 canvas, the plate 824 wide at 100): the mark's 96-unit plate placed on it — scale 824 / 96,
 * offset 100 − 2 × scale.
 */
export const ICON_GRID = { canvas: 1024, plate: 824, at: 100 } as const;
const round = (n: number) => Number(n.toFixed(4));
const GRID_SCALE = ICON_GRID.plate / PLATE.width;
const GRID_OFFSET = ICON_GRID.at - PLATE.x * GRID_SCALE;

/**
 * The desktop icon's small sizes drawn for their slot (gen:mark → apps/desktop/icons/iconset/; desktop.mjs puts them in
 * the icns instead of downscaling the full mark): Finder's 16 and 32 pt slots at both densities — the variant follows
 * the slot's size in points, so a slot shows the same drawing on every display.
 */
export const MARK_ICONSET: ReadonlyArray<{ file: string; px: number; variant: MarkVariant }> = [16, 32].flatMap((pt) =>
  [1, 2].map((scale) => ({ file: `icon_${pt}x${pt}${scale === 2 ? '@2x' : ''}.png`, px: pt * scale, variant: markVariantFor(pt) })),
);

/** One shape's paint attributes for a palette. */
function paintAttrs(s: MarkShape, p: MarkPalette): string {
  switch (s.paint) {
    case 'plate':
      return `fill="${p.plate}"`;
    case 'back':
      return `fill="${p.back}"`;
    case 'outline':
      return `fill="none" stroke="${p.back}" stroke-width="${s.stroke}"`;
    case 'front':
      return `fill="${p.front}"`;
    case 'play':
      return `fill="${p.plate}" stroke="${p.plate}" stroke-width="${s.stroke}" stroke-linejoin="round"`;
  }
}

function shapeSvg(s: MarkShape, p: MarkPalette): string {
  if (s.kind === 'path') return `<path d="${s.d}" ${paintAttrs(s, p)}/>`;
  return `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.rx}" ${paintAttrs(s, p)}/>`;
}

export interface MarkSvgOptions {
  /** `width` / `height` in px (default: none — the viewBox alone — or 1024 on the icon grid). */
  size?: number;
  /** Place the plate on macOS's icon grid (a 1024 canvas with its margin) instead of filling the grid. */
  iconGrid?: boolean;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The mark as an SVG document (deterministic: one shape per line, a final line break). Palette values are `#rrggbb`. */
export function markSvg(variant: MarkVariant, palette: MarkPalette, opts: MarkSvgOptions = {}): string {
  for (const key of ['plate', 'back', 'front'] as const) {
    if (!HEX.test(palette[key])) throw new Error(`markSvg: the palette's ${key} must be a #rrggbb colour`);
  }
  const shapes = MARK[variant].map((s) => shapeSvg(s, palette));
  const box = opts.iconGrid ? ICON_GRID.canvas : MARK_GRID;
  const size = opts.size ?? (opts.iconGrid ? ICON_GRID.canvas : undefined);
  const dims = size === undefined ? '' : ` width="${size}" height="${size}"`;
  const body = opts.iconGrid ? [`<g transform="translate(${round(GRID_OFFSET)} ${round(GRID_OFFSET)}) scale(${round(GRID_SCALE)})">`, ...shapes, '</g>'] : shapes;
  return [`<svg xmlns="http://www.w3.org/2000/svg"${dims} viewBox="0 0 ${box} ${box}">`, ...body, '</svg>', ''].join('\n');
}

/** The mark as a `data:` URL (the favicon: the Studio's CSP allows `img-src data:`). */
export function markDataUrl(variant: MarkVariant, palette: MarkPalette): string {
  return `data:image/svg+xml,${encodeURIComponent(markSvg(variant, palette))}`;
}
