import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TimelineEvent } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import { DRY_PAGE, SHOP_PAGE, WIDGETS_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({ '/widgets.html': WIDGETS_PAGE, '/dry.html': DRY_PAGE, '/s/index.html': SHOP_PAGE });
  dir = await tempDir();
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const steps = (events: TimelineEvent[]) => events.filter((e) => e.step >= 0);

describe('composite widgets and the other actions', () => {
  it('select (native + searchable listbox), menu with confirm (re-open quirk), pick in a dialog, and more', async () => {
    const project = makeProject(dir, { app: server.url });
    const rec = await runScenario({
      project,
      mode: 'dry',
      runId: 'widgets',
      scenario: makeScenario('widgets', {
        pacing: FAST,
        scenes: [
          {
            id: 'availability',
            open: '/widgets.html',
            steps: [
              { select: { field: 'Grind', option: 'Espresso' } },
              { assert: { text: 'grind=Espresso' } },
              { select: { field: 'Organisation', option: 'Northfield Imports', search: 'Imp' } },
              { assert: { text: 'org=Northfield Imports' } },
              { wait_for: { not_text: 'Enrichment in progress', timeout: 5 } },
              { menu: { row: 'Iceland', item: 'Pause', confirm: 'Pause' } },
              { assert: { text: 'Iceland paused', gone: { role: 'menu' } } },
              { click: 'Edit Sweden' },
              { pick: { field: 'Bag sizes', option: ['1 kg', '5 kg'], search: 'kg' } },
              { assert: { text: '1 kg, 5 kg', not_text: 'dialog closed by Escape', target: { role: 'dialog', name: 'Edit Sweden' } } },
              { click: { text: 'Save', in: 'dialog' } },
              { assert: { text: 'saved bags=1 kg, 5 kg' } },
              { double_click: { text: 'Double me' } },
              { assert: { text: 'double clicked' } },
              { drag: { from: '#drag-src', to: '#drag-dst', duration: 0.3 } },
              { assert: { text: 'dropped on shelf' } },
              { press: { key: 'Tab', times: 2 } },
              { emit: { name: 'checkpoint', data: { n: 1 } } },
              { eval: { js: 'return arg.a + 1;', arg: { a: 41 } } },
              { cursor: { move: { x: 60, y: 60 }, duration: 0.2 } },
              { cursor: 'hide' },
              { cursor: 'show' },
              { cursor: { set: { x: 100, y: 120 } } },
              { screenshot: 'final' },
              { notify: { title: 'Northfield', message: 'Capture done' } },
              { hover: { text: 'Edit Sweden', ms: 100 }, camera: { zoom: 1.2 } },
            ],
          },
        ],
      }),
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const ev = steps(tl.events);
    expect(ev.every((e) => e.status === 'ok')).toBe(true);
    expect(ev[0]).toMatchObject({ strategy: 'native', data: { option: 'Espresso' } });
    expect(ev[2].popup_opened).toBe(true);
    expect((ev[5].data as { clicks: unknown[] }).clicks.length).toBeGreaterThanOrEqual(4); // trigger, item, confirm, outside
    expect(ev[8].popup_opened).toBe(true);

    // R-ISS-05: every click of a composite step keeps role, strategy, popup_opened, point, bbox and t_click;
    // the event's top-level fields describe the trigger click.
    type Click = { role: string; strategy: string; popup_opened: boolean; point: { x: number; y: number }; bbox?: { x: number; y: number; w: number; h: number }; t_click: number; desc: string };
    const clicksOf = (e: TimelineEvent) => (e.data as { clicks: Click[] }).clicks;
    const inBox = (c: Click) => !!c.bbox && c.point.x >= c.bbox.x - 1 && c.point.x <= c.bbox.x + c.bbox.w + 1 && c.point.y >= c.bbox.y - 1 && c.point.y <= c.bbox.y + c.bbox.h + 1;
    for (const i of [0, 2, 5, 8]) {
      const e = ev[i];
      const cs = clicksOf(e);
      expect(cs.length, e.action).toBeGreaterThan(0);
      for (const c of cs) {
        expect(Object.keys(c).sort(), `${e.action} ${c.role}`).toEqual(expect.arrayContaining(['role', 'strategy', 'popup_opened', 'point', 't_click', 'desc']));
        expect(['trigger', 'option', 'item', 'confirm', 'outside', 'search']).toContain(c.role);
        expect(c.t_click).toBeGreaterThanOrEqual(e.t_start);
        expect(c.t_click).toBeLessThanOrEqual(e.t_end);
        if (c.role !== 'outside') expect(inBox(c), `${e.action} ${c.role} ${JSON.stringify(c)}`).toBe(true);
      }
      const trigger = cs.find((c) => c.role === 'trigger')!;
      expect(e.t_click).toBe(trigger.t_click);
      expect(e.point).toEqual(trigger.point);
      expect(e.strategy).toBe(trigger.strategy);
      expect(e.popup_opened).toBe(trigger.popup_opened);
      expect(e.target?.bbox).toEqual(trigger.bbox);
      // Clicks are in chronological order.
      for (let k = 1; k < cs.length; k++) expect(cs[k].t_click).toBeGreaterThanOrEqual(cs[k - 1].t_click);
    }
    expect(clicksOf(ev[0]).map((c) => c.role)).toEqual(['trigger']); // native select
    expect(clicksOf(ev[2]).map((c) => c.role)).toEqual(['trigger', 'option']);
    expect(clicksOf(ev[2])[0]).toMatchObject({ strategy: 'real', popup_opened: true });
    expect(clicksOf(ev[2])[1]).toMatchObject({ popup_opened: false });
    const menuRoles = clicksOf(ev[5]).map((c) => c.role);
    expect(menuRoles.slice(0, 3)).toEqual(['trigger', 'item', 'confirm']);
    expect(menuRoles.slice(3).every((r) => r === 'outside')).toBe(true);
    expect(clicksOf(ev[8]).map((c) => c.role)).toEqual(['trigger', 'search', 'option', 'option', 'outside']); // search: click into the popover's search field
    expect(ev[17].data).toEqual({ name: 'checkpoint', data: { n: 1 } });
    expect(ev[18].data).toEqual({ value: 42 });
    expect(ev[22].point).toEqual({ x: 100, y: 120 });
    expect(existsSync(join(rec.dir, 'screenshots', 'final.png'))).toBe(true);
    expect(ev[25].camera).toMatchObject({ zoom: 1.2 });
    expect(ev[25].camera?.bbox?.w).toBeGreaterThan(0);
    const hidden = tl.cursor.filter((c) => !c.visible);
    expect(hidden.length).toBeGreaterThan(0);
  });

  it('switches pages per scene, interpolates templates, records interstitials and skipped scenes', async () => {
    const project = makeProject(dir, { app: server.url, shop: `${server.url}/s` });
    const rec = await runScenario({
      project,
      mode: 'dry',
      runId: 'pages',
      scenario: makeScenario('pages', {
        pacing: FAST,
        vars: { buyer: 'Harbour Coffee Co.' },
        scenes: [
          { id: 'console', page: 'app', open: '/dry.html', caption: { kicker: 'Catalogue', text: 'Save a draft' }, steps: [{ click: 'Save draft', mark: 'saved' }] },
          { interstitial: { text: 'A few hours later', duration: 2 } },
          {
            id: 'shop',
            page: 'shop',
            open: 'index.html?buyer={{vars.buyer}}',
            steps: [{ click: 'Request a quote' }, { assert: { text: 'Welcome Harbour Coffee Co. — quote requested' } }],
          },
          { id: 'back', page: 'app', speed: 1.5, steps: [{ assert: { text: 'save' } }] },
          { id: 'later', skip: true, steps: [{ click: 'Nothing' }] },
        ],
      }),
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    expect(tl.scenes.map((s) => `${s.id}:${s.kind}:${s.status}`)).toEqual([
      'console:scene:ok',
      'interstitial-1:interstitial:ok',
      'shop:scene:ok',
      'back:scene:ok',
      'later:scene:skipped',
    ]);
    const inter = tl.scenes[1];
    expect(inter.t_start).toBe(inter.t_end);
    expect(inter.interstitial).toMatchObject({ text: 'A few hours later' });
    expect(tl.scenes[0].caption).toEqual({ kicker: 'Catalogue', text: 'Save a draft' });
    expect(tl.scenes[2].url).toContain('/s/index.html?buyer=Harbour');
    expect(tl.scenes[3]).toMatchObject({ page: 'app', speed: 1.5 });
    // Segments split on page switches and on main-frame URL changes (the editor's address bar follows them).
    const ids = tl.pages.map((p) => p.id).filter((id, i, a) => i === 0 || a[i - 1] !== id);
    expect(ids).toEqual(['app', 'shop', 'app']);
    expect(tl.pages.some((p) => p.id === 'shop' && p.url?.includes('buyer=Harbour'))).toBe(true);
    for (let i = 1; i < tl.pages.length; i++) expect(tl.pages[i].t_start).toBeGreaterThanOrEqual(tl.pages[i - 1].t_end - 0.001);
    expect(tl.markers).toEqual([expect.objectContaining({ name: 'saved', scene: 'console', step: 0 })]);
    const opens = tl.events.filter((e) => e.action === 'scene_open');
    expect(opens.length).toBe(2);
  });
});
