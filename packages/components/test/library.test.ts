/**
 * The built-in library (packages/components/library/studio/*): a component for every id the starter templates and the
 * legacy template fields refer to, plus studio/layout-tablet — the six reference-look components (L2.5: intro-stack,
 * outro-stack, layout-card, caption-below, interstitial-clock, transition-crossfade) and the thirteen of L2.7 in the
 * same family (layouts browser / laptop / phone / tablet / raw, caption-overlay, card-title, intro- / outro-minimal,
 * interstitial-plain, overlay-callout / -lower-third, transition-fade-black). Each one validates (manifest + compile),
 * accepts the params the themes pass, renders with any theme (react-dom/server, remotion's frame hook mocked) and —
 * for layouts — draws where its geometry (expressions over params and the capture aspect) says.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTemplate, resolveThemeComponents } from '@demo-studio/core';
import type { Template } from '@demo-studio/core';
import { LIBRARY_DIR, applyParamDefaults, captionBandBox, evalLayoutGeometry, loadComponentRegistry, paramDefaults, parseManifest, validateComponentDir } from '@demo-studio/components';
import type { ComponentManifest, ComponentProps, ComponentRegistry, LayoutRects, ThemeTokens } from '@demo-studio/components';
import { DARK, LIGHT, tempDir } from './helpers.js';

const frame = vi.hoisted(() => ({ current: 0 }));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return { ...actual, useCurrentFrame: () => frame.current, Img: (props: Record<string, unknown>) => h('img', props) };
});

const REPO = new URL('../../../', import.meta.url).pathname;

/** Every id referenced by the starter templates and the legacy field mapping (DESIGN-phase2 §1.2, §1.4), and the L2.9 family. */
const IDS = [
  'studio/intro-stack',
  'studio/intro-minimal',
  'studio/outro-stack',
  'studio/outro-minimal',
  'studio/card-title',
  'studio/interstitial-clock',
  'studio/interstitial-plain',
  'studio/layout-card',
  'studio/layout-browser',
  'studio/layout-laptop',
  'studio/layout-phone',
  'studio/layout-raw',
  'studio/layout-tablet',
  'studio/caption-below',
  'studio/caption-overlay',
  'studio/overlay-callout',
  'studio/overlay-lower-third',
  'studio/transition-crossfade',
  'studio/transition-fade-black',
  // L2.9: mails, notifications and documents.
  'studio/notification',
  'studio/mail-notification',
  'studio/mail-view',
  'studio/document-pdf',
  'studio/phone-lockscreen',
  'studio/phone-home-badge',
  'studio/transition-tap-open',
];

/** The reference-look components (docs/reference/look.md), final since L2.5. */
const REFERENCE_LOOK = [
  'studio/caption-below',
  'studio/interstitial-clock',
  'studio/intro-stack',
  'studio/layout-card',
  'studio/outro-stack',
  'studio/transition-crossfade',
];

const dirOf = (id: string) => join(LIBRARY_DIR, ...id.split('/'));
const manifests: Record<string, ComponentManifest> = {};
const impls: Record<string, ComponentType<ComponentProps>> = {};
const modules: Record<string, Record<string, unknown>> = {};
let registry: ComponentRegistry;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  for (const id of IDS) {
    manifests[id] = parseManifest(readFileSync(join(dirOf(id), 'component.yaml'), 'utf8'), 'component.yaml', { folderId: id }).manifest!;
    modules[id] = (await import(join(dirOf(id), 'index.tsx'))) as Record<string, unknown>;
    impls[id] = modules[id].default as ComponentType<ComponentProps>;
  }
  const ws = await tempDir();
  cleanup = ws.cleanup;
  registry = await loadComponentRegistry({ root: ws.dir });
  return () => cleanup();
});

type Variant = 'landscape' | 'vertical' | 'square';
const SIZES: Record<Variant, [number, number]> = { landscape: [1920, 1080], vertical: [1080, 1920], square: [1080, 1080] };
const GEOMETRY_OF = { landscape: 'geometry', vertical: 'geometry_vertical', square: 'geometry_square' } as const;

function render(id: string, opts: { theme?: ThemeTokens; at?: number; unit?: number; vertical?: boolean; variant?: Variant; params?: Record<string, unknown>; extra?: Partial<ComponentProps> } = {}): string {
  const m = manifests[id];
  const unit = opts.unit ?? 1;
  const variant: Variant = opts.variant ?? (opts.vertical ? 'vertical' : 'landscape');
  const fps = 30;
  frame.current = opts.at ?? 45;
  const props: ComponentProps = {
    theme: opts.theme ?? LIGHT,
    slots: { ...(m.preview?.slots ?? {}) },
    params: applyParamDefaults(m.params as never, opts.params ?? {}),
    unit,
    width: SIZES[variant][0] * unit,
    height: SIZES[variant][1] * unit,
    fps,
    durationInFrames: Math.round((m.duration?.default ?? 4) * fps),
    variant,
    ...opts.extra,
  };
  return renderToString(createElement(impls[id], props));
}

