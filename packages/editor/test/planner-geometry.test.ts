/**
 * Layout geometry that follows params, through the planner (L2.5): the built-in studio/layout-card evaluates its
 * geometry with the params of each use (theme components entry, legacy `frame.width`, overrides) and the capture
 * aspect; the card, the capture rect, the caption area, the brand mark and the overlay anchors all move together.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import type { LoadedProject, LoadedTemplate, Timeline } from '@retake/core';
import { mapSourceRect, planEdit, urlAt } from '@retake/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '@retake/editor';
import { REPO, clip, clips, fixtureProject, realTimeline, template } from './helpers.js';

let registry: ComponentRegistry;
let project: LoadedProject;
let editorial: LoadedTemplate;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  project = await fixtureProject();
  editorial = await template('editorial');
});

function plan(timeline: Timeline, overrides?: EditOverrides, tpl: LoadedTemplate = editorial, reg: ComponentRegistry = registry): EditPlan {
  return planEdit({ timeline, template: tpl, project, registry: reg, captureFile: '/captures/capture.mp4', overrides });
}

describe('layout geometry follows params (built-in studio/layout-card)', () => {
  it('editorial (width 1560, 16:9 capture): the reference rects of look.md', () => {
    const p = plan(realTimeline('quote'));
    expect(p.warnings).toEqual([]);
    expect(p.layout).toEqual({
      capture: { x: 180, y: 40.25, w: 1560, h: 877.5 },
      card: { x: 180, y: 40, w: 1560, h: 878 },
      radius: 18,
      caption: { x: 180, y: 930, w: 1220, h: 110 },
      brandmark: { x: 1420, y: 965, w: 320, h: 40 },
    });
    for (const c of clips(p)) expect(c.layout).toEqual(p.layout);
  });

  it('a narrower card (components override) moves the capture, the caption area, the brand mark and the overlay anchors', () => {
    const wide = plan(realTimeline('quote'));
    const narrow = plan(realTimeline('quote'), { components: { layout: { id: 'studio/layout-card', params: { width: 1400, radius: 24 } } } });
    expect(narrow.warnings).toEqual([]);
    const c = clip(narrow, 'proposal');
    expect(c.layout.card).toEqual({ x: 260, y: 85, w: 1400, h: 788 });
    expect(c.layout.capture).toEqual({ x: 260, y: 85.25, w: 1400, h: 787.5 });
    expect(c.layout.caption).toEqual({ x: 260, y: 885, w: 1060, h: 110 });
    expect(c.layout.brandmark).toEqual({ x: 1340, y: 920, w: 320, h: 40 });
    expect(c.layout.radius).toBe(24);
    // The €720.00 callout follows the capture: same source box, mapped into the smaller card.
    const o = c.overlays[0];
    const before = mapSourceRect(wide, clip(wide, 'proposal'), o.from, o.anchor!.bbox!);
    const after = mapSourceRect(narrow, c, o.from, o.anchor!.bbox!);
    const k = 1400 / 1560;
    expect(after.w).toBeCloseTo(before.w * k, 1);
    expect(after.x).toBeCloseTo(260 + (before.x - 180) * k, 1);
    expect(after.y).toBeCloseTo(85.25 + (before.y - 40.25) * k, 1);
  });

  it('the legacy frame.width of a template (no components map) drives the same geometry', () => {
    const tpl: LoadedTemplate = { ...editorial, template: { ...editorial.template, components: undefined, frame: { ...editorial.template.frame, width: 1400, radius: 12 } } };
    const p = plan(realTimeline('quote'), undefined, tpl);
    expect(p.layout.card).toEqual({ x: 260, y: 85, w: 1400, h: 788 });
    expect(p.layout.radius).toBe(12);
  });

  it('the capture aspect is part of the geometry: a 16:10 capture gets a 16:10 card with the caption aligned to it', () => {
    const t = realTimeline('quote');
    t.capture = { ...t.capture, width: 1440, height: 900 };
    const p = plan(t);
    expect(p.layout.card).toEqual({ x: 258, y: 40, w: 1404, h: 878 });
    expect(p.layout.caption!.x).toBe(258);
    expect(p.layout.brandmark!.x + p.layout.brandmark!.w).toBe(258 + 1404);
  });

  it('a geometry that cannot be evaluated or leaves the frame for a use is reported (and falls back)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retake-geometry-'));
    try {
      const dir = join(root, 'components', 'acme', 'odd-card');
      await mkdir(dir, { recursive: true });
      await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
      await writeFile(
        join(dir, 'component.yaml'),
        [
          'id: acme/odd-card',
          'version: 1.0.0',
          'kind: layout',
          'name: Odd card',
          'description: A card whose geometry depends on its params.',
          'slots:',
          '  screen: {type: screen, required: true}',
          'params:',
          '  type: object',
          '  properties:',
          '    inset: {type: number, minimum: 0, maximum: 2000, default: 100}',
          'geometry:',
          '  screen: {x: inset, y: 1000 / (inset - 50), w: 1920 - 2 * inset, h: 800}',
          '',
        ].join('\n'),
      );
      await writeFile(join(dir, 'index.tsx'), 'export default function OddCard() { return null; }\n');
      const reg = await loadComponentRegistry({ root });
      const bad = plan(realTimeline('quote'), { components: { layout: { id: 'acme/odd-card', params: { inset: 50 } } } }, editorial, reg);
      expect(bad.warnings.join('\n')).toMatch(/layout acme\/odd-card: screen\.y: "1000 \/ \(inset - 50\)" is not a finite number \(Infinity\): default geometry used/);
      expect(bad.layout.fallback).toBe(true);
      const out = plan(realTimeline('quote'), { components: { layout: { id: 'acme/odd-card', params: { inset: 1200 } } } }, editorial, reg);
      expect(out.warnings.join('\n')).toMatch(/layout acme\/odd-card with \{"inset":1200\}: screen leaves the frame/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('caption cues land in the layout caption area', () => {
  it('every clip of the fixture plans has its caption area under its card', () => {
    for (const name of ['catalogue', 'quote'] as const) {
      const p = plan(realTimeline(name));
      for (const c of clips(p) as ClipSegment[]) {
        expect(c.cues.length, `${name} ${c.id}`).toBeGreaterThan(0);
        expect(c.layout.caption!.y, c.id).toBe(c.layout.card.y + c.layout.card.h + 12);
        expect(c.layout.caption!.x, c.id).toBe(c.layout.card.x);
      }
    }
  });
});

describe('device and window layouts through the planner (L2.7)', () => {
  const sized = (w: number, h: number): Timeline => {
    const t = realTimeline('quote');
    t.capture = { ...t.capture, width: w, height: h };
    return t;
  };

  it('browser: the window around the capture with its chrome bar; every clip keeps the URLs it showed', () => {
    // A run of the fixture with display URLs (L1.7): the bar shows them, nothing to warn about.
    const displayed = realTimeline('quote');
    displayed.environment = { name: 'local', access: 'read-write', display: [{ page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' }] };
    const d = plan(displayed, { frame: 'browser' });
    expect(d.warnings).toEqual([]);
    expect(clip(d, 'proposal').urls.map((u) => u.url)).toEqual(['https://shop.northfield.example/', 'https://shop.northfield.example/quotes/1043', 'https://shop.northfield.example/quotes/1043/pdf']);
    expect(clips(d).every((c) => c.urls.every((u) => !u.hidden))).toBe(true);
    // A run without display URLs (this timeline predates L1.7): every URL is local — kept, marked hidden (the bar
    // shows no address: urlAt), and one plan warning names the page.
    const p = plan(realTimeline('quote'), { frame: 'browser' });
    expect(p.warnings).toEqual([
      expect.stringMatching(/^a local URL outside the pages of environment \(unknown\) has no display URL \(http:\/\/localhost:4402\): the browser bar shows no address for it/),
    ]);
    expect(urlAt(clip(p, 'proposal'), 0)).toBeUndefined();
    expect(urlAt(clip(d, 'proposal'), 0)).toBe('https://shop.northfield.example/');
    const c = clip(p, 'proposal');
    expect(c.component.id).toBe('studio/layout-browser');
    expect(c.layout.card).toEqual({ x: 226, y: 40, w: 1468, h: 878 });
    expect(c.layout.chrome).toEqual({ x: 226, y: 40, w: 1468, h: 52 });
    expect(c.layout.capture).toEqual({ x: 226, y: 92.125, w: 1468, h: 825.75 }); // 1468 / (16 / 9), centred in the 826 px page area
    expect(c.layout.display).toBeUndefined();
    expect(c.urls.length).toBeGreaterThan(0);
    expect(c.urls.every((u) => /^http:\/\/localhost:4402\//.test(u.url) && u.hidden)).toBe(true);
    // The same timeline in a card or with the bar's URL off draws no URL: no warning (only layouts that draw one).
    expect(plan(realTimeline('quote')).warnings).toEqual([]);
    expect(plan(realTimeline('quote'), { frame: 'browser', components: { layout: { id: 'studio/layout-browser', params: { show_url: false } } } }).warnings).toEqual([]);
    // Its tab strip names the host even without the address: it warns.
    expect(plan(realTimeline('quote'), { frame: 'browser', components: { layout: { id: 'studio/layout-browser', params: { show_url: false, tabs: true } } } }).warnings).toHaveLength(1);
  });

  it("display URLs are edit-time data: a run captured before them gets the project's current ones (V2)", () => {
    const edit = (timeline: Timeline, env?: string, proj: LoadedProject = project) =>
      planEdit({ timeline, template: editorial, project: proj, registry, captureFile: '/captures/capture.mp4', overrides: { frame: 'browser' }, ...(env ? { env } : {}) });
    // A timeline without an environment block (before L1.7) and run.json's env: the fixture's display URLs apply.
    const old = edit(realTimeline('quote'), 'local');
    expect(old.warnings).toEqual([]);
    expect(urlAt(clip(old, 'proposal'), 0)).toBe('https://shop.northfield.example/');
    expect(old.display?.find((r) => r.page === 'shop')).toEqual({ page: 'shop', url: 'http://localhost:4402', display: 'https://shop.northfield.example' });
    // A display URL recorded at capture and changed since: the project's current one wins.
    const recorded = realTimeline('quote');
    recorded.environment = { name: 'local', access: 'read-write', display: [{ page: 'shop', url: 'http://localhost:4402', display: 'https://old.northfield.example' }] };
    expect(urlAt(clip(edit(recorded), 'proposal'), 0)).toBe('https://shop.northfield.example/');
    // The project's page without a display URL: the bar shows nothing, the warning names the page and says to render again.
    const bare: LoadedProject = { ...project, config: { ...project.config, environment_settings: undefined } };
    const none = edit(realTimeline('quote'), 'local', bare);
    expect(urlAt(clip(none, 'proposal'), 0)).toBeUndefined();
    expect(none.warnings).toEqual([
      'page "shop" has no display URL (http://localhost:4402): the browser bar shows no address for it — add display: to environments.local.shop in project.yaml and render again (docs/guide/environments.md)',
    ]);
    // A sandbox environment (L1.8): its pages live in its sandbox.yaml, under the service that serves them (I9).
    const sandboxed: LoadedProject = {
      ...project,
      config: {
        ...project.config,
        environments: { ...project.config.environments, box: { shop: 'http://localhost:4402' } },
        environment_settings: { box: { sandbox: { file: join(project.dir, 'sandbox', 'box.yaml'), provider: 'process' } } },
      },
      sandboxes: {
        box: {
          env: 'box',
          file: join(project.dir, 'sandbox', 'box.yaml'),
          dir: join(project.dir, 'sandbox'),
          manifest: { version: 1, provider: 'process', services: { fixture: { command: 'x', pages: { shop: 'http://localhost:4402' } } } },
          issues: [],
          secrets: {},
        },
      },
    };
    expect(edit(realTimeline('quote'), 'box', sandboxed).warnings).toEqual([
      'page "shop" has no display URL (http://localhost:4402): the browser bar shows no address for it — add display: to services.fixture.pages.shop in sandbox/box.yaml and render again (docs/guide/sandbox.md)',
    ]);
  });

  it('phone: a phone capture fills the screen under the status bar; a desktop one is letterboxed in it (display rect)', () => {
    const mobile = plan(sized(390, 844), { frame: 'phone' });
    expect(mobile.warnings).toEqual([]);
    const m = clip(mobile, 'proposal').layout;
    expect(m.display).toBeUndefined();
    expect(m.capture.w / m.capture.h).toBeCloseTo(390 / 844, 2);
    expect(m.caption!.x).toBeGreaterThan(m.card.x + m.card.w); // the caption beside the phone
    const desktop = plan(realTimeline('quote'), { frame: 'phone' });
    const d = clip(desktop, 'proposal');
    expect(d.layout.display).toBeDefined();
    expect(d.layout.capture.w).toBeCloseTo(d.layout.display!.w, 1);
    expect(d.layout.capture.h).toBeLessThan(d.layout.display!.h / 2);
    expect(d.layout.capture.y).toBeGreaterThan(d.layout.display!.y);
    // The overlay anchor still lands inside the (letterboxed) capture.
    const o = d.overlays[0];
    const a = mapSourceRect(desktop, d, o.from, o.anchor!.bbox!);
    expect(a.x).toBeGreaterThanOrEqual(d.layout.capture.x);
    expect(a.y + a.h).toBeLessThanOrEqual(d.layout.capture.y + d.layout.capture.h + 0.5);
  });

  it('tablet: upright with the caption beside for a portrait capture, lying with the caption below for a landscape one', () => {
    const portrait = clip(plan(sized(820, 1180), { frame: 'tablet' }), 'proposal').layout;
    expect(portrait.card).toEqual({ x: 244, y: 58, w: 696, h: 964 });
    expect(portrait.caption).toEqual({ x: 1036, y: 485, w: 640, h: 110 });
    const landscape = clip(plan(sized(1180, 820), { frame: 'tablet' }), 'proposal').layout;
    expect(landscape.card).toEqual({ x: 347, y: 40, w: 1227, h: 878 });
    expect(landscape.caption!.y).toBe(930);
    expect(landscape.display).toBeUndefined();
  });

  it('laptop and raw: the capture keeps its aspect; raw letterboxes a phone capture with the theme background', () => {
    const l = clip(plan(realTimeline('quote'), { frame: 'laptop' }), 'proposal').layout;
    expect(l.capture.w / l.capture.h).toBeCloseTo(16 / 9, 2);
    expect(l.card.w).toBeGreaterThan(l.capture.w * 1.15);
    const raw = clip(plan(sized(390, 844), { frame: 'raw' }), 'proposal').layout;
    expect(raw.capture.h).toBe(1080);
    expect(raw.capture.w).toBeCloseTo((1080 * 390) / 844, 0);
    expect(raw.display).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(raw.caption).toEqual({ x: 260, y: 890, w: 1400, h: 150 });
  });
});
