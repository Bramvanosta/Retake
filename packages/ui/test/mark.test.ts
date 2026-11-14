/**
 * L5.13b (R-REN-03): the "two takes" mark from one source — mark.ts's drawing (three variants by size), its colours in
 * tokens.ts (`--ui-mark-*` in both appearances, the fixed `MARK_INK` for the icon and the favicon). The committed desktop
 * icon files are what `pnpm -F @retake/ui gen:mark` writes from it (the SVGs compared as text; each PNG's size read from
 * its header and its pixels compared, within a small tolerance, with its SVG rasterised again by sharp as gen:mark does —
 * never its bytes, which follow the sharp version: a stale, reverted or swapped PNG fails);
 * the favicon in the document is the tiny mark as a `data:` URL the CSP allows as it is; the title bar and Welcome
 * draw the mark through the kit's AppMark, decorative (`aria-hidden`), painted by classes on the tokens.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STUDIO_CSP } from '@retake/engine';
import { REPO } from '@retake/test-support/repo';
import { INDEX_HTML } from '../src/index.js';
import { FAVICON_URL } from '../src/bundle.js';
import { ICON_GRID, MARK, MARK_ICONSET, MARK_VARIANTS, markSvg, markVariantFor } from '../src/mark.js';
import type { MarkVariant } from '../src/mark.js';
import { MARK_INK, UI_COLOURS } from '../src/app/tokens.js';
import { AppMark } from '../src/app/ui-kit/index.js';
import { WelcomeScreen } from '../src/app/project/WelcomeScreen.js';
import { GalleryScreen } from '../src/app/project/GalleryScreen.js';

const ICONS = join(REPO, 'apps', 'desktop', 'icons');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** A PNG's width and height from its IHDR chunk (after the 8-byte signature). */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString('hex'), file).toBe('89504e470d0a1a0a');
  expect(b.subarray(12, 16).toString('latin1'), file).toBe('IHDR');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

type Raw = { data: Buffer; info: { width: number; height: number; channels: number } };
type Sharp = (input: Buffer) => { ensureAlpha(): { raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<Raw> } } };
/** sharp from packages/review, where it is already a dependency (as gen:mark resolves it). */
const sharp = createRequire(join(REPO, 'packages', 'review', 'package.json'))('sharp') as Sharp;
const rgba = (b: Buffer) => sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

/**
 * A committed PNG shows its SVG: both decoded to RGBA, the same size, each channel within `max` and the mean difference
 * under `mean` (0–255 scale) — room for a librsvg / sharp bump's anti-aliasing, none for another drawing.
 */
async function expectPngShows(file: string, svg: string, tol = { mean: 2, max: 128 }): Promise<void> {
  const [png, fresh] = await Promise.all([rgba(readFileSync(file)), rgba(Buffer.from(svg, 'utf8'))]);
  expect([png.info.width, png.info.height], file).toEqual([fresh.info.width, fresh.info.height]);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < fresh.data.length; i++) {
    const d = Math.abs(png.data[i] - fresh.data[i]);
    sum += d;
    if (d > max) max = d;
  }
  const mean = sum / fresh.data.length;
  expect(mean, `${file} does not show its SVG (mean Δ ${mean.toFixed(2)}): run pnpm -F @retake/ui gen:mark`).toBeLessThan(tol.mean);
  expect(max, `${file} does not show its SVG (max Δ ${max}): run pnpm -F @retake/ui gen:mark`).toBeLessThan(tol.max);
}

/** The rects and paths of an SVG text, as `tag attr=value…` lines (geometry only: x, y, width, height, rx, d). */
function shapes(svg: string): string[] {
  return [...svg.matchAll(/<(rect|path)\b([^>]*)\/?>/g)].map(([, tag, attrs]) => {
    const pick = ['x', 'y', 'width', 'height', 'rx', 'd'].flatMap((k) => {
      const m = new RegExp(`\\s${k}="([^"]*)"`).exec(attrs);
      return m ? [`${k}=${m[1]}`] : [];
    });
    return `${tag} ${pick.join(' ')}`;
  });
}

/** A stylesheet's plain rules: selector → its declarations (comments dropped; the last rule of a selector wins). */
function cssRules(css: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [, sel, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries(
      body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
    );
    for (const one of sel.split(',')) out.set(one.trim(), decls);
  }
  return out;
}