const px = (v: number) => (v === 0 ? '0' : `${v}px`);
const rectCss = (r: { x: number; y: number; w: number; h: number }) => `left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)}`;

describe('built-in library: a component for every referenced id', () => {
  it('has exactly the referenced ids, each valid (manifest + compile) and final: no placeholder left (R-LIB-00)', async () => {
    const found = readdirSync(join(LIBRARY_DIR, 'studio')).map((n) => `studio/${n}`).sort();
    expect(found).toEqual([...IDS].sort());
    for (const id of IDS) {
      const v = await validateComponentDir(dirOf(id));
      expect(v.issues, id).toEqual([]);
      expect(v.ok, id).toBe(true);
      expect(registry.get(id).source, id).toBe('builtin');
      expect(manifests[id].tags ?? [], id).not.toContain('placeholder');
      expect(manifests[id].version, id).toBe('1.0.0');
      if (REFERENCE_LOOK.includes(id)) expect(manifests[id].tags, id).toContain('reference-look');
      // style_bias is read (R-TPL-04) — except by layouts, static at every bias by design (a frame never moves on its
      // own; camera and transitions do).
      if (manifests[id].kind !== 'layout') expect(manifests[id].tokens, id).toContain('style_bias');
    }
  });

  it('the starter themes resolve every kind with the params they pass', async () => {
    for (const name of ['default', 'editorial', 'motion']) {
      const t = await loadTemplate(name, REPO);
      const resolved = registry.resolveTheme(t.template);
      for (const [kind, rc] of Object.entries(resolved)) expect(rc?.kind, `${name} ${kind}`).toBe(kind);
    }
    const card = registry.resolve({ id: 'studio/layout-card', params: { width: 1560, radius: 18, shadow: 'soft' } }, 'layout');
    expect(card.params).toEqual({ width: 1560, radius: 18, shadow: 'soft' });
    expect(registry.resolve({ id: 'studio/transition-crossfade', params: { duration: 0.35 } }, 'transition').params).toEqual({ duration: 0.35 });
    expect(registry.resolve({ id: 'studio/transition-fade-black', params: { duration: 0.4 } }, 'transition').params).toMatchObject({ duration: 0.4 });
  });

  it('every legacy template field value maps to a component that resolves (params included)', async () => {
    const base = (await loadTemplate('default', REPO)).template;
    const variants: Array<Partial<Template>> = [
      ...(['card', 'browser', 'laptop', 'phone', 'raw'] as const).map((style) => ({ frame: { ...base.frame, style, width: 1400, radius: 24, shadow: 'strong' as const } })),
      ...(['logo-kicker-title', 'kicker-title', 'logo-only'] as const).map((layout) => ({ intro: { ...base.intro, layout } })),
      ...(['logo-wordmark-tagline-url', 'logo-tagline', 'logo-only'] as const).map((layout) => ({ outro: { ...base.outro, layout } })),
      ...(['dark-clock', 'paper', 'dark'] as const).map((style) => ({ interstitial: { ...base.interstitial, style } })),
      ...(['below', 'above', 'overlay'] as const).map((position) => ({ captions: { ...base.captions, position } })),
      ...(['crossfade', 'fade-black'] as const).map((between_scenes) => ({ transitions: { between_scenes, duration: 0.5 } })),
    ];
    for (const v of variants) {
      const t: Template = { ...base, ...v, components: undefined };
      const chosen = resolveThemeComponents(t);
      expect(() => registry.resolveTheme(t), JSON.stringify(v)).not.toThrow();
      for (const c of Object.values(chosen)) if (c) expect(IDS, c.id).toContain(c.id);
    }
  });
});

