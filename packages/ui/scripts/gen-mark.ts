/**
 * L5.13b: writes the desktop app's icon files from the one drawing of the "two takes" mark (src/mark.ts, the ink palette
 * of src/app/tokens.ts) — `pnpm -F @retake/ui gen:mark`; mark.test.ts fails when the committed files differ:
 * - `apps/desktop/icons/icon.svg` — the full mark on macOS's icon grid (1024, the plate 824 at 100);
 * - `icon.png` — that SVG at 1024² (what desktop.mjs makes the larger icns sizes from, and Tauri's window icon);
 * - `iconset/icon_16x16{,@2x}.png` (the tiny mark) and `iconset/icon_32x32{,@2x}.png` (the small one) — Finder's 16 and
 *   32 pt slots, drawn for their size instead of downscaled from the full mark (desktop.mjs copies them into the icns);
 * - `icon.json` — the SHA-256 of each SVG a PNG was made from (a PNG is never compared byte for byte: its bytes depend
 *   on the sharp / librsvg version; the test rasterises the SVG again and compares the pixels within a tolerance).
 * sharp is resolved from packages/review, where it is already a dependency (no new one).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK_INK } from '../src/app/tokens.js';
import { MARK_ICONSET, markSvg } from '../src/mark.js';
import type { MarkVariant } from '../src/mark.js';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const ICONS = join(REPO, 'apps', 'desktop', 'icons');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Sharp = (input: Buffer, opts?: { density?: number }) => { png(opts?: { compressionLevel?: number }): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(join(REPO, 'packages', 'review', 'package.json'))('sharp') as Sharp;

async function png(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg, 'utf8')).png({ compressionLevel: 9 }).toBuffer();
}

const svg = markSvg('full', MARK_INK, { iconGrid: true });
await mkdir(join(ICONS, 'iconset'), { recursive: true });
await writeFile(join(ICONS, 'icon.svg'), svg);
await writeFile(join(ICONS, 'icon.png'), await png(svg));
const iconset: Record<string, { variant: MarkVariant; px: number; svg_sha256: string }> = {};
for (const e of MARK_ICONSET) {
  const small = markSvg(e.variant, MARK_INK, { iconGrid: true, size: e.px });
  await writeFile(join(ICONS, 'iconset', e.file), await png(small));
  iconset[e.file] = { variant: e.variant, px: e.px, svg_sha256: sha256(small) };
}
await writeFile(join(ICONS, 'icon.json'), `${JSON.stringify({ svg_sha256: sha256(svg), iconset }, null, 2)}\n`);
console.log(`wrote ${relative(process.cwd(), ICONS)}/icon.svg, icon.png, icon.json and ${MARK_ICONSET.length} iconset PNGs`);
