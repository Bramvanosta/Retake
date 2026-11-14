/**
 * L2.11 contracts in core: multi-page scenes (`pages:` map or list, `on:`), viewport presets, positioned validation,
 * the timeline's tracks and scene pages.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PACING,
  MULTI_PAGE_LAYOUTS,
  TimelineSchema,
  VIEWPORT_PRESETS,
  isMultiPageScene,
  parseProjectYaml,
  parseScenario,
  resolveScenePages,
  resolveViewport,
  scenePageEntries,
  splitPageOpen,
  stepPageOf,
} from '@retake/core';
import type { LoadedProject, Scene, Timeline, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';
import { memoryFileFacts } from '@retake/core';

/** No disk: these checks are handed a project but look at no file (L7.34: a FileFacts is required beside a project). */
const NO_DISK = memoryFileFacts({});

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}${i.line ? `@${i.line}` : ''}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

function project(): LoadedProject {
  const dir = mkdtempSync(join(tmpdir(), 'ds-multipage-'));
  const { config } = parseProjectYaml(['name: Demo', 'environments:', '  local:', '    shop: http://localhost:4402', '    console: http://localhost:4401', ''].join('\n'));
  return { slug: 'demo', dir, root: dir, config: config!, readme: null, scenarios: [], file: join(dir, 'project.yaml') };
}

const scenario = (scene: string[]) => ['video: demo', 'scenes:', ...scene.map((l) => `  ${l}`), ''].join('\n');

