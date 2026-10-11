/**
 * The built-in library (packages/components/library/studio/*): placeholder components for every id the starter
 * templates and the legacy template fields refer to. Each one validates (manifest + compile), is tagged
 * `placeholder`, accepts the params the themes pass, renders with any theme (react-dom/server, remotion's frame hook
 * mocked) and — for layouts — draws its screen where its geometry says.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadTemplate, resolveThemeComponents } from '@demo-studio/core';
import type { Template } from '@demo-studio/core';
import { LIBRARY_DIR, applyParamDefaults, loadComponentRegistry, parseManifest, validateComponentDir } from '@demo-studio/components';
import type { ComponentManifest, ComponentProps, ComponentRegistry, ThemeTokens } from '@demo-studio/components';
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

const dirOf = (id: string) => join(LIBRARY_DIR, ...id.split('/'));
const manifests: Record<string, ComponentManifest> = {};
const impls: Record<string, ComponentType<ComponentProps>> = {};
let registry: ComponentRegistry;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  for (const id of IDS) {
    manifests[id] = parseManifest(readFileSync(join(dirOf(id), 'component.yaml'), 'utf8'), 'component.yaml', { folderId: id }).manifest!;
    impls[id] = ((await import(join(dirOf(id), 'index.tsx'))) as { default: ComponentType<ComponentProps> }).default;
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

describe('built-in library: placeholders for every referenced id', () => {
  it('has exactly the referenced ids, each valid (manifest + compile) and tagged placeholder', async () => {
    const found = readdirSync(join(LIBRARY_DIR, 'studio')).map((n) => `studio/${n}`).sort();
    expect(found).toEqual([...IDS].sort());
    for (const id of IDS) {
      const v = await validateComponentDir(dirOf(id));
      expect(v.issues, id).toEqual([]);
      expect(v.ok, id).toBe(true);
      expect(manifests[id].tags, id).toContain('placeholder');
      expect(registry.get(id).source, id).toBe('builtin');
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
      for (const vertical of [false, true]) {
        const g = vertical ? m.geometry_vertical! : m.geometry!;
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
        } else {
          expect(html, `${id} ${vertical}`).toContain(rectCss(g.screen));
        }
        expect(html, id).not.toContain('>A</div>'); // no brand mark monogram
      }
    }
    // layout-card accepts the width the themes pass but draws its declared geometry (what the planner places captions
    // and overlays against) until geometry follows params (L2.5).
    expect(render('studio/layout-card', { params: { width: 1600 } })).toContain(rectCss(manifests['studio/layout-card'].geometry!.screen));
    expect(manifests['studio/layout-card'].geometry?.screen).toEqual({ x: 180, y: 40, w: 1560, h: 877.5 });
  });

  it('caption-below shows the active cue in the caption area; caption-overlay a band', () => {
    const cues = [
      { from: 0, to: 60, text: 'First caption', kicker: 'One', scene: 'a' },
      { from: 60, to: 120, text: 'Second caption', scene: 'b' },
    ];
    const area = { x: 180, y: 930, w: 1560, h: 110 };
    const below = render('studio/caption-below', { at: 30, extra: { cues, area } });
    expect(below).toContain('First caption');
    expect(below).toContain('One');
    expect(below).toContain(rectCss(area));
    expect(render('studio/caption-below', { at: 90, extra: { cues, area } })).toContain('Second caption');
    expect(render('studio/caption-below', { at: 130, extra: { cues, area } })).toBe('');
    expect(render('studio/caption-overlay', { at: 30, extra: { cues } })).toContain('First caption');
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
