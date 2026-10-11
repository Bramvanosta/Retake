/**
 * Layout geometry that follows params, through the planner (L2.5): the built-in studio/layout-card evaluates its
 * geometry with the params of each use (theme components entry, legacy `frame.width`, overrides) and the capture
 * aspect; the card, the capture rect, the caption area, the brand mark and the overlay anchors all move together.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import type { LoadedProject, LoadedTemplate, Timeline } from '@demo-studio/core';
import { mapSourceRect, planEdit } from '@demo-studio/editor';
import type { ClipSegment, EditOverrides, EditPlan } from '@demo-studio/editor';
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
    const root = await mkdtemp(join(tmpdir(), 'demo-studio-geometry-'));
    try {
      const dir = join(root, 'components', 'acme', 'odd-card');
      await mkdir(dir, { recursive: true });
      await writeFile(join(root, 'studio.yaml'), 'projects_dir: projects\n');
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
      await writeFile(join(dir, 'index.tsx'), "export default function OddCard() { return null; }\n");
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
