/**
 * The built-in library (packages/components/library/studio/*): a component for every id the starter templates and the
 * legacy template fields refer to — the six reference-look components (L2.5: intro-stack, outro-stack, layout-card,
 * caption-below, interstitial-clock, transition-crossfade) and placeholders for the rest (tag `placeholder`, until
 * L2.7). Each one validates (manifest + compile), accepts the params the themes pass, renders with any theme
 * (react-dom/server, remotion's frame hook mocked) and — for layouts — draws its screen where its geometry says.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTemplate, resolveThemeComponents } from '@demo-studio/core';
import type { Template } from '@demo-studio/core';
import { LIBRARY_DIR, applyParamDefaults, evalLayoutGeometry, loadComponentRegistry, paramDefaults, parseManifest, validateComponentDir } from '@demo-studio/components';
import type { ComponentManifest, ComponentProps, ComponentRegistry, LayoutRects, ThemeTokens } from '@demo-studio/components';
import { DARK, LIGHT, tempDir } from './helpers.js';

const frame = vi.hoisted(() => ({ current: 0 }));

vi.mock('remotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remotion')>();
  const { createElement: h } = await import('react');
  return { ...actual, useCurrentFrame: () => frame.current, Img: (props: Record<string, unknown>) => h('img', props) };
});

const REPO = new URL('../../../', import.meta.url).pathname;

/** Every id referenced by the starter templates and the legacy field mapping (DESIGN-phase2 §1.2, §1.4). */
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
  'studio/caption-below',
  'studio/caption-overlay',
  'studio/overlay-callout',
  'studio/overlay-lower-third',
  'studio/transition-crossfade',
  'studio/transition-fade-black',
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

function render(id: string, opts: { theme?: ThemeTokens; at?: number; unit?: number; vertical?: boolean; params?: Record<string, unknown>; extra?: Partial<ComponentProps> } = {}): string {
  const m = manifests[id];
  const unit = opts.unit ?? 1;
  const fps = 30;
  frame.current = opts.at ?? 45;
  const props: ComponentProps = {
    theme: opts.theme ?? LIGHT,
    slots: { ...(m.preview?.slots ?? {}) },
    params: applyParamDefaults(m.params as never, opts.params ?? {}),
    unit,
    width: (opts.vertical ? 1080 : 1920) * unit,
    height: (opts.vertical ? 1920 : 1080) * unit,
    fps,
    durationInFrames: Math.round((m.duration?.default ?? 4) * fps),
    variant: opts.vertical ? 'vertical' : 'landscape',
    ...opts.extra,
  };
  return renderToString(createElement(impls[id], props));
}

const rectCss = (r: { x: number; y: number; w: number; h: number }) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

describe('built-in library: a component for every referenced id', () => {
  it('has exactly the referenced ids, each valid (manifest + compile); the reference look is final, the rest placeholders', async () => {
    const found = readdirSync(join(LIBRARY_DIR, 'studio')).map((n) => `studio/${n}`).sort();
    expect(found).toEqual([...IDS].sort());
    for (const id of IDS) {
      const v = await validateComponentDir(dirOf(id));
      expect(v.issues, id).toEqual([]);
      expect(v.ok, id).toBe(true);
      expect(registry.get(id).source, id).toBe('builtin');
      if (REFERENCE_LOOK.includes(id)) {
        expect(manifests[id].tags, id).toContain('reference-look');
        expect(manifests[id].tags, id).not.toContain('placeholder');
        expect(manifests[id].version, id).toBe('1.0.0');
        // style_bias is read (R-TPL-04) — except by the card layout, static at every bias by design (a frame never
        // moves on its own; camera and transitions do).
        if (id !== 'studio/layout-card') expect(manifests[id].tokens, id).toContain('style_bias');
      } else {
        expect(manifests[id].tags, id).toContain('placeholder');
      }
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
        for (const vertical of [false, true]) {
          for (const at of [0, 12, 45, 200]) {
            expect(() => render(id, { theme, vertical, at }), `${id} ${theme.name} ${vertical} ${at}`).not.toThrow();
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

  it('layouts draw the screen where their geometry says (landscape and vertical) and leave the brand mark to the composition', () => {
    const marker = createElement('i', { id: 'capture' });
    for (const id of IDS.filter((x) => manifests[x].kind === 'layout')) {
      const m = manifests[id];
      const defaults = paramDefaults(m.params as never);
      for (const vertical of [false, true]) {
        const g = evalLayoutGeometry(vertical ? m.geometry_vertical! : m.geometry!, defaults);
        const html = render(id, { vertical, extra: { screen: marker } });
        expect(html, id).toContain('<i id="capture"></i>');
        if (id === 'studio/layout-browser') {
          // Window = frame; the screen is the frame below the chrome bar.
          expect(html, id).toContain(rectCss(g.frame!));
          expect(g.chrome!.h + g.screen.h, id).toBe(g.frame!.h);
          expect(g.screen.y, id).toBe(g.chrome!.y + g.chrome!.h);
          expect(html, id).toContain(`top:${g.chrome!.h}px`);
        } else if (id === 'studio/layout-raw') {
          expect(g.screen, id).toEqual(vertical ? { x: 0, y: 0, w: 1080, h: 1920 } : { x: 0, y: 0, w: 1920, h: 1080 });
        } else if (id === 'studio/layout-card') {
          // The card (frame) at its rect, the capture at the screen rect inside it.
          expect(html, `${id} ${vertical}`).toContain(rectCss(g.frame!));
        } else {
          expect(html, `${id} ${vertical}`).toContain(rectCss(g.screen));
        }
        expect(html, id).not.toContain('>A</div>'); // no brand mark monogram
      }
    }
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
    const veil = (html: string) => Number(/background:#000000;opacity:([\d.]+)/.exec(html)?.[1]);
    const dip = (at: number, direction: 'entering' | 'exiting') => render('studio/transition-fade-black', { at, extra: { screen, direction, durationInFrames: 12 } });
    expect(veil(dip(0, 'exiting'))).toBeLessThan(0.2);
    expect(veil(dip(5, 'exiting'))).toBe(1);
    expect(veil(dip(6, 'entering'))).toBeGreaterThan(0.8);
    expect(veil(dip(11, 'entering'))).toBeLessThan(0.2);
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
