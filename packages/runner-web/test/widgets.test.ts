import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedPersona, RunRecord, Timeline, TimelineEvent } from '@retake/core';
import { RunSecrets, autoLogin, kitConfigFor, openSession, runScenario } from '../src/index.js';
import { DOC_PAGE, DRY_PAGE, OPTIONS_PAGE, SHOP_PAGE, STRATEGY_PAGE, WIDGETS_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/widgets.html': WIDGETS_PAGE,
    '/dry.html': DRY_PAGE,
    '/s/index.html': SHOP_PAGE,
    '/options.html': OPTIONS_PAGE,
    '/strategies.html': STRATEGY_PAGE,
    '/doc.html': DOC_PAGE,
    '/slow': { body: 'ok', type: 'text/plain', delay_ms: 500 },
    '/hang': { body: 'late', type: 'text/plain', delay_ms: 4000 },
    '/slow.png': { body: '', type: 'image/png', delay_ms: 1000 },
  });
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

/**
 * Every option of the scenario language not exercised elsewhere (L1.4), in one dry run of four scenes. Each check fails
 * when the option is ignored. The run ends on a failing assert (its screenshot and DOM snippet are checked too).
 */
describe('options of the scenario language (L1.4)', () => {
  let rec: RunRecord;
  let tl: Timeline;
  let ev: TimelineEvent[];
  const byId = (id: string): TimelineEvent => {
    const e = ev.find((x) => x.id === id);
    if (!e) throw new Error(`no event with id ${id}`);
    return e;
  };
  const value = (id: string) => (byId(id).data as { value: unknown }).value;
  const dur = (e: { t_start: number; t_end: number }) => e.t_end - e.t_start;
  type Click = { role: string; point: { x: number; y: number }; desc: string };
  const roles = (e: TimelineEvent) => (e.data as { clicks: Click[] }).clicks.map((c) => c.role);
  const probeLog = 'return window.probeLog.splice(0);';
  const pageLog = "return document.getElementById('log').textContent;";

  beforeAll(async () => {
    const project = makeProject(dir, { app: server.url, other: server.url });
    rec = await runScenario({
      project,
      mode: 'dry',
      runId: 'options',
      scenario: makeScenario('options', {
        pacing: FAST,
        scenes: [
          {
            id: 'options',
            open: '/options.html',
            still: 0.6,
            transition: 'fade-black',
            note: 'Free-form note: ignored by the runner.',
            steps: [
              // Step modifiers (R-MOD-02/03) on a plain left click (the control of the click options below).
              { id: 'plain', click: { css: '#probe' }, caption: { kicker: 'Labels', text: 'Probe the clicks' }, speed: 2 },
              { id: 'log-plain', eval: probeLog },
              { id: 'right', click: { css: '#probe', button: 'right' } },
              { id: 'log-right', eval: probeLog },
              { id: 'middle', click: { css: '#probe', button: 'middle' } },
              { id: 'log-middle', eval: probeLog },
              { id: 'shift', click: { css: '#probe', modifiers: ['Shift'] } },
              { id: 'log-shift', eval: probeLog },
              { id: 'alt-ctrl', click: { css: '#probe', modifiers: ['Alt', 'Control'] } },
              { id: 'log-alt-ctrl', eval: probeLog },
              { id: 'offset', click: { css: '#probe', offset: { x: 6, y: 5 } } },
              { id: 'log-offset', eval: probeLog },
              // Per-click durations (R-CLK-03), each from the same far point, then the same click without them.
              { cursor: { set: { x: 700, y: 560 } } },
              { id: 'slow', click: { css: '#probe', move_ms: 600, hover_ms: 400, after_ms: 500 } },
              { cursor: { set: { x: 700, y: 560 } } },
              { id: 'quick', click: { css: '#probe' } },
              // wait_for (R-ACT-21) and assert (R-ACT-23).
              { click: 'Refresh' },
              { id: 'gone', wait_for: { gone: '#spinner', timeout: 3 } },
              { id: 'gone-lag', eval: 'return Date.now() - window.spinnerGoneAt;' },
              { click: 'Next step' },
              { id: 'url-regex', wait_for: { url: '/step=\\d$/' } },
              { id: 'url-substring', wait_for: { url: 'step=2' } },
              { id: 'assert-title-url', assert: { title: 'STEP 2', url: '/step=2$/' } },
              { id: 'assert-count', assert: { count: { target: { css: 'li.item' }, equals: 3 } } },
              { id: 'assert-miss', assert: { title: 'Invoices', url: '/step=9$/' }, timeout: 0.2, optional: true },
              { id: 'url-miss', wait_for: { url: 'nope', timeout: 0.3 }, optional: true },
              { click: 'Load prices' },
              { id: 'idle', wait_for: { network_idle: true, timeout: 5 } },
              { id: 'prices', assert: { text: 'prices loaded' }, timeout: 0.1 },
              { click: 'Start live feed' },
              { id: 'idle-miss', wait_for: { network_idle: true, timeout: 0.6 }, optional: true },
              // pick close: escape / none (R-ACT-12).
              { id: 'pick-escape', pick: { field: 'Label languages', option: 'Swedish', close: 'escape' } },
              { id: 'escaped', assert: { text: 'pop closed by Escape', gone: { role: 'listbox' } } },
              { id: 'pick-none', pick: { field: 'Label languages', option: 'Danish', close: 'none' } },
              { id: 'left-open', assert: { target: { role: 'option', name: 'Danish', in: 'listbox' } }, timeout: 0.1 },
              { press: 'Escape' },
              // A target-object scope on a step (R-TGT-07).
              { id: 'add-aside', click: { text: 'Add', in: { css: 'aside' } } },
              { id: 'add-nowhere', click: { text: 'Add', in: { css: '#nowhere' } }, timeout: 0.3, optional: true },
              { id: 'log-add', eval: pageLog },
              // open on another page (R-ACT-01), then switch_page main + close_current (R-ACT-26).
              { id: 'open-other', open: { url: '/options.html?o=1&slow=1', page: 'other', wait_until: 'domcontentloaded' } },
              { id: 'on-other', assert: { url: 'o=1' } },
              { id: 'tab', new_tab: { href: '/doc.html?n=3', as: 'pdf' } },
              { assert: { text: 'Quote 3' } },
              { id: 'main', switch_page: { to: 'main', close_current: true } },
              { id: 'pdf-closed', switch_page: 'pdf', optional: true },
            ],
          },
          // Scene-level irreversible (R-SCN-04): the first step is hovered, not clicked; the scene stops there.
          { id: 'danger', irreversible: true, steps: [{ click: 'Delete all labels' }, { click: { css: '#probe' } }] },
          {
            id: 'strategies',
            steps: [
              { id: 'log-danger', eval: pageLog },
              { id: 'open-step', open: '/strategies.html' },
              // Explicit strategies (R-CLK-01) and expect_popup (R-CLK-02); see the strategy page's widgets.
              { id: 'dom', click: { css: '#b', strategy: 'dom' } },
              { click: { outside: true } },
              { id: 'pointer', click: { css: '#c', strategy: 'pointer' } },
              { click: { outside: true } },
              { id: 'real', click: { css: '#b', strategy: 'real' } },
              { id: 'no-popup', click: { css: '#b', expect_popup: false } },
              { id: 'log-popups', eval: pageLog },
              { id: 'expect', click: { text: 'Plain button', expect_popup: true } },
            ],
          },
          {
            id: 'widgets',
            open: '/widgets.html',
            steps: [
              // outside: <target> (R-ACT-04).
              { id: 'org', click: { css: '#org' } },
              { id: 'outside-h1', click: { outside: { text: 'Availability' } } },
              { assert: { gone: { role: 'listbox' } } },
              // menu trigger + confirm: true (R-ACT-14): the confirmation's first button is "Cancel".
              { id: 'menu-trigger', menu: { trigger: { css: '[data-row=Sweden]' }, item: 'Pause', confirm: true } },
              { assert: { text: 'Sweden paused' } },
              { id: 'states', eval: "return [document.getElementById('swe-state').textContent, document.getElementById('ice-state').textContent];" },
              { id: 'trigger-wins', menu: { row: 'Sweden', trigger: { css: '#nope' }, item: 'Edit' }, timeout: 0.3, optional: true },
              // A failing assert ends the run (R-ACT-23).
              { id: 'fails', assert: { count: { target: { css: '[aria-label="Row actions"]' }, equals: 3 } }, timeout: 0.3 },
            ],
          },
        ],
      }),
    });
    tl = await readTimeline(rec.timeline!);
    ev = steps(tl.events);
  });

  it('scene keys still, transition, note and scene-level irreversible (R-SCN-04)', () => {
    expect(tl.scenes.map((x) => `${x.id}:${x.status}`)).toEqual(['options:ok', 'danger:partial', 'strategies:ok', 'widgets:failed']);
    const stills = tl.events.filter((e) => e.action === 'scene_still');
    expect(dur(stills[0])).toBeGreaterThan(0.55); // still: 0.6
    expect(dur(stills[0])).toBeLessThan(0.75);
    expect(dur(stills[3])).toBeLessThan(0.3); // the pacing's 0.1
    expect(tl.scenes[0].transition).toBe('fade-black');
    expect(tl.scenes[3].transition).toBeUndefined();
    expect(JSON.stringify(tl.scenes[0])).not.toContain('Free-form note');
    expect(rec.stopped_at).toEqual({ scene: 'danger', step: 0, reason: 'irreversible' });
    const danger = ev.filter((e) => e.scene === 'danger');
    expect(danger.map((e) => e.status)).toEqual(['dry', 'skipped']);
    expect(danger[0].target?.desc).toContain('Delete all labels');
    expect(value('log-danger')).not.toContain('danger'); // hovered, never clicked
  });

  it('step caption and speed are recorded on the event (R-MOD-02, R-MOD-03)', () => {
    expect(byId('plain')).toMatchObject({ caption: { kicker: 'Labels', text: 'Probe the clicks' }, speed: 2 });
    expect(byId('right').caption).toBeUndefined();
    expect(byId('right').speed).toBeUndefined();
  });

  it('click button, modifiers and offset (R-CLK-04, R-CLK-05)', () => {
    const log = (id: string) => value(id) as string[];
    const types = (id: string) => log(id).map((l) => l.split(':').slice(0, 4).join(':'));
    expect(types('log-plain')).toEqual(['pointerdown:true:0:none', 'click:true:0:none']);
    expect(types('log-right')).toEqual(expect.arrayContaining(['pointerdown:true:2:none', 'contextmenu:true:2:none']));
    expect(types('log-right').some((l) => l.startsWith('click:'))).toBe(false);
    expect(types('log-middle')).toEqual(expect.arrayContaining(['pointerdown:true:1:none', 'auxclick:true:1:none']));
    expect(types('log-shift')).toEqual(['pointerdown:true:0:shift', 'click:true:0:shift']);
    expect(types('log-alt-ctrl')[0]).toBe('pointerdown:true:0:alt+ctrl');
    // The offset from the probe's top-left (the centre is 90, 32).
    const off = byId('offset');
    const box = off.target!.bbox!;
    expect(Math.abs(off.point!.x - (box.x + 6))).toBeLessThanOrEqual(1);
    expect(Math.abs(off.point!.y - (box.y + 5))).toBeLessThanOrEqual(1);
    const [ox, oy] = log('log-offset')[0].split(':')[4].split(',').map(Number);
    expect(Math.abs(ox - 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(oy - 5)).toBeLessThanOrEqual(1);
    const [cx, cy] = log('log-plain')[0].split(':')[4].split(',').map(Number);
    expect(Math.abs(cx - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs(cy - 32)).toBeLessThanOrEqual(2);
  });

  it('per-click move_ms, hover_ms and after_ms (R-CLK-03)', () => {
    // Travel = first to last cursor sample of the approach; hover = arrival → press; after = press → step end.
    const phases = (e: TimelineEvent) => {
      const moves = tl.cursor.filter((c) => c.t >= e.t_start && c.t < e.t_click!);
      const travel = moves[moves.length - 1].t - moves[0].t;
      return { travel, hover: e.t_click! - moves[moves.length - 1].t, after: e.t_end - e.t_click! };
    };
    const slow = phases(byId('slow'));
    const quick = phases(byId('quick'));
    expect(Math.abs(slow.travel - 0.6)).toBeLessThan(0.1);
    expect(slow.hover).toBeGreaterThan(0.38);
    expect(slow.after).toBeGreaterThan(0.48);
    expect(quick.travel).toBeLessThan(0.25); // FAST: at most 160 ms
    expect(quick.hover).toBeLessThan(0.3); // 40 ms
    expect(quick.after).toBeLessThan(0.4); // 80 ms
  });

  it('wait_for gone, url (/regex/ and substring), network_idle and its timeout (R-ACT-21)', () => {
    const waited = (id: string) => (byId(id).data as { waited_ms: number }).waited_ms;
    // The spinner goes 600 ms after the click; polled every 100 ms, the wait ends right after.
    expect(waited('gone')).toBeGreaterThan(200);
    expect(value('gone-lag') as number).toBeLessThan(400);
    // The route changes 500 ms after the click: a /regex/ (never a substring of the URL) and a substring.
    expect(waited('url-regex')).toBeGreaterThan(100);
    expect(byId('url-substring').status).toBe('ok');
    expect(byId('url-miss').status).toBe('failed');
    expect(byId('url-miss').error).toMatch(/wait_for timed out after 0\.3 s: URL .*\/options\.html\?step=2 does not match nope/);
    expect(dur(byId('url-miss'))).toBeGreaterThan(0.25);
    expect(dur(byId('url-miss'))).toBeLessThan(0.9);
    // A request started by the click (500 ms) is waited for, then 500 ms of quiet: the text is there with no grace.
    expect(waited('idle')).toBeGreaterThan(600);
    expect(byId('prices').status).toBe('ok');
    // A request that hangs keeps the network busy: the wait times out and names it.
    expect(byId('idle-miss').status).toBe('failed');
    expect(byId('idle-miss').error).toMatch(/the network did not become idle within 0\.6 s \(still loading: http:\/\/127\.0\.0\.1:\d+\/hang\)/);
  });

  it('assert title, url, count and a failure with its screenshot and DOM snippet (R-ACT-23)', async () => {
    expect(byId('assert-title-url').status).toBe('ok');
    expect(byId('assert-count').status).toBe('ok');
    expect(byId('assert-miss').status).toBe('failed');
    expect(byId('assert-miss').error).toMatch(/assert failed: URL .* does not match \/step=9\$\/; title "Options — step 2" does not contain "Invoices"/);
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatchObject({ scene: 'widgets', action: 'assert' });
    expect(rec.error!.message).toContain('assert failed: css="[aria-label=\\"Row actions\\"]" matches 2 visible elements, expected 3');
    expect(existsSync(rec.error!.screenshot!)).toBe(true);
    expect(await readFile(rec.error!.dom!, 'utf8')).toContain('Row actions');
  });

  it('pick close: escape and none (R-ACT-12)', () => {
    const esc = byId('pick-escape');
    expect(roles(esc)).toEqual(['trigger', 'option']);
    expect(esc.data).toMatchObject({ close: 'escape' });
    expect(byId('escaped').status).toBe('ok');
    const none = byId('pick-none');
    expect(roles(none)).toEqual(['trigger', 'option']);
    expect(none.data).toMatchObject({ close: 'none' });
    expect(byId('left-open').status).toBe('ok');
    expect(rec.warnings.filter((w) => /did not close/.test(w))).toEqual([]);
  });

  it('a target-object scope on a step (R-TGT-07)', () => {
    expect(byId('add-aside').status).toBe('ok');
    expect(value('log-add')).toContain('add-aside');
    expect(value('log-add')).not.toContain('add-main');
    expect(byId('add-nowhere').status).toBe('failed');
    expect(byId('add-nowhere').error).toMatch(/scope \(css="#nowhere"\) not found/);
  });

  it('open on another page with wait_until, switch_page main and close_current (R-ACT-01, R-ACT-26)', () => {
    const open = byId('open-other');
    expect(open.page).toBe('other');
    expect(open.url).toContain('o=1');
    // domcontentloaded: the 1 s image is not waited for (a `load` would be).
    expect(dur(open)).toBeLessThan(0.8);
    expect(byId('on-other')).toMatchObject({ status: 'ok', page: 'other' });
    expect(byId('tab').page).toBe('pdf');
    // main = the environment's first page (not the previous one, "other").
    expect(byId('main').data).toMatchObject({ page: 'app' });
    expect(byId('pdf-closed').status).toBe('failed');
    expect(byId('pdf-closed').error).toMatch(/unknown page "pdf" \(open: app, other;/);
    expect(byId('open-step')).toMatchObject({ status: 'ok', page: 'app' });
    expect(byId('open-step').url).toContain('/strategies.html');
  });

  it('explicit click strategies and expect_popup (R-CLK-01, R-CLK-02)', () => {
    const warned = (id: string) => rec.warnings.some((w) => w.startsWith(`strategies.${byId(id).step}: `) && /expected to open a popup but none appeared/.test(w));
    // dom / pointer at once: no real click first, no fallback wait (auto would reach them after popup_fallback_ms).
    for (const id of ['dom', 'pointer']) {
      const e = byId(id);
      expect(e, id).toMatchObject({ strategy: id, popup_opened: true });
      expect(e.t_end - e.t_click!, id).toBeLessThan(0.3);
    }
    // real only: the widget ignores trusted input, nothing opens (auto would have fallen back to dom).
    expect(byId('real')).toMatchObject({ strategy: 'real', popup_opened: false });
    expect(warned('real')).toBe(true);
    // expect_popup: false: the same widget is clicked once, for real, with no popup check and no warning.
    expect(byId('no-popup').strategy).toBe('real');
    expect(byId('no-popup').popup_opened).toBeUndefined();
    expect(warned('no-popup')).toBe(false);
    expect((value('log-popups') as string).match(/open-b/g)).toHaveLength(1); // the dom click's only
    // expect_popup: true on a plain button: every fallback is tried.
    expect(byId('expect')).toMatchObject({ strategy: 'pointer', popup_opened: false });
    expect(warned('expect')).toBe(true);
  });

  it('login steps wait for a request a click started too, and time out on one that hangs (R-ACT-21)', async () => {
    const session = await openSession({ width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
    try {
      const pages = { app: server.url };
      const persona = (login: ResolvedPersona['login']): ResolvedPersona =>
        ({ name: 'probe', env: 'test', legacy: false, pages: ['app'], session: 'profile', loginPatterns: [], statusFile: '', login });
      const secrets = new RunSecrets(async () => '');
      const deps = { envPages: pages, kitSource: session.source, secrets, template: { pages, vars: {}, run: { id: 'login' }, hooks: {}, secrets: secrets.resolver } };
      const open = { open: 'app:/options.html' };
      // The page went idle once before the click (Playwright's networkidle has fired); the text must then be there at once
      // after the idle wait (100 ms of polling): the response comes 500 ms after the click.
      const loadPrices = [open, { wait: 0.6 }, { click: { text: 'Load prices' } }, { wait_for: { network_idle: true, timeout: 5 } }, { wait_for: { text: 'prices loaded', timeout: 0.05 } }];
      await autoLogin(session.context, persona(loadPrices), deps);
      await expect(autoLogin(session.context, persona([open, { click: { text: 'Start live feed' } }, { wait_for: { network_idle: true, timeout: 0.6 } }]), deps)).rejects.toThrow(
        /login step 3 \(.*\): the network did not become idle within 0\.6 s \(still loading: http:\/\/127\.0\.0\.1:\d+\/hang\)/,
      );
    } finally {
      await session.close();
    }
  });

  it('click outside: <target> and menu trigger + confirm: true (R-ACT-04, R-ACT-14)', () => {
    expect(byId('org').popup_opened).toBe(true);
    const out = byId('outside-h1');
    expect(out.data).toMatchObject({ closed: true });
    expect(out.target?.desc).toMatch(/Availability/);
    const b = out.target!.bbox!;
    expect(out.point!.x).toBeGreaterThanOrEqual(b.x);
    expect(out.point!.x).toBeLessThanOrEqual(b.x + b.w);
    expect(out.point!.y).toBeGreaterThanOrEqual(b.y);
    expect(out.point!.y).toBeLessThanOrEqual(b.y + b.h);
    const menu = byId('menu-trigger');
    expect(roles(menu).slice(0, 3)).toEqual(['trigger', 'item', 'confirm']);
    expect(roles(menu).slice(3).every((r) => r === 'outside')).toBe(true);
    expect(value('states')).toEqual(['Paused', 'Active']);
    // trigger wins over row discovery: a trigger that does not exist fails even though the row has one.
    expect(byId('trigger-wins').status).toBe('failed');
    expect(byId('trigger-wins').error).toMatch(/no visible element matches css="#nope"/);
  });
});