/** The shell's AppMark elements as TypeScript reads them: how many, the props of the first, and where it stands. */
function shellMark(source: string): { marks: number; props: Record<string, unknown>; inHeader: boolean; first: boolean; nameNext: boolean } {
  const file = ts.createSourceFile('AppShell.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: ts.JsxSelfClosingElement[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(n) && n.tagName.getText(file) === 'AppMark') found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(file);
  const mark = found[0];
  const props: Record<string, unknown> = {};
  for (const a of mark?.attributes.properties ?? []) {
    if (!ts.isJsxAttribute(a) || !a.initializer) continue;
    const v = a.initializer;
    const e = ts.isJsxExpression(v) ? v.expression : v;
    props[a.name.getText(file)] = e && ts.isNumericLiteral(e) ? Number(e.text) : e && ts.isStringLiteral(e) ? e.text : e?.getText(file);
  }
  // Its parent element's element children: the mark first, the one after it shows {APP_NAME}.
  const parent = mark?.parent;
  const kids = parent && ts.isJsxElement(parent) ? parent.children.filter((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) : [];
  let up: ts.Node | undefined = mark;
  let inHeader = false;
  for (; up; up = up.parent) if (ts.isJsxElement(up) && up.openingElement.tagName.getText(file) === 'header') inHeader = true;
  const next = kids[1];
  return { marks: found.length, props, inHeader, first: kids[0] === mark, nameNext: next !== undefined && /\{APP_NAME\}/.test(next.getText(file)) };
}

describe('the "two takes" mark: one drawing, three variants (L5.13b, R-REN-03)', () => {
  it('« Nette » as validated: the full mark keeps the play triangle at its size; the small and tiny ones drop it; the variant follows the size', () => {
    expect(shapes(markSvg('full', MARK_INK))).toEqual([
      'rect x=2 y=2 width=96 height=96 rx=22',
      'rect x=17 y=21 width=50 height=36 rx=7',
      'rect x=33 y=43 width=50 height=36 rx=7',
      'path d=M53 54 L53 68 L64.5 61 Z',
    ]);
    const full = markSvg('full', MARK_INK);
    expect(full).toContain('fill="none" stroke="#3d7bff" stroke-width="6"');
    expect(full).toContain('<path d="M53 54 L53 68 L64.5 61 Z" fill="#141823" stroke="#141823" stroke-width="2.5" stroke-linejoin="round"/>');
    expect(shapes(markSvg('small', MARK_INK))).toEqual(['rect x=2 y=2 width=96 height=96 rx=22', 'rect x=15 y=19 width=52 height=38 rx=7', 'rect x=33 y=43 width=52 height=38 rx=7']);
    expect(markSvg('small', MARK_INK)).toContain('stroke-width="8"');
    expect(shapes(markSvg('tiny', MARK_INK))).toEqual(['rect x=2 y=2 width=96 height=96 rx=22', 'rect x=12 y=16 width=56 height=40 rx=7', 'rect x=32 y=40 width=56 height=42 rx=7']);
    expect(markSvg('tiny', MARK_INK)).not.toMatch(/stroke/);
    for (const v of ['small', 'tiny'] as const)
      expect(
        MARK[v].some((s) => s.kind === 'path'),
        v,
      ).toBe(false);
    expect([16, 18, 20, 24, 32, 48, 63, 64, 128, 1024].map(markVariantFor)).toEqual(['tiny', 'tiny', 'tiny', 'small', 'small', 'small', 'small', 'full', 'full', 'full']);
    // The colours are the palette's only: the ink one for the icon and the favicon, the tokens in the page.
    expect(MARK_INK).toEqual({ plate: '#141823', back: '#3d7bff', front: '#f4f5f7' });
    expect(UI_COLOURS['mark-plate']).toEqual({ dark: '#2a2e37', light: '#141823' });
    expect(UI_COLOURS['mark-back']).toEqual({ dark: '#3d7bff', light: '#3d7bff' });
    expect(UI_COLOURS['mark-front']).toEqual({ dark: '#f4f5f7', light: '#f4f5f7' });
    const swapped = { plate: '#000001', back: '#000002', front: '#000003' };
    for (const v of MARK_VARIANTS)
      expect(
        [...markSvg(v, swapped).matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0]).filter((c) => !Object.values(swapped).includes(c)),
        v,
      ).toEqual([]);
    // A palette value is a #rrggbb colour, nothing else reaches an attribute.
    for (const bad of ['red', '#fff', '#3d7bff"', '#3d7bff" onload="x', 'url(#a)', '', '#3d7bffcc']) {
      expect(() => markSvg('full', { ...MARK_INK, back: bad }), bad).toThrow(/#rrggbb/);
    }
  });

  it("on macOS's icon grid: the plate 824 wide at 100 on a 1024 canvas", () => {
    const svg = markSvg('full', MARK_INK, { iconGrid: true });
    expect(svg.split('\n')[0]).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">');
    const [, tx, ty, k] = /<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)">/.exec(svg)!.map(Number);
    expect(tx).toBe(ty);
    expect(tx + 2 * k).toBeCloseTo(ICON_GRID.at, 2);
    expect(96 * k).toBeCloseTo(ICON_GRID.plate, 1);
    expect(markSvg('tiny', MARK_INK, { iconGrid: true, size: 16 })).toContain('width="16" height="16" viewBox="0 0 1024 1024"');
  });
});

describe("the desktop icon files are gen:mark's output (pnpm -F @retake/ui gen:mark)", () => {
  it('⚑ icon.svg is the full mark on the icon grid, icon.json holds its hash, icon.png is 1024² and shows that SVG', async () => {
    const svg = readFileSync(join(ICONS, 'icon.svg'), 'utf8');
    expect(svg, 'apps/desktop/icons/icon.svg is stale: run pnpm -F @retake/ui gen:mark').toBe(markSvg('full', MARK_INK, { iconGrid: true }));
    const json = JSON.parse(readFileSync(join(ICONS, 'icon.json'), 'utf8')) as { svg_sha256: string; iconset: Record<string, { variant: MarkVariant; px: number; svg_sha256: string }> };
    expect(json.svg_sha256, 'icon.json does not name icon.svg: run gen:mark').toBe(sha256(svg));
    expect(pngSize(join(ICONS, 'icon.png'))).toEqual([1024, 1024]);
    await expectPngShows(join(ICONS, 'icon.png'), svg);
    // Tauri's window icon is that PNG (tauri.conf.json bundle.icon).
    expect(JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'tauri.conf.json'), 'utf8')).bundle.icon).toEqual(['icons/icon.png']);
  });

  it('⚑ the 16 and 32 pt slots (both densities) are the tiny and small marks drawn at their size, each PNG showing the SVG icon.json names', async () => {
    const json = JSON.parse(readFileSync(join(ICONS, 'icon.json'), 'utf8')) as { iconset: Record<string, { variant: MarkVariant; px: number; svg_sha256: string }> };
    expect(MARK_ICONSET.map((e) => `${e.file} ${e.variant} ${e.px}`)).toEqual(['icon_16x16.png tiny 16', 'icon_16x16@2x.png tiny 32', 'icon_32x32.png small 32', 'icon_32x32@2x.png small 64']);
    expect(readdirSync(join(ICONS, 'iconset')).sort()).toEqual(MARK_ICONSET.map((e) => e.file).sort());
    expect(Object.keys(json.iconset).sort()).toEqual(MARK_ICONSET.map((e) => e.file).sort());
    for (const e of MARK_ICONSET) {
      const svg = markSvg(e.variant, MARK_INK, { iconGrid: true, size: e.px });
      expect(json.iconset[e.file], e.file).toEqual({ variant: e.variant, px: e.px, svg_sha256: sha256(svg) });
      expect(pngSize(join(ICONS, 'iconset', e.file)), e.file).toEqual([e.px, e.px]);
      await expectPngShows(join(ICONS, 'iconset', e.file), svg);
    }
    // desktop.mjs requires the same files at the same sizes and copies them into the icns (the larger slots downscaled
    // from icon.png; its checks: cli desktop-config.test.ts).
    const { DRAWN_ICONS } = (await import(join(REPO, 'apps', 'desktop', 'scripts', 'desktop.mjs'))) as { DRAWN_ICONS: Record<string, number> };
    expect(DRAWN_ICONS).toEqual(Object.fromEntries(MARK_ICONSET.map((e) => [e.file, e.px])));
  });
});