describe('multi-page scenes: syntax (R-MPC-04)', () => {
  it('accepts a map of pages, `<page>:<path>` opens, presets and `on:`', () => {
    const text = scenario([
      '- id: request',
      '  frame: split',
      '  pages:',
      '    buyer: {open: "shop:/products/selowa-ridge", label: Buyer}',
      '    supplier: {open: "console:/quotes", viewport: laptop, cursor: {x: 1200, y: 400}}',
      '  steps:',
      '    - click: Request a quote',
      '    - on: supplier',
      '      wait_for: {text: Demo Café}',
    ]);
    const r = parseScenario(text, { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([]);
    expect(warns(r.issues)).toEqual([]);
    const scene = r.scenario!.scenes[0] as Scene;
    expect(isMultiPageScene(scene)).toBe(true);
    const pages = resolveScenePages(scene, { capture: { width: 1920, height: 1080 }, envPages: ['shop', 'console'] });
    expect(pages).toEqual([
      { id: 'buyer', page: 'shop', open: { url: '/products/selowa-ridge', absolute: false }, viewport: { width: 1920, height: 1080, mobile: false, touch: false, preset: 'desktop' }, label: 'Buyer' },
      {
        id: 'supplier',
        page: 'console',
        open: { url: '/quotes', absolute: false },
        viewport: { width: 1440, height: 900, mobile: false, touch: false, preset: 'laptop' },
        cursor: { x: 1200, y: 400 },
      },
    ]);
    expect(stepPageOf({}, pages)).toBe('buyer');
    expect(stepPageOf({ on: 'supplier' }, pages)).toBe('supplier');
    expect(MULTI_PAGE_LAYOUTS).toEqual({ split: 'studio/layout-split', pip: 'studio/layout-pip' });
  });

  it('accepts a list of environment pages and viewport presets (desktop + mobile), ids derived', () => {
    const text = scenario([
      '- id: both',
      '  frame: pip',
      '  pages:',
      '    - {page: shop, open: /products/selowa-ridge}',
      '    - {page: shop, open: /products/selowa-ridge, viewport: mobile}',
      '  steps:',
      '    - on: shop-mobile',
      '      click: Request a quote',
    ]);
    const r = parseScenario(text, { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([]);
    const scene = r.scenario!.scenes[0] as Scene;
    expect(scenePageEntries(scene.pages).map((e) => e.id)).toEqual(['shop', 'shop-mobile']);
    const [, mobile] = resolveScenePages(scene, { capture: { width: 1920, height: 1080 }, envPages: ['shop', 'console'] });
    expect(mobile.viewport).toEqual({ width: 390, height: 844, mobile: true, touch: true, preset: 'mobile' });
    // Plain strings: environment pages (or pages of an earlier scene) continuing as they are.
    expect(scenePageEntries(['shop', 'console']).map((e) => e.id)).toEqual(['shop', 'console']);
    const cont = resolveScenePages(
      { id: 'next', pages: ['shop', 'buyer'] },
      {
        capture: { width: 1920, height: 1080 },
        envPages: ['shop', 'console'],
        known: (id) => (id === 'buyer' ? { page: 'shop', viewport: { width: 1440, height: 900, mobile: false, touch: false, preset: 'laptop' }, label: 'Buyer' } : undefined),
      },
    );
    expect(cont).toEqual([
      { id: 'shop', page: 'shop', viewport: { width: 1920, height: 1080, mobile: false, touch: false, preset: 'desktop' } },
      { id: 'buyer', page: 'shop', viewport: { width: 1440, height: 900, mobile: false, touch: false, preset: 'laptop' }, label: 'Buyer' },
    ]);
  });

  it('resolves viewports and page prefixes', () => {
    expect(resolveViewport(undefined, { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720, mobile: false, touch: false, preset: 'desktop' });
    expect(resolveViewport('tablet', { width: 1920, height: 1080 })).toMatchObject({ ...VIEWPORT_PRESETS.tablet, preset: 'tablet' });
    expect(resolveViewport({ width: 600, height: 900, mobile: true }, { width: 1920, height: 1080 })).toEqual({ width: 600, height: 900, mobile: true, touch: true });
    expect(() => resolveViewport('watch' as never, { width: 1, height: 1 })).toThrow(/unknown viewport preset "watch"/);
    expect(splitPageOpen('shop:/x', ['shop'])).toEqual({ page: 'shop', path: '/x' });
    expect(splitPageOpen('https://example.com', ['shop'])).toBeNull();
    expect(() => resolveScenePages({ id: 's', pages: { a: { open: '/x' }, b: {} } }, { capture: { width: 1, height: 1 }, envPages: ['shop'] })).toThrow(
      /relative but the page names no environment page/,
    );
    expect(DEFAULT_PACING.page_switch_ms).toBe(500);
  });
});

describe('multi-page scenes: validation (positioned)', () => {
  it('reports unknown pages, `on:` outside a multi-page scene, presets, counts and tab switching', () => {
    const text = scenario([
      '- id: one',
      '  page: shop',
      '  open: /',
      '  steps:',
      '    - on: shop',
      '      click: Coffees',
      '- id: two',
      '  page: shop',
      '  pages:',
      '    buyer: {open: "shpo:/products"}',
      '    supplier: {page: consol, open: /quotes, viewport: watch}',
      '  steps:',
      '    - on: suplier',
      '      click: Quote requests',
      '    - switch_page: buyer',
      '    - open: {url: /x, page: shop}',
      '- id: three',
      '  pages: {solo: {page: shop, open: /}}',
      '  steps: [{click: Coffees}]',
      '- id: four',
      '  pages:',
      '    - {page: shop, open: /}',
      '    - {page: shop, open: /coffees}',
      '  steps: [{click: Coffees}]',
    ]);
    const r = parseScenario(text, { files: NO_DISK, project: project() });
    const e = errs(r.issues);
    const has = (path: string, re: RegExp) =>
      expect(
        e.some((m) => m.startsWith(path) && re.test(m)),
        `${path} ${re} in\n${e.join('\n')}`,
      ).toBe(true);
    has('scenes.0.steps.0.on', /only applies|multi-page scene \(a scene with `pages`\)/);
    has('scenes.1.pages.supplier.viewport', /desktop|laptop|tablet|mobile/);
    // Structural errors keep their position (line of the key).
    expect(errors(r.issues).find((i) => i.path.join('.') === 'scenes.1.pages.supplier.viewport')?.line).toBe(13);
  });

  it('reports the semantic issues of a structurally valid multi-page scene', () => {
    const text = scenario([
      '- id: two',
      '  page: shop',
      '  pages:',
      '    buyer: {open: "shpo:/products"}',
      '    supplier: {page: consol, open: /quotes}',
      '    rel: {open: /quotes}',
      '  steps:',
      '    - on: suplier',
      '      click: Quote requests',
      '    - switch_page: buyer',
      '    - open: {url: /x, page: shop}',
      '- id: three',
      '  pages: {solo: {page: shop, open: /}}',
      '  steps: [{click: Coffees}]',
      '- id: four',
      '  pages:',
      '    - {page: shop, open: /}',
      '    - {page: shop, open: /coffees}',
      '  steps: [{click: Coffees}]',
      '- id: five',
      '  page: supplier',
      '  steps: [{click: Coffees}]',
    ]);
    const r = parseScenario(text, { files: NO_DISK, project: project() });
    const e = errs(r.issues);
    const has = (path: string, re: RegExp) =>
      expect(
        e.some((m) => m.startsWith(path) && re.test(m)),
        `${path} ${re} in\n${e.join('\n')}`,
      ).toBe(true);
    has('scenes.0.page', /declares its pages in `pages`/);
    has('scenes.0.pages', /at most 2 pages/);
    has('scenes.0.pages.buyer.open', /"shpo:" .* not a page of environment "local".*did you mean "shop"/);
    has('scenes.0.pages.supplier.page', /unknown page "consol".*did you mean "console"/);
    has('scenes.0.pages.rel.open', /relative but page "rel" names no environment page/);
    has('scenes.0.steps.0.on', /unknown page "suplier".*did you mean "supplier"/);
    has('scenes.0.steps.1.switch_page', /not available in a multi-page scene/);
    has('scenes.0.steps.2.open.page', /not available in a multi-page scene/);
    has('scenes.1.pages', /at least 2 pages/);
    has('scenes.2.pages.1', /duplicate page id "shop".*give the page an `id`/);
    // A later single-page scene may continue on a page a multi-page scene declared.
    expect(e.some((m) => m.startsWith('scenes.3'))).toBe(false);
    // Line numbers point at the offending key.
    const line = (path: string) => errors(r.issues).find((i) => i.path.join('.') === path)?.line;
    expect(line('scenes.0.steps.0.on')).toBe(10);
    expect(line('scenes.0.pages.supplier.page')).toBe(7);
  });

  it('reports, with their position, the viewports the runner would refuse mid-capture', () => {
    const both = ['- id: both', '  pages:', '    buyer: {open: "shop:/", viewport: laptop}', '    supplier: {open: "console:/quotes", viewport: laptop}', '  steps: [{click: Coffees}]'];
    // A single-page scene without `page` continues on the first page of the multi-page scene before it (1440×900).
    let r = parseScenario(scenario([...both, '- id: after', '  steps: [{click: Coffees}]']), { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([
      expect.stringMatching(
        /^scenes\.1@\d+: this scene has no `page`: it continues on page "buyer", filmed at 1440×900 since scenes\[0\]\.pages\.buyer\.viewport: a single-page scene films the capture size \(1920×1080\)/,
      ),
    ]);
    // Naming an environment page is fine; naming the mobile page of a multi-page scene is not.
    r = parseScenario(scenario([...both, '- id: after', '  page: shop', '  steps: [{click: Coffees}]']), { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([]);
    const phone = ['- id: both', '  pages:', '    - {page: shop, open: /}', '    - {id: phone, page: shop, open: /, viewport: mobile}', '  steps: [{click: Coffees}]'];
    r = parseScenario(scenario([...phone, '- id: after', '  page: phone', '  steps: [{click: Coffees}]']), { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([expect.stringMatching(/^scenes\.1\.page@9: this scene films page "phone", filmed at 390×844 \(mobile\) since scenes\[0\]\.pages\[1\]\.viewport/)]);
    r = parseScenario(scenario([...phone, '- id: after', '  page: shop', '  steps: [{switch_page: phone}]']), { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([expect.stringMatching(/^scenes\.1\.steps\.0\.switch_page@\d+: `switch_page` goes to page "phone"/)]);
    // The same page id asked at another viewport later.
    r = parseScenario(
      scenario([
        '- id: one',
        '  pages:',
        '    a: {page: shop, open: /, viewport: mobile}',
        '    b: {page: console, open: /}',
        '  steps: [{click: Coffees}]',
        '- id: two',
        '  pages:',
        '    a: {viewport: tablet}',
        '    b: {}',
        '  steps: [{click: Coffees}]',
        '- id: three',
        '  pages: [a, b]',
        '  steps: [{click: Coffees}]',
      ]),
      { files: NO_DISK, project: project() },
    );
    expect(errs(r.issues)).toEqual([
      expect.stringMatching(
        /^scenes\.1\.pages\.a\.viewport@10: page "a" is filmed at 390×844 \(mobile\) since scenes\[0\]\.pages\.a\.viewport and is asked at 820×1180 \(mobile\) here: a page keeps one viewport/,
      ),
    ]);
    // A skipped scene films nothing: it declares no viewport and continues nothing.
    r = parseScenario(scenario([...both.map((l, i) => (i === 0 ? `${l}\n    skip: true` : l)), '- id: after', '  open: /', '  steps: [{click: Coffees}]']), { files: NO_DISK, project: project() });
    expect(errs(r.issues)).toEqual([]);
  });

  it('warns about a page filmed for the first time without `open`, and a scene-level cursor', () => {
    const text = scenario(['- id: two', '  cursor: keep', '  pages:', '    shop: {open: /}', '    console: {}', '  steps: [{on: console, click: Quote requests}]']);
    const w = warns(parseScenario(text, { files: NO_DISK, project: project() }).issues);
    expect(w).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^scenes\.0\.cursor: .*pages\.<id>\.cursor/),
        expect.stringMatching(/^scenes\.0\.pages\.console: page "console" is filmed for the first time but has no `open`/),
      ]),
    );
  });
});

describe('timeline: tracks and scene pages', () => {
  it('validates a timeline with per-page tracks on the capture clock', () => {
    const tl: Timeline = {
      version: 1,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-10-12T00:00:00Z',
      mode: 'capture',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 10, t0_wall: 0, frames: 10 },
      scenes: [
        {
          id: 'both',
          index: 0,
          kind: 'scene',
          t_start: 0,
          t_end: 10,
          status: 'ok',
          pages: [
            { id: 'buyer', page: 'shop', label: 'Buyer', viewport: { width: 1920, height: 1080, preset: 'desktop' }, track: 'buyer' },
            { id: 'phone', page: 'shop', viewport: { width: 390, height: 844, mobile: true, touch: true, preset: 'mobile' }, track: 'phone' },
          ],
        },
      ],
      events: [{ scene: 'both', scene_index: 0, step: 0, action: 'click', t_start: 1, t_end: 2, page: 'phone', status: 'ok' }],
      markers: [{ name: 'm', t: 1, scene: 'both', step: 0, page: 'phone' }],
      pages: [],
      cursor: [],
      idle: [],
      tracks: [
        {
          id: 'phone',
          file: 'capture-phone.mp4',
          frames_file: 'frames-phone.jsonl',
          width: 390,
          height: 844,
          scale: 1,
          mobile: true,
          touch: true,
          preset: 'mobile',
          fps: 30,
          frames: 120,
          recording: [{ t_start: 0, t_end: 10 }],
          pages: [{ id: 'phone', t_start: 0, t_end: 10, url: 'http://localhost:4402/' }],
          cursor: [{ t: 0.5, x: 10, y: 20, visible: true }],
        },
      ],
      warnings: [],
    };
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...tl, tracks: [{ ...tl.tracks![0], file: 3 }] }).success).toBe(false);
  });
});
