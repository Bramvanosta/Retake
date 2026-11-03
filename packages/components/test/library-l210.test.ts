/**
 * L2.10 library: the tutorial overlays (shortcut, spotlight, steps, loupe, progress) and the story cards (figure,
 * features, before/after, testimonial, CTA, chart) render from their props in every format; the kit helpers behind
 * them — key caps, figures, placement, CSV, icons — are pure and tested here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LIBRARY_DIR, applyParamDefaults, parseCsv, parseManifest, validateComponent } from '@retake/components';
import type { ComponentManifest, ComponentProps, MediaValue } from '@retake/components';
import { ICON_NAMES, clearOf, figureAt, formatFigure, parseFigure, parseNumber, parseShortcut, placeBeside, qrEncode, shortcutText, splitKeys } from '../src/kit/index.js';
import { chartPoints } from '../library/studio/card-chart/index.js';
import { DARK, LIGHT } from './helpers.js';

const frame = vi.hoisted(() => ({ current: 0 }));
vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return {
    ...actual,
    useCurrentFrame: () => frame.current,
    useVideoConfig: () => ({ fps: 30, width: 1920, height: 1080, durationInFrames: 300, id: 'test' }),
    Img: (props: Record<string, unknown>) => h('img', props),
    OffthreadVideo: (props: Record<string, unknown>) => h('video', props),
    Sequence: (props: { children?: unknown; from?: number }) => h('div', { 'data-from': props.from }, props.children as never),
  };
});

const OVERLAYS = ['overlay-shortcut', 'overlay-spotlight', 'overlay-steps', 'overlay-loupe', 'overlay-progress'].map((n) => `studio/${n}`);
const CARDS = ['card-figure', 'card-features', 'card-before-after', 'card-testimonial', 'card-cta', 'card-chart'].map((n) => `studio/${n}`);
const IDS = [...OVERLAYS, ...CARDS];
const dirOf = (id: string) => join(LIBRARY_DIR, ...id.split('/'));
const manifests: Record<string, ComponentManifest> = {};
const modules: Record<string, Record<string, unknown>> = {};
type Variant = 'landscape' | 'vertical' | 'square';
const SIZES: Record<Variant, [number, number]> = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] };
const RECTS = { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, radius: 18 };

beforeAll(async () => {
  for (const id of IDS) {
    manifests[id] = parseManifest(readFileSync(join(dirOf(id), 'component.yaml'), 'utf8'), 'component.yaml', { folderId: id }).manifest!;
    modules[id] = (await import(join(dirOf(id), 'index.tsx'))) as Record<string, unknown>;
  }
});

function render(id: string, opts: { params?: Record<string, unknown>; slots?: Record<string, string>; media?: Record<string, MediaValue>; at?: number; variant?: Variant; dark?: boolean; extra?: Partial<ComponentProps> } = {}): string {
  const m = manifests[id];
  const variant = opts.variant ?? 'landscape';
  frame.current = opts.at ?? 90;
  const props: ComponentProps = {
    theme: opts.dark ? DARK : LIGHT,
    slots: { ...((m.preview?.slots as Record<string, string>) ?? {}), ...(opts.slots ?? {}) },
    params: applyParamDefaults(m.params as never, { ...((m.preview?.params as Record<string, unknown>) ?? {}), ...(opts.params ?? {}) }),
    unit: 1,
    width: SIZES[variant][0],
    height: SIZES[variant][1],
    fps: 30,
    durationInFrames: Math.round((m.duration?.default ?? 4) * 30),
    variant,
    ...(opts.media ? { media: opts.media } : {}),
    ...opts.extra,
  };
  return renderToString(createElement(modules[id].default as ComponentType<ComponentProps>, props));
}

describe('the L2.10 components are valid, versioned and declare every format', () => {
  it.each(IDS)('%s', async (id) => {
    const issues = await validateComponent(dirOf(id));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(manifests[id].version).toBe('1.0.0');
    expect(manifests[id].variants).toEqual(['landscape', 'vertical', 'square']);
  });
});

describe('tutorial overlays', () => {
  const anchor = { x: 760, y: 470, w: 400, h: 40 };
  it('shortcut: macOS glyph caps, Windows words, a count chip for repeats, pressed at `moment`', () => {
    const mac = render('studio/overlay-shortcut', { slots: { keys: 'Meta+Shift+K' }, extra: { rects: RECTS, moment: 9 }, at: 20 });
    expect((mac.match(/<svg/g) ?? []).length).toBe(2); // ⌘ and ⇧ drawn as line glyphs
    expect(mac).toContain('>K<');
    const win = render('studio/overlay-shortcut', { slots: { keys: 'ControlOrMeta+K' }, params: { platform: 'windows' }, extra: { rects: RECTS, moment: 9 }, at: 20 });
    expect(win).toContain('>Ctrl<');
    expect(win).toContain('>+<');
    const rep = render('studio/overlay-shortcut', { slots: { keys: 'ArrowDown', times: '3' }, extra: { rects: RECTS, moment: 9 }, at: 9 + 12 });
    expect(rep).toMatch(/× 3/);
    expect(render('studio/overlay-shortcut', { slots: { keys: '' }, extra: { rects: RECTS } })).toBe('');
  });

  it('shortcut and loupe keep clear of a caption band over the screen (`avoid`)', () => {
    const band = { x: 380, y: 744, w: 1160, h: 150 };
    const plate = (html: string) => {
      const m = /left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px;border-radius/.exec(html)!;
      return { x: +m[1], y: +m[2], w: +m[3], h: +m[4] };
    };
    const free = plate(render('studio/overlay-shortcut', { slots: { keys: 'Meta+K' }, extra: { rects: RECTS, moment: 9 }, at: 20 }));
    expect(free.y + free.h).toBeGreaterThan(band.y); // at the bottom of the capture: over the band
    const clear = plate(render('studio/overlay-shortcut', { slots: { keys: 'Meta+K' }, extra: { rects: RECTS, moment: 9, avoid: [band] }, at: 20 }));
    expect(clear.y + clear.h).toBeLessThanOrEqual(band.y - 13);
    expect(clear.x).toBe(free.x);
    // The loupe of a field just above the band opens above the field instead of below it.
    const field = { x: 760, y: 690, w: 400, h: 40 };
    const region = { x: 600, y: 680, w: 300, h: 40 };
    const lens = (avoid?: (typeof band)[]) => render('studio/overlay-loupe', { extra: { anchor: field, rects: RECTS, region, screen: null, ...(avoid ? { avoid } : {}) }, at: 30 });
    expect(lens()).toMatch(/transform-origin:[\d.]+px 0px/); // below: grows from its top edge
    expect(lens([band])).toMatch(/transform-origin:[\d.]+px 100%/); // above
  });

  it('spotlight: an SVG mask with a soft cut-out around the anchor, nothing without one', () => {
    const html = render('studio/overlay-spotlight', { extra: { anchor, rects: RECTS }, at: 30 });
    expect(html).toMatch(/<mask/);
    expect(html).toMatch(/feGaussianBlur/);
    expect(html).toContain(`x="${anchor.x - 12}"`);
    expect(render('studio/overlay-spotlight', { extra: { rects: RECTS } })).toBe('');
  });

  it('steps: the badge is beside the target, never over it', () => {
    for (const variant of ['landscape', 'vertical', 'square'] as const) {
      const [w, h] = SIZES[variant];
      const rects = variant === 'landscape' ? RECTS : { screen: { x: 40, y: 200, w: w - 80, h: h - 500 }, frame: { x: 40, y: 200, w: w - 80, h: h - 500 }, radius: 18 };
      for (const a of [anchor, { x: rects.screen.x + 4, y: rects.screen.y + 4, w: 200, h: 40 }]) {
        const html = render('studio/overlay-steps', { slots: { number: '3' }, variant, extra: { anchor: a, rects, moment: 10 }, at: 20 });
        const m = /left:(\d+(?:\.\d+)?)px;top:(\d+(?:\.\d+)?)px;width:(\d+(?:\.\d+)?)px;height:\d+(?:\.\d+)?px;border-radius:[\d.]+px;background/.exec(html)!;
        const b = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) };
        const overlaps = b.x < a.x + a.w && b.x + b.w > a.x && b.y < a.y + a.h && b.y + b.w > a.y;
        expect(overlaps, `${variant} ${JSON.stringify(a)}`).toBe(false);
        expect(html).toContain('>3<');
      }
    }
  });

  it('loupe: the capture region as `screen`, magnified at least 1.5 design px per CSS px, readable in vertical', () => {
    const region = { x: 720, y: 460, w: 480, h: 60 };
    for (const variant of ['landscape', 'vertical', 'square'] as const) {
      const shown = variant === 'landscape' ? 0.8125 : 0.9;
      const a = { x: 400, y: 600, w: region.w * shown, h: region.h * shown };
      const rects = variant === 'landscape' ? RECTS : { screen: { x: 0, y: 200, w: SIZES[variant][0], h: SIZES[variant][1] - 500 }, frame: { x: 0, y: 200, w: SIZES[variant][0], h: SIZES[variant][1] - 500 }, radius: 0 };
      const html = render('studio/overlay-loupe', { variant, extra: { anchor: a, rects, region, screen: createElement('i', { id: 'cap' }) }, at: 30 });
      expect(html).toContain('id="cap"');
      const w = Number(/width:([\d.]+)px;height:([\d.]+)px;border-radius:[\d.]+px;overflow:hidden/.exec(html)![1]);
      expect(w / region.w, variant).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('progress: one segment per chapter, filling as the frame advances', () => {
    const chapters = [
      { id: 'a', label: 'One', from: 0, to: 100 },
      { id: 'b', label: 'Two', from: 100, to: 300 },
    ];
    const html = render('studio/overlay-progress', { extra: { chapters }, params: { labels: true }, at: 150 });
    expect((html.match(/overflow:hidden/g) ?? []).length).toBe(2);
    expect(html).toContain('width:100%');
    expect(html).toContain('width:25%');
    expect(html).toMatch(/2\/2 · TWO/);
  });
});

describe('story cards', () => {
  it('figure: counts up to the captured value, written as given', () => {
    const media: Record<string, MediaValue> = { capture: { kind: 'text', name: 'total', value: '€465.00', text: '€465.00 incl. VAT' } };
    expect(render('studio/card-figure', { media, at: 200 })).toContain('€465.00');
    const mid = render('studio/card-figure', { media, at: 30 });
    expect(mid).toMatch(/€\d{1,3}\.\d{2}/);
    expect(mid).not.toContain('€465.00');
    expect(render('studio/card-figure', { slots: { value: '1 240 bags' }, at: 200 })).toContain('1 240 bags');
  });

  it('features: 3–5 items with built-in icons or numbers', () => {
    const html = render('studio/card-features', { at: 200 });
    expect((html.match(/<svg/g) ?? []).length).toBe(4);
    const numbered = render('studio/card-features', { params: { items: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] }, at: 200, variant: 'vertical' });
    expect(numbered).toContain('>01<');
    expect(numbered).toContain('>03<');
  });

  it('before/after: two pictures (capture frames or files) and a wipe', () => {
    const before: MediaValue = { kind: 'picture', name: 'before', url: 'http://a/capture.mp4', width: 1920, height: 1080, video: { time_s: 2 }, label: 'start' };
    const after: MediaValue = { kind: 'picture', name: 'after', url: 'http://a/after.png', width: 1920, height: 1080, label: 'file' };
    const html = render('studio/card-before-after', { media: { before, after }, at: 50 });
    expect(html).toContain('<video');
    expect(html).toContain('http://a/after.png');
    expect(html).toMatch(/clip-path:inset\(0 [\d.]+px 0 0\)/);
    expect(html).toContain('>BEFORE<');
  });

  it('testimonial: initials without an avatar, the logo image when given', () => {
    const html = render('studio/card-testimonial', { slots: { logo: 'http://a/logo.svg' }, at: 200 });
    expect(html).toContain('>MO<');
    expect(html).toContain('http://a/logo.svg');
  });

  it('CTA: the QR code encodes the url (https added) with the theme dark on white', () => {
    const html = render('studio/card-cta', { at: 200 });
    expect(html).toMatch(/<path d="M\d/);
    const q = qrEncode('https://shop.northfield.example/signup');
    expect(html).toContain(`viewBox="0 0 ${q.size + 4} ${q.size + 4}"`);
    expect(render('studio/card-cta', { params: { show_qr: false }, at: 200 })).not.toContain('viewBox="0 0 3');
    expect(render('studio/card-cta', { dark: true, variant: 'vertical', at: 200 })).toContain('Create an account');
  });

  it('chart: bars or a line from a CSV table or inline data', () => {
    const table: MediaValue = { kind: 'table', name: 'x.csv', columns: ['month', 'requests', 'accepted'], rows: [['Jun', '42', '19'], ['Jul', '1,051', '24']] };
    expect(chartPoints(table as never, { data: [], x: '', y: '', max_points: 12 }).points.map((p) => p.value)).toEqual([42, 1051]);
    expect(chartPoints(table as never, { data: [], x: '', y: 'accepted', max_points: 12 }).points.map((p) => p.value)).toEqual([19, 24]);
    expect(chartPoints(undefined, { data: [{ label: 'a', value: 1.5 }, { label: 'b', value: 2 }], x: '', y: '', max_points: 12 })).toEqual({ points: [{ label: 'a', value: 1.5, raw: '1.5' }, { label: 'b', value: 2, raw: '2' }], decimals: 1 });
    const bars = render('studio/card-chart', { media: { data: table }, at: 200 });
    expect(bars).toContain('>1,051<');
    const line = render('studio/card-chart', { media: { data: table }, params: { type: 'line', prefix: '€' }, at: 200 });
    expect(line).toMatch(/stroke-dasharray/);
    expect(line).toContain('>€42<');
  });

  it('every card and overlay renders in every format and both theme tones', () => {
    const media: Record<string, MediaValue> = {
      capture: { kind: 'text', name: 't', value: '921', text: '921' },
      before: { kind: 'picture', name: 'b', url: 'http://a/b.png', width: 1280, height: 720, label: 'b' },
      after: { kind: 'picture', name: 'a', url: 'http://a/a.png', width: 1280, height: 720, label: 'a' },
      data: { kind: 'table', name: 'd', columns: ['m', 'v'], rows: [['a', '1'], ['b', '2'], ['c', '3']] },
    };
    for (const id of IDS) {
      for (const variant of ['landscape', 'vertical', 'square'] as const) {
        for (const dark of [false, true]) {
          const html = render(id, { variant, dark, media, extra: { anchor: { x: 300, y: 300, w: 200, h: 40 }, rects: RECTS, region: { x: 0, y: 0, w: 300, h: 50 }, chapters: [{ id: 'a', from: 0, to: 60 }] }, at: 60 });
          expect(html.length, `${id} ${variant} ${dark}`).toBeGreaterThan(0);
          expect(html).not.toMatch(/NaN|undefinedpx|Infinity/);
        }
      }
    }
  });
});

describe('kit helpers', () => {
  it('parseShortcut / shortcutText / splitKeys', () => {
    expect(parseShortcut('Shift+Meta+K', 'mac').map((c) => c.glyph ?? c.label)).toEqual(['shift', 'command', 'K']);
    expect(parseShortcut('Control+Alt+Delete', 'windows').map((c) => c.label)).toEqual(['Ctrl', 'Alt', 'Delete']);
    expect(parseShortcut('Meta+K', 'linux')[0].label).toBe('Super');
    expect(shortcutText('ControlOrMeta+Shift+P', 'mac')).toBe('⇧⌘P');
    expect(shortcutText('ControlOrMeta+Shift+P', 'windows')).toBe('Ctrl + Shift + P');
    expect(parseShortcut('Enter', 'mac')[0]).toMatchObject({ glyph: 'return', hint: 'return', modifier: false });
    expect(parseShortcut('KeyA')[0].label).toBe('A');
    expect(splitKeys('Control++')).toEqual(['Control', '+']);
  });

  it('parseFigure / formatFigure / figureAt / parseNumber', () => {
    expect(parseFigure('€720.00')).toMatchObject({ prefix: '€', value: 720, decimals: 2, decimal: '.', suffix: '' });
    expect(parseFigure('1,234,567 offers')).toMatchObject({ value: 1234567, group: ',', suffix: ' offers' });
    expect(parseFigure('1.234,56 €')).toMatchObject({ value: 1234.56, group: '.', decimal: ',', suffix: ' €' });
    expect(parseFigure('12,5 %')).toMatchObject({ value: 12.5, decimal: ',', suffix: ' %' });
    expect(parseFigure('-3.4k')).toMatchObject({ value: -3.4, suffix: 'k' });
    expect(parseFigure('no digits')).toBeNull();
    const f = parseFigure('€1,240.50')!;
    expect(formatFigure(12.3, f)).toBe('€12.30');
    expect(formatFigure(1234.5, f)).toBe('€1,234.50');
    expect(figureAt('€1,240.50', 0.5)).toBe('€620.25');
    expect(figureAt('€1,240.50', 1)).toBe('€1,240.50');
    expect(figureAt('+38 %', 0.5)).toBe('+19 %');
    expect(parseNumber('1,051')).toBe(1051);
    expect(parseNumber('€ 12,50')).toBe(12.5);
    expect(Number.isNaN(parseNumber('n/a'))).toBe(true);
  });

  it('placeBeside keeps the box inside the bounds and off the target', () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 600 };
    for (const target of [{ x: 0, y: 0, w: 100, h: 40 }, { x: 900, y: 560, w: 100, h: 40 }, { x: 450, y: 280, w: 100, h: 40 }, { x: 0, y: 0, w: 1000, h: 540 }]) {
      const b = placeBeside({ target, w: 44, h: 44, bounds, gap: 8 });
      expect(b.x).toBeGreaterThanOrEqual(-0.5);
      expect(b.y).toBeGreaterThanOrEqual(-0.5);
      expect(b.x + b.w).toBeLessThanOrEqual(1000.5);
      expect(b.y + b.h).toBeLessThanOrEqual(600.5);
      const overlap = b.x < target.x + target.w && b.x + b.w > target.x && b.y < target.y + target.h && b.y + b.h > target.y;
      expect(overlap, JSON.stringify(target)).toBe(false);
    }
  });

  it('placeBeside and clearOf keep clear of `avoid` boxes', () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 600 };
    const target = { x: 450, y: 400, w: 100, h: 40 };
    const band = { x: 100, y: 450, w: 800, h: 120 };
    const b = placeBeside({ target, w: 300, h: 80, bounds, gap: 10, order: ['below', 'above'], avoid: [band] });
    expect(b.side).toBe('above');
    expect(placeBeside({ target, w: 300, h: 80, bounds, gap: 10, order: ['below', 'above'] }).side).toBe('below');
    expect(clearOf({ x: 400, y: 500, w: 200, h: 60 }, [band], { dir: 'up', gap: 10, bounds })).toEqual({ x: 400, y: 380, w: 200, h: 60 });
    expect(clearOf({ x: 400, y: 20, w: 200, h: 60 }, [band], { dir: 'up', gap: 10, bounds })).toEqual({ x: 400, y: 20, w: 200, h: 60 });
    expect(clearOf({ x: 400, y: 460, w: 200, h: 60 }, [band], { dir: 'down', gap: 10, bounds }).y).toBe(540); // no room below: kept inside
  });

  it('parseCsv: quotes, escapes, CRLF, semicolons and tabs', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n3,4\n')).toEqual({ columns: ['a', 'b'], rows: [['x, y', 'say "hi"'], ['3', '4']] });
    expect(parseCsv('m;v\nJan;1,5\n')).toEqual({ columns: ['m', 'v'], rows: [['Jan', '1,5']] });
    expect(parseCsv('m\tv\nJan\t2\n').rows).toEqual([['Jan', '2']]);
    expect(parseCsv('a,b,c\n1\n').rows).toEqual([['1', '', '']]);
  });

  it('icons: a small generic set', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(20);
    const features = manifests['studio/card-features'].params as { properties: { items: { items: { properties: { icon: { enum: string[] } } } } } };
    expect([...features.properties.items.items.properties.icon.enum].sort()).toEqual([...ICON_NAMES].sort());
  });
});