describe("the favicon and the Studio's mark", () => {
  it("⚑ the favicon is the tiny mark on its ink plate, a data: URL in the document — the CSP's img-src as it was (self and data:)", () => {
    const links = [...INDEX_HTML.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
    expect(links).toEqual([`<link rel="icon" type="image/svg+xml" href="${FAVICON_URL}">`]);
    const prefix = 'data:image/svg+xml,';
    expect(FAVICON_URL.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(FAVICON_URL.slice(prefix.length))).toBe(markSvg('tiny', MARK_INK));
    // Nothing in the URL closes the attribute or opens markup.
    expect(FAVICON_URL).not.toMatch(/["<>\s]/);
    expect(STUDIO_CSP.split('; ').filter((d) => d.startsWith('img-src'))).toEqual(["img-src 'self' data:"]);
  });

  it("⚑ AppMark draws mark.ts's geometry, aria-hidden, painted by classes on the --ui-mark-* tokens (no colour of its own)", () => {
    for (const v of MARK_VARIANTS) {
      const html = renderToStaticMarkup(createElement(AppMark, { variant: v, size: 40 }));
      expect(html, v).toMatch(/^<svg class="k-appmark" viewBox="0 0 100 100" width="40" height="40" aria-hidden="true" focusable="false" data-variant="[a-z]+">/);
      expect(shapes(html), v).toEqual(shapes(markSvg(v, MARK_INK)));
      expect(html, v).not.toMatch(/fill=|stroke=|style=|#[0-9a-f]{3,8}\b/i);
      expect(
        [...html.matchAll(/class="(k-appmark-[a-z]+)"/g)].map((m) => m[1]),
        v,
      ).toEqual(MARK[v].map((s) => `k-appmark-${s.paint}`));
    }
    // L7.34: kit.css read as the browser reads it (its rules, whatever the layout of the text): each part's class paints
    // with its --ui-mark-* token only, and every token it names is one of tokens.ts's (both appearances).
    const rules = cssRules(readFileSync(join(REPO, 'packages', 'ui', 'src', 'app', 'ui-kit', 'kit.css'), 'utf8'));
    const paints = [...new Set(MARK_VARIANTS.flatMap((v) => MARK[v].map((s) => s.paint)))].sort();
    expect(paints).toEqual(['back', 'front', 'outline', 'plate', 'play']);
    for (const [cls, decls] of [
      ['plate', { fill: 'var(--ui-mark-plate)' }],
      ['back', { fill: 'var(--ui-mark-back)' }],
      ['outline', { fill: 'none', stroke: 'var(--ui-mark-back)' }],
      ['front', { fill: 'var(--ui-mark-front)' }],
      ['play', { fill: 'var(--ui-mark-plate)', stroke: 'var(--ui-mark-plate)' }],
    ] as const) {
      expect(rules.get(`.k-appmark-${cls}`), cls).toEqual(decls);
      for (const v of Object.values(decls)) for (const m of v.matchAll(/var\(--ui-([a-z-]+)\)/g)) expect(Object.keys(UI_COLOURS), `${cls}: --ui-${m[1]}`).toContain(m[1]);
    }
  });

  it('⚑ the title bar (tiny, 18 px) and Welcome (full, 128 px) render the mark, aria-hidden, beside the name', () => {
    // The shell reads external stores (no server snapshot): it cannot render here. L7.34: its one AppMark is found in
    // its tree (TypeScript's parser: in the title bar, the first element there, the product's name next) and rendered
    // with the props it is given there.
    const titleBar = shellMark(readFileSync(join(REPO, 'packages', 'ui', 'src', 'app', 'shell', 'AppShell.tsx'), 'utf8'));
    expect(titleBar.marks).toBe(1);
    expect(titleBar).toMatchObject({ inHeader: true, first: true, nameNext: true });
    const bar = renderToStaticMarkup(createElement(AppMark, titleBar.props as { variant: MarkVariant; size: number }));
    expect(bar).toMatch(/^<svg class="k-appmark" viewBox="0 0 100 100" width="18" height="18" aria-hidden="true" focusable="false" data-variant="tiny">/);
    expect(markVariantFor(18)).toBe('tiny');
    const list = { state: 'ready' as const, data: { root: '/w', projects_dir: '/w/projects', projects: [] } };
    const welcome = renderToStaticMarkup(createElement(WelcomeScreen, { list }));
    expect(welcome).toMatch(
      /<section class="wl-intro" aria-labelledby="wl-h1"><svg class="k-appmark" viewBox="0 0 100 100" width="128" height="128" aria-hidden="true" focusable="false" data-variant="full">[\s\S]*?<\/svg><h1 id="wl-h1"/,
    );
    // The gallery shows each variant at its sizes with a visible caption naming them (the marks themselves are aria-hidden):
    // L7.34: rendered, its "App mark" section read.
    const gallery = renderToStaticMarkup(createElement(GalleryScreen));
    const sections = [...gallery.matchAll(/<section class="gl-section"><h3 class="gl-title">App mark<\/h3>([\s\S]*?)<\/section>/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const marks = [...section.matchAll(/<svg class="k-appmark" [^>]*width="(\d+)" height="\1" aria-hidden="true" focusable="false" data-variant="([a-z]+)">/g)].map((m) => `${m[2]} ${m[1]} px`);
      expect(marks).toEqual(['full 128 px', 'full 64 px', 'small 32 px', 'tiny 18 px', 'tiny 16 px']);
      expect(section).toContain(`<span class="gl-lede">${marks.join(' · ')}</span>`);
    }
    // The placeholder squares are gone with their rules.
    for (const f of ['shell/shell.css', 'screens.css', 'shell/AppShell.tsx', 'project/WelcomeScreen.tsx']) {
      expect(readFileSync(join(REPO, 'packages', 'ui', 'src', 'app', f), 'utf8'), f).not.toMatch(/sh-appmark|wl-mark/);
    }
  });
});