describe('built-in library renders with any theme', () => {
  it('every component renders in both themes, both variants and across its duration, deterministically', () => {
    for (const id of IDS) {
      for (const theme of [LIGHT, DARK]) {
        for (const variant of ['landscape', 'vertical', 'square'] as const) {
          for (const at of [0, 12, 45, 200]) {
            expect(() => render(id, { theme, variant, at }), `${id} ${theme.name} ${variant} ${at}`).not.toThrow();
          }
        }
      }
      expect(render(id, { at: 33 }), id).toBe(render(id, { at: 33 }));
    }
  });

  it('colours and fonts come from the theme (no colour literal in the sources)', () => {
    for (const id of IDS) {
      const src = readFileSync(join(dirOf(id), 'index.tsx'), 'utf8');
      expect(src, id).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
      expect(src, id).not.toMatch(/fontFamily:\s*['"]/);
    }
    for (const id of ['studio/intro-stack', 'studio/outro-stack', 'studio/card-title', 'studio/interstitial-clock', 'studio/caption-below']) {
      expect(render(id, { theme: LIGHT, at: 60 }), id).not.toBe(render(id, { theme: DARK, at: 60 }));
      expect(render(id, { theme: LIGHT, at: 60 }), id).toMatch(/ds-light-(display|body)/);
    }
  });

  it('layouts: their fallback rects are the manifest geometry, they draw where it says and leave the brand mark to the composition', () => {
    const marker = createElement('i', { id: 'capture' });
    type Fallback = (...a: unknown[]) => LayoutRects;
    const aspects = [16 / 9, 16 / 10, 4 / 3, 390 / 844, 820 / 1180, 1180 / 820, 1];
    for (const id of IDS.filter((x) => manifests[x].kind === 'layout')) {
      const m = manifests[id];
      const defaults = paramDefaults(m.params as never);
      const fallback = modules[id].defaultRects as Fallback;
      for (const variant of ['landscape', 'vertical', 'square'] as const) {
        const spec = m[GEOMETRY_OF[variant]]!;
        expect(spec, `${id} declares ${GEOMETRY_OF[variant]}`).toBeDefined();
        for (const aspect of aspects) {
          const g = evalLayoutGeometry(spec, defaults, { aspect });
          const r = id === 'studio/layout-raw' ? fallback(variant, 1) : id === 'studio/layout-card' ? fallback(defaults, variant, 1) : fallback(defaults, variant, 1, aspect);
          if (id === 'studio/layout-raw' || (id === 'studio/layout-card' && aspect !== 16 / 9)) continue; // aspect-free fallbacks
          const where = `${id} ${variant} ${aspect.toFixed(3)}`;
          expect(r.frame, where).toEqual(g.frame ?? g.screen);
          expect(r.screen, where).toEqual(g.screen);
          expect(r.caption, where).toEqual(g.caption);
          expect(r.brandmark, where).toEqual(g.brandmark);
          expect(r.radius, where).toBe(g.radius);
          if (g.chrome) expect(r.chrome, where).toEqual(g.chrome);
        }
        // Without rects (no plan) a layout draws its fallback rects: a phone / tablet capture for the devices.
        const fallbackAspect = id === 'studio/layout-phone' ? 390 / 844 : id === 'studio/layout-tablet' ? 820 / 1180 : 16 / 9;
        const g = evalLayoutGeometry(spec, defaults, { aspect: fallbackAspect });
        const html = render(id, { variant, extra: { screen: marker } });
        expect(html, id).toContain('<i id="capture"></i>');
        expect(html, id).not.toContain('>A</div>'); // no brand mark monogram
        const s = g.screen;
        if (id === 'studio/layout-browser') {
          // The window = frame; the page area (the capture) right under the chrome bar.
          expect(html, id).toContain(rectCss(g.frame!));
          expect(g.chrome!.h + g.screen.h, id).toBe(g.frame!.h);
          expect(g.screen.y, id).toBe(g.chrome!.y + g.chrome!.h);
          expect(html, id).toContain(`left:0;top:${g.chrome!.h}px;width:${s.w}px;height:${s.h}px`);
        } else if (id === 'studio/layout-card') {
          expect(html, `${id} ${variant}`).toContain(rectCss(g.frame!));
        } else if (id === 'studio/layout-phone') {
          // The display glass = the capture area with the status bar above it.
          const bar = s.y - g.frame!.y - (s.x - g.frame!.x);
          expect(bar, id).toBeGreaterThan(40);
          expect(html, `${id} ${variant}`).toContain(rectCss({ x: s.x, y: s.y - bar, w: s.w, h: s.h + bar }));
        } else {
          expect(html, `${id} ${variant}`).toContain(rectCss(s));
        }
        // Everything inside the design space, and the caption / brand mark never over the device or card.
        const space = { w: SIZES[variant][0], h: SIZES[variant][1] };
        for (const aspect of aspects) {
          const ga = evalLayoutGeometry(spec, defaults, { aspect });
          for (const rect of [ga.frame, ga.screen, ga.caption, ga.brandmark]) {
            if (!rect) continue;
            expect(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= space.w && rect.y + rect.h <= space.h, `${id} ${variant} ${aspect.toFixed(2)} ${JSON.stringify(rect)}`).toBe(true);
          }
          const body = ga.frame ?? ga.screen;
          const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          if (id !== 'studio/layout-raw') {
            for (const r of [ga.caption, ga.brandmark]) if (r) expect(overlaps(r, body), `${id} ${variant} ${aspect.toFixed(2)} ${JSON.stringify(r)} over ${JSON.stringify(body)}`).toBe(false);
          }
        }
      }
    }
  });

  it('device and window layouts: the screen keeps the capture aspect (letterboxed beyond the device range); captions fit below or beside', () => {
    const at = (id: string, aspect: number, params: Record<string, unknown> = {}) =>
      evalLayoutGeometry(manifests[id].geometry!, applyParamDefaults(manifests[id].params as never, params), { aspect });
    const ratio = (r: { w: number; h: number }) => r.w / r.h;
    // Browser: the page area keeps the capture aspect; window + caption block centred; tabs make the chrome taller.
    const b = at('studio/layout-browser', 16 / 9);
    expect(b.frame).toEqual({ x: 226, y: 40, w: 1468, h: 878 });
    expect(b.chrome!.h).toBe(52);
    expect(b.caption).toEqual({ x: 226, y: 930, w: 1128, h: 110 });
    expect(b.brandmark!.x + b.brandmark!.w).toBe(1694);
    expect(at('studio/layout-browser', 16 / 9, { tabs: true }).chrome!.h).toBe(86);
    for (const a of [16 / 9, 16 / 10, 4 / 3]) expect(Math.abs(ratio(at('studio/layout-browser', a).screen) - a)).toBeLessThan(0.01);
    const narrow = at('studio/layout-browser', 390 / 844);
    expect(narrow.caption!.w).toBe(640); // a narrow (mobile) window keeps a readable caption column
    // Laptop: display = capture aspect, the whole device + caption block inside 1080 with 40 px margins.
    for (const a of [16 / 9, 16 / 10, 4 / 3]) {
      const l = at('studio/layout-laptop', a);
      expect(Math.abs(ratio(l.screen) - a), String(a)).toBeLessThan(0.01);
      expect(l.frame!.y, String(a)).toBeGreaterThanOrEqual(40);
      expect(l.caption!.y + l.caption!.h, String(a)).toBeLessThanOrEqual(1040);
      expect(l.frame!.w, String(a)).toBeGreaterThan(l.screen.w * 1.15); // the base overhangs the lid
    }
    // Phone: the capture area keeps a phone aspect (0.42–0.62) under the status bar; the caption beside the phone.
    const p = at('studio/layout-phone', 390 / 844);
    expect(Math.abs(ratio(p.screen) - 390 / 844)).toBeLessThan(0.01);
    expect(p.caption!.x).toBeGreaterThan(p.frame!.x + p.frame!.w);
    expect(p.caption!.y + p.caption!.h / 2).toBeCloseTo(540, -1);
    expect(ratio(at('studio/layout-phone', 16 / 9).screen)).toBeCloseTo(0.62, 2); // a desktop capture: letterboxed in a phone-shaped screen
    expect(at('studio/layout-phone', 390 / 844, { status_bar: false }).screen.y).toBe(p.frame!.y + (p.screen.x - p.frame!.x));
    // Tablet: portrait capture → upright with the caption beside; landscape capture → lying with the caption below.
    const tp = at('studio/layout-tablet', 820 / 1180);
    expect(tp.frame).toEqual({ x: 244, y: 58, w: 696, h: 964 });
    expect(tp.caption).toEqual({ x: 1036, y: 485, w: 640, h: 110 });
    expect(Math.abs(ratio(tp.screen) - 820 / 1180)).toBeLessThan(0.01);
    const tl = at('studio/layout-tablet', 1180 / 820);
    expect(tl.frame).toEqual({ x: 347, y: 40, w: 1227, h: 878 });
    expect(tl.caption).toEqual({ x: 347, y: 930, w: 887, h: 110 });
    expect(Math.abs(ratio(tl.screen) - 1180 / 820)).toBeLessThan(0.01);
    expect(ratio(at('studio/layout-tablet', 390 / 844).screen)).toBeCloseTo(0.62, 2);
    // Raw: full frame, the caption area over the bottom of the capture.
    const raw = at('studio/layout-raw', 16 / 9);
    expect(raw.screen).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(raw.caption!.y + raw.caption!.h).toBeLessThanOrEqual(1080);
    expect(raw.brandmark).toBeUndefined();
  });

  it('layouts paint the theme background around a letterboxed capture (rects.display)', () => {
    const display = { x: 368, y: 163, w: 389, h: 807 };
    const screenRect = { x: 368, y: 456.6, w: 389, h: 219 };
    const rects: LayoutRects = { frame: { x: 348, y: 90, w: 429, h: 900 }, screen: screenRect, display, radius: 50, caption: { x: 873, y: 485, w: 700, h: 110 } };
    const html = render('studio/layout-phone', { extra: { rects, screen: createElement('i', { id: 'capture' }) } });
    // The display (and its status bar) where the planner declared it, the theme background in it, the capture inside.
    expect(html).toMatch(/left:368px;top:1\d\dpx;width:389px;height:8\d\dpx;border-radius:50px;background:radial-gradient/);
    expect(html).toContain('left:0;top:346.6px;width:389px;height:219px');
    const tablet = render('studio/layout-tablet', { extra: { rects: { ...rects, display: { x: 300, y: 100, w: 600, h: 860 }, screen: { x: 300, y: 361, w: 600, h: 338 } } } });
    expect(tablet).toMatch(/left:300px;top:100px;width:600px;height:860px;border-radius:50px;background:radial-gradient/);
  });

  it('layout-browser: the address bar shows the real URL (host emphasised, path quieter), following navigation', () => {
    const at = (url?: string, params: Record<string, unknown> = {}) => render('studio/layout-browser', { params, extra: { url } });
    const a = at('https://shop.example.com/products/selowa-ridge?ref=1#top');
    expect(a).toContain('>shop.example.com</span>');
    expect(a).toContain('/products/selowa-ridge?ref=1</span>');
    expect(a).not.toContain('#top');
    expect(a).toContain('M7 11V8a5 5 0 0 1 10 0v3'); // https: a lock
    const b = at('http://localhost:4402/quotes/q-1');
    expect(b).toContain('>localhost:4402</span>');
    expect(b).toContain('/quotes/q-1</span>');
    expect(b).not.toContain('M7 11V8a5 5 0 0 1 10 0v3');
    expect(at('https://shop.example.com/', { show_url: false })).not.toContain('shop.example.com');
    expect(at('https://shop.example.com/', { tabs: true })).toMatch(/text-overflow:ellipsis">shop\.example\.com<\/span>/);
    // Window controls: the system colours, or quiet theme-tinted dots.
    expect(at('https://x.test/')).toContain('background:#ff5f57');
    expect(at('https://x.test/', { controls: 'theme' })).not.toContain('#ff5f57');
    // A dark theme background gets a dark toolbar.
    expect(render('studio/layout-browser', { theme: DARK, extra: { url: 'https://x.test/' } })).not.toBe(at('https://x.test/'));
  });

  it('layout-card: the geometry follows width (16:9 capture: card, caption and brand mark move together); the reference rects at the default', () => {
    const m = manifests['studio/layout-card'];
    const at = (width: number, aspect = 16 / 9) => evalLayoutGeometry(m.geometry!, { width, radius: 18, shadow: 'soft' }, { aspect });
    // look.md: card x 180, y 40, 1560 × 878; caption block below (y 930 → kicker 957, line 996); brand mark centred at y 985.
    expect(at(1560)).toEqual({
      screen: { x: 180, y: 40, w: 1560, h: 878 },
      frame: { x: 180, y: 40, w: 1560, h: 878 },
      caption: { x: 180, y: 930, w: 1220, h: 110 },
      brandmark: { x: 1420, y: 965, w: 320, h: 40 },
      radius: 18,
    });
    const narrow = at(1400);
    expect(narrow.frame).toEqual({ x: 260, y: 85, w: 1400, h: 788 });
    expect(narrow.caption).toEqual({ x: 260, y: 885, w: 1060, h: 110 });
    expect(narrow.brandmark!.x + narrow.brandmark!.w).toBe(1660);
    // Block centred: as much room above the card as below the caption block.
    expect(narrow.frame!.y).toBe(1080 - (narrow.caption!.y + narrow.caption!.h));
    // Too wide for the caption to fit below a 16:9 card: capped at the reference card.
    expect(at(1920).frame).toEqual({ x: 180, y: 40, w: 1560, h: 878 });
    // A 16:10 capture: the card keeps its aspect (narrower), the caption stays aligned with it.
    const tall = at(1560, 1.6);
    expect(tall.frame).toEqual({ x: 258, y: 40, w: 1404, h: 878 });
    expect(tall.caption!.x).toBe(258);
    // The component's fallback rects (previews, no plan) are the manifest geometry.
    const defaultRects = modules['studio/layout-card'].defaultRects as (p: { width: number; radius: number }, v: 'landscape' | 'vertical', unit: number) => LayoutRects;
    for (const width of [1200, 1400, 1560, 1700]) {
      const g = at(width);
      const r = defaultRects({ width, radius: 18 }, 'landscape', 1);
      expect(r.frame, String(width)).toEqual(g.frame);
      expect(r.caption, String(width)).toEqual(g.caption);
      expect(r.brandmark, String(width)).toEqual(g.brandmark);
    }
    const gv = evalLayoutGeometry(m.geometry_vertical!, { width: 1560, radius: 18 });
    const rv = defaultRects({ width: 1560, radius: 18 }, 'vertical', 1);
    expect([rv.frame, rv.caption, rv.brandmark]).toEqual([gv.frame, gv.caption, gv.brandmark]);
  });

  it('layout-card draws at the rects the planner passes (rounded card, soft shadow tinted with the theme dark tone)', () => {
    const rects: LayoutRects = { screen: { x: 260, y: 85.5, w: 1400, h: 787 }, frame: { x: 260, y: 85, w: 1400, h: 788 }, radius: 24, caption: { x: 260, y: 885, w: 1060, h: 110 } };
    const html = render('studio/layout-card', { extra: { rects, screen: createElement('i', { id: 'capture' }) } });
    expect(html).toContain(rectCss(rects.frame));
    expect(html).toContain('border-radius:24px');
    // The capture inside the card, relative to it.
    expect(html).toContain('left:0;top:0.5px;width:1400px;height:787px');
    expect(html).toContain('rgba(31, 20, 19, 0.16)'); // LIGHT text #1f1413 at 16 %
    expect(render('studio/layout-card', { params: { shadow: 'none' } })).toContain('box-shadow:none');
    // A dark background gets a hairline so the card edge reads.
    expect(render('studio/layout-card', { theme: DARK })).toMatch(/0 0 0 1px rgba\(245, 246, 250, 0\.1\)/);
  });

  it('caption-below shows the active cue in the caption area; caption-overlay a band', () => {
    const cues = [
      { from: 0, to: 60, text: 'First caption', kicker: 'One', scene: 'a' },
      { from: 60, to: 120, text: 'Second caption', scene: 'b' },
    ];
    const area = { x: 180, y: 930, w: 1220, h: 110 };
    const below = render('studio/caption-below', { at: 30, extra: { cues, area } });
    expect(below).toContain('First caption');
    expect(below).toContain('ONE'); // the kicker, upper-cased by the theme kicker style
    // look.md: rule 36 × 2 at x 186 (area x + 6), centred on the kicker row (y 958 = area y + 28); kicker after a 12 px gap.
    expect(below).toContain('left:186px;top:957px;width:36px;height:2px');
    expect(below).toMatch(/left:234px;top:-?[\d.]+px/);
    expect(render('studio/caption-below', { at: 90, extra: { cues, area } })).toContain('Second caption');
    expect(render('studio/caption-below', { at: 130, extra: { cues, area } })).toBe('');
    expect(render('studio/caption-overlay', { at: 30, extra: { cues } })).toContain('First caption');
  });

  it('caption-below timing: the line changes (out 0.25 s, in 0.35 s with a rise) under a kicker shared by contiguous cues', () => {
    const area = { x: 180, y: 930, w: 1220, h: 110 };
    const cues = [
      { from: 0, to: 60, text: 'Old line', kicker: 'Same', scene: 'a' },
      { from: 60, to: 120, text: 'New line', kicker: 'Same', scene: 'a' },
    ];
    const layers = (at: number) => {
      const html = render('studio/caption-below', { at, extra: { cues, area, durationInFrames: 120 } });
      const op = [...html.matchAll(/position:absolute;inset:0;opacity:([\d.]+);transform:translateY\(([\d.-]+)px\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      return { html, kicker: op[0], line: op[1] };
    };
    // At the clip start the caption waits ~0.15 s (it would double-expose with the previous clip's in a crossfade).
    expect(layers(0).line[0]).toBe(0);
    expect(layers(4).line[0]).toBe(0);
    expect(layers(12).line[0]).toBeGreaterThan(0.5);
    // Mid-cue: everything settled.
    expect(layers(40).line).toEqual([1, 0]);
    // Old line fading out over its last 0.25 s; the kicker stays (same kicker, contiguous cues).
    const end = layers(57);
    expect(end.html).toContain('Old line');
    expect(end.line[0]).toBeLessThan(0.7);
    expect(end.kicker[0]).toBe(1);
    // New line: rises in (a few px below its place, partly transparent), kicker untouched.
    const start = layers(62);
    expect(start.html).toContain('New line');
    expect(start.line[0]).toBeGreaterThan(0);
    expect(start.line[0]).toBeLessThan(1);
    expect(start.line[1]).toBeGreaterThan(0);
    expect(start.line[1]).toBeLessThanOrEqual(7);
    expect(start.kicker).toEqual([1, 0]);
    // The last cue leaves before the clip ends (fully gone in the last ~0.15 s).
    expect(layers(116).line[0]).toBe(0);
  });

  it('interstitial-clock: night veil over the last frame, then the clock (minute hand ≈ one turn) and the text', () => {
    const screen = createElement('i', { id: 'last-frame' });
    const n = 78;
    const at = (f: number, theme: ThemeTokens = LIGHT) => render('studio/interstitial-clock', { at: f, theme, extra: { screen, durationInFrames: n } });
    const veil = (html: string) => Number(/background:#1f1413;opacity:([\d.]+)/.exec(html)?.[1]);
    const angle = (html: string) => Number(/stroke-width="3.5" stroke-linecap="round" transform="rotate\(([\d.-]+)\)"/.exec(html)?.[1]);
    expect(at(0)).toContain('<i id="last-frame"></i>');
    expect(veil(at(0))).toBe(0);
    // Gentle at first (the last frame stays readable while the clock and text appear), full dark card by 0.6 s.
    expect(veil(at(6))).toBeLessThan(0.3);
    expect(veil(at(12))).toBeGreaterThan(0.3);
    expect(veil(at(12))).toBeLessThan(0.75);
    expect(veil(at(18))).toBe(1);
    expect(angle(at(5))).toBe(0);
    expect(angle(at(40))).toBeGreaterThan(90);
    expect(angle(at(40))).toBeLessThan(270);
    expect(angle(at(n - 1))).toBeGreaterThan(340);
    // Ring: between the night tone and the paper (warm, quiet); hour hand in the accent; text in the paper colour.
    expect(at(40)).toContain('stroke="#544b48"');
    expect(at(40)).toContain('stroke="#8a2332"');
    expect(at(40)).toContain('color:#f3eee8');
    // A theme's colors.dark is the night tone.
    expect(at(30, { ...LIGHT, colors: { ...LIGHT.colors, dark: '#101820' } })).toContain('background:#101820');
  });

  it('style_bias: real is the subtle reference motion; balanced / motion are livelier at the same moment, identical once settled', () => {
    for (const id of ['studio/intro-stack', 'studio/outro-stack', 'studio/interstitial-clock']) {
      const real = render(id, { theme: LIGHT, at: 20 });
      const lively = render(id, { theme: { ...LIGHT, style_bias: 'motion' }, at: 20 });
      expect(lively, id).not.toBe(real);
    }
    const cues = [{ from: 0, to: 120, text: 'A caption', kicker: 'Kicker', scene: 'a' }];
    const area = { x: 180, y: 930, w: 1220, h: 110 };
    expect(render('studio/caption-below', { at: 8, theme: { ...LIGHT, style_bias: 'balanced' }, extra: { cues, area } })).not.toBe(render('studio/caption-below', { at: 8, extra: { cues, area } }));
    const screen = createElement('i', null, 'segment');
    const xf = (bias: ThemeTokens['style_bias']) => render('studio/transition-crossfade', { at: 3, theme: { ...LIGHT, style_bias: bias }, extra: { screen, direction: 'entering', durationInFrames: 11 } });
    expect(xf('real')).not.toContain('scale(');
    expect(xf('motion')).toMatch(/scale\(1\.0\d+\)/);
  });

  it('intro and outro: the wordmark is the brand name in the display font when the theme has no wordmark image', () => {
    for (const id of ['studio/intro-stack', 'studio/outro-stack']) {
      const html = render(id, { theme: LIGHT, at: 80 });
      expect(html, id).toMatch(/font-family:&quot;ds-light-display&quot;, serif;font-size:[\d.]+px[^>]*>Atelier<\/span>/);
      expect(render(id, { theme: DARK, at: 80 }), id).toContain('src="http://assets.local/wordmark.svg"');
    }
  });

  it('transitions: the crossfade fades the entering segment in; the dip is opaque at the cut', () => {
    const screen = createElement('i', null, 'segment');
    const opacity = (html: string) => Number(/opacity:([\d.]+)/.exec(html)?.[1]);
    const n = 11;
    const xf = (at: number, direction: 'entering' | 'exiting') => render('studio/transition-crossfade', { at, extra: { screen, direction, durationInFrames: n } });
    expect(opacity(xf(0, 'entering'))).toBeGreaterThan(0);
    expect(opacity(xf(0, 'entering'))).toBeLessThan(0.1);
    expect(opacity(xf(5, 'entering'))).toBeGreaterThan(0.3);
    expect(opacity(xf(10, 'entering'))).toBeGreaterThan(0.9);
    expect(opacity(xf(5, 'exiting'))).toBe(1);
    const veil = (html: string) => Number(/background:black;opacity:([\d.]+)/.exec(html)?.[1]);
    const dip = (at: number, direction: 'entering' | 'exiting') => render('studio/transition-fade-black', { at, extra: { screen, direction, durationInFrames: 12 } });
    expect(veil(dip(0, 'exiting'))).toBeLessThan(0.2);
    expect(veil(dip(5, 'exiting'))).toBe(1);
    expect(veil(dip(6, 'entering'))).toBeGreaterThan(0.75);
    expect(veil(dip(11, 'entering'))).toBeLessThan(0.2);
  });

  it('caption-overlay: a band over the bottom of a wide capture, the caption area for a narrow one (phones) or with position: area', () => {
    const cues = [{ from: 0, to: 120, text: 'A caption over the capture', kicker: 'Band', scene: 'a' }];
    const band = (html: string) => {
      const m = /left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px;border-radius:16px/.exec(html);
      return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : undefined;
    };
    const wide: LayoutRects = { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, caption: { x: 180, y: 930, w: 1220, h: 110 }, radius: 18 };
    const over = band(render('studio/caption-overlay', { at: 40, extra: { cues, rects: wide, area: wide.caption } }))!;
    expect(over.y + over.h).toBeCloseTo(40 + 878 - 40, 0); // 40 px above the capture's bottom
    expect(over.x + over.w / 2).toBeCloseTo(180 + 1560 / 2, 0); // centred on the capture
    const asArea = band(render('studio/caption-overlay', { at: 40, params: { position: 'area' }, extra: { cues, rects: wide, area: wide.caption } }))!;
    expect(asArea.y).toBeGreaterThanOrEqual(930);
    const phone: LayoutRects = { screen: { x: 368, y: 163, w: 389, h: 807 }, frame: { x: 348, y: 90, w: 429, h: 900 }, caption: { x: 873, y: 485, w: 700, h: 110 }, radius: 50 };
    const side = band(render('studio/caption-overlay', { at: 40, extra: { cues, rects: phone, area: phone.caption } }))!;
    expect(side.x).toBeGreaterThanOrEqual(873);
    // Light type on the theme's night tone, the kicker in the accent when it reads there.
    const html = render('studio/caption-overlay', { at: 40, extra: { cues, rects: wide } });
    expect(html).toContain('rgba(31, 20, 19, 0.84)');
    expect(html).toContain('A caption over the capture');
    expect(html).toContain('BAND');
    // The kit's band box is what the review measures.
    expect(captionBandBox({ rects: wide, area: wide.caption, width: 1920, height: 1080, unit: 1, position: 'over', maxWidth: 1400 })).toEqual({ box: { x: 260, y: 728, w: 1400, h: 150 }, over: true });
  });

  it('overlay-callout: placed above (below when there is no room), never off-screen, pointer toward the target', () => {
    const place = modules['studio/overlay-callout'].placeCallout as (o: Record<string, unknown>) => { x: number; y: number; below: boolean; pointer?: number };
    const bounds = { x: 58, y: 32, w: 1804, h: 1016 };
    for (const ax of [-200, 0, 30, 400, 960, 1800, 1900, 2400]) {
      for (const ay of [-100, 0, 20, 300, 540, 1000, 1070, 1300]) {
        const anchor = { x: ax, y: ay, w: 160, h: 40 };
        const p = place({ anchor, w: 420, h: 52, bounds, gap: 16, arrow: 9, placement: 'auto' });
        const where = `${ax},${ay}`;
        expect(p.x, where).toBeGreaterThanOrEqual(bounds.x);
        expect(p.y, where).toBeGreaterThanOrEqual(bounds.y);
        expect(p.x + 420, where).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-6);
        expect(p.y + 52, where).toBeLessThanOrEqual(bounds.y + bounds.h + 1e-6);
        expect(p.pointer!, where).toBeGreaterThanOrEqual(26);
        expect(p.pointer!, where).toBeLessThanOrEqual(420 - 26);
      }
    }
    const top = place({ anchor: { x: 900, y: 40, w: 160, h: 40 }, w: 420, h: 52, bounds, gap: 16, arrow: 9, placement: 'auto' });
    expect(top.below).toBe(true);
    const mid = place({ anchor: { x: 900, y: 600, w: 160, h: 40 }, w: 420, h: 52, bounds, gap: 16, arrow: 9, placement: 'auto' });
    expect(mid.below).toBe(false);
    expect(mid.y + 52 + 9 + 16).toBe(600);
    expect(mid.x + mid.pointer!).toBe(980); // the pointer at the target's centre
    // Rendered: a ring around the target, the pill inside the capture.
    const anchor = { x: 1398, y: 530, w: 209, h: 57 };
    const html = render('studio/overlay-callout', { at: 30, extra: { anchor, rects: { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, radius: 18 } } });
    expect(html).toContain('Totals update as you type');
    expect(html).toContain('LIVE');
    expect(html).toContain('left:1392px;top:524px;width:221px;height:69px'); // ring: the target + 6 px
    expect(render('studio/overlay-callout', { at: 30, params: { highlight: false }, extra: { anchor } })).not.toContain('left:1392px;top:524px');
  });

  it('cards, intros, outros, interstitials: tones, logo-only variants', () => {
    // card-title: the theme background, or the night tone with light type.
    const card = render('studio/card-title', { at: 60 });
    expect(card).toContain('From quote to order');
    expect(card).toContain('CHAPTER TWO');
    expect(render('studio/card-title', { at: 60, params: { tone: 'dark' } })).toContain('background:#1f1413');
    // intro-minimal: kicker + title, or logo + wordmark only.
    expect(render('studio/intro-minimal', { at: 60 })).toContain('Quotes in two clicks');
    const logoOnly = render('studio/intro-minimal', { at: 60, params: { logo_only: true } });
    expect(logoOnly).not.toContain('Quotes in two clicks');
    expect(logoOnly).toMatch(/>Atelier<\/span>/);
    expect(render('studio/outro-minimal', { at: 60 })).toContain('Ready when you are.');
    expect(render('studio/outro-minimal', { at: 60, params: { logo_only: true } })).toMatch(/>Atelier<\/span>/);
    // interstitial-plain: the night tone (dark) or the theme paper (paper) over the last frame; a filling accent line.
    const screen = createElement('i', { id: 'last-frame' });
    const dark = render('studio/interstitial-plain', { at: 40, extra: { screen } });
    expect(dark).toContain('<i id="last-frame"></i>');
    expect(dark).toContain('background:#1f1413;opacity:1');
    expect(render('studio/interstitial-plain', { at: 40, params: { tone: 'paper' }, extra: { screen } })).toContain('background:#f3eee8;opacity:1');
    expect(render('studio/interstitial-plain', { at: 40, theme: DARK, params: { tone: 'paper' } })).toContain(`background:${DARK.colors.paper}`);
    // lower third: inside the capture, clear of the caption area below it.
    const lower = render('studio/overlay-lower-third', { at: 40, extra: { rects: { screen: { x: 180, y: 40, w: 1560, h: 878 }, frame: { x: 180, y: 40, w: 1560, h: 878 }, radius: 18 } } });
    const box = /left:([\d.]+)px;top:([\d.]+)px;width:([\d.]+)px;height:([\d.]+)px;opacity/.exec(lower)!;
    expect(Number(box[1])).toBe(216);
    expect(Number(box[2]) + Number(box[4])).toBeCloseTo(40 + 878 - 36, 1);
  });

  it('overlays: the callout points at its anchor; the lower third ignores it', () => {
    const anchor = { x: 1398, y: 530, w: 209, h: 57 };
    const callout = render('studio/overlay-callout', { at: 30, extra: { anchor } });
    expect(callout).toContain('Totals update as you type');
    const lower = render('studio/overlay-lower-third', { at: 30, extra: { anchor } });
    expect(lower).toContain('Orders sync with the warehouse');
    expect(lower).toContain('BEHIND THE SCENES');
  });
});
