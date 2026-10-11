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
