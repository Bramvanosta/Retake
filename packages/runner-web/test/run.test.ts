import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord, Scenario, TimelineEvent } from '@demo-studio/core';
import { runScenario } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { DOC_PAGE, DROP_PAGE, DRY_PAGE, SCROLL_PAGE, STRATEGY_PAGE, TABS_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/strategies.html': STRATEGY_PAGE,
    '/tabs.html': TABS_PAGE,
    '/doc.html': DOC_PAGE,
    '/drop.html': DROP_PAGE,
    '/scroll.html': SCROLL_PAGE,
    '/dry.html': DRY_PAGE,
  });
  dir = await tempDir();
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> = {}): Promise<RunRecord> {
  const project = makeProject(dir, { app: server.url });
  return runScenario({
    project,
    scenario: makeScenario(name, { pacing: FAST, ...scenario }),
    mode: 'dry',
    runId: `${name}-${Date.now()}`,
    ...opts,
  });
}

const stepEvents = (events: TimelineEvent[]) => events.filter((e) => e.step >= 0);

describe('click strategies', () => {
  it('falls back from real input to el.click() to a pointer sequence when an expected popup does not open', async () => {
    const rec = await run('strategies', {
      scenes: [
        {
          id: 'widgets',
          open: '/strategies.html',
          steps: [
            { click: { css: '#a' } },
            { click: { outside: true } },
            { click: { css: '#b' } },
            { click: { outside: true } },
            { click: { css: '#c' } },
            { click: { outside: true } },
            { click: 'Plain button' },
            { assert: { text: 'open-a open-b open-c plain' } },
          ],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    expect(ev[0]).toMatchObject({ action: 'click', strategy: 'real', popup_opened: true });
    expect(ev[2]).toMatchObject({ strategy: 'dom', popup_opened: true });
    expect(ev[4]).toMatchObject({ strategy: 'pointer', popup_opened: true });
    expect(ev[6].strategy).toBe('real');
    expect(ev[6].popup_opened).toBeUndefined();
    // Click outside closed each popup before the next click.
    for (const i of [1, 3, 5]) expect((ev[i].data as { closed: boolean }).closed).toBe(true);
    for (const e of ev.slice(0, 7)) {
      expect(e.t_click).toBeGreaterThanOrEqual(e.t_start);
      expect(e.t_click).toBeLessThanOrEqual(e.t_end);
    }
  });
});

describe('new_tab', () => {
  it('follows a real target=_blank link and a prevented link (href fallback); recording continues', async () => {
    const rec = await run(
      'tabs',
      {
        scenes: [
          {
            id: 'quote',
            open: '/tabs.html',
            steps: [
              { new_tab: { target: { css: '#blank' } } },
              { assert: { text: 'Quote 1' } },
              { hold: 0.4 },
              { switch_page: 'previous' },
              { new_tab: { target: { text: 'Download quote PDF' }, as: 'pdf' } },
              { assert: { text: 'Quote 2' } },
              { hold: 0.6 },
            ],
          },
        ],
      },
      { mode: 'capture' },
    );
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    expect(ev[0].data).toMatchObject({ page: 'tab2', how: 'popup' });
    expect(ev[0].page).toBe('tab2');
    expect(ev[4].data).toMatchObject({ page: 'pdf', how: 'href' });
    expect(ev[4].url).toContain('/doc.html?n=2');
    const ids = tl.pages.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['app', 'tab2', 'pdf']));
    // Frames keep coming after the last switch (the new page is being recorded).
    const lines = (await readFile(join(rec.dir, 'frames.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { t: number });
    const afterSwitch = lines.filter((f) => f.t > ev[4].t_end).length;
    expect(afterSwitch).toBeGreaterThan(3);
    expect(existsSync(rec.capture!)).toBe(true);
  });
});

describe('drop_file', () => {
  it('drops on a drop zone, falls back to the hidden input, and sets an explicit input', async () => {
    const rec = await run('drop', {
      scenes: [
        {
          id: 'import',
          open: '/drop.html',
          steps: [
            { drop_file: { zone: { text: 'Drop your price list here' }, name: 'Northfield - Price list 2027.xlsx', fake: true } },
            { assert: { text: 'dropped:Northfield - Price list 2027.xlsx:49152:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } },
            { drop_file: { zone: { text: 'Click to choose a file' }, name: 'Catalogue.csv', fake: true, size: 1200, from: 'left' } },
            { assert: { text: 'chosen:Catalogue.csv:1200' } },
            { drop_file: { zone: '#zone3', input: '#file3', name: 'Origins.pdf', fake: true } },
            { assert: { text: 'explicit:Origins.pdf' } },
          ],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    expect(ev[0].data).toMatchObject({ delivered: 'drop' });
    expect(ev[2].data).toMatchObject({ delivered: 'input' });
    expect(ev[4].data).toMatchObject({ delivered: 'input' });
  });
});

describe('scroll', () => {
  it('scrolls an inner container to a target, auto-scrolls to click, and scrolls the document', async () => {
    const rec = await run('scroll', {
      scenes: [
        {
          id: 'regions',
          open: '/scroll.html',
          steps: [
            { scroll: { to: { text: 'Region 30' }, offset: -40, duration: 0.3 } },
            { eval: "return document.getElementById('inner').scrollTop;" },
            { click: 'Deep action' },
            { assert: { text: 'Deep action done' } },
            { scroll: { to: { text: 'Awards' }, duration: 0.3 } },
            { eval: 'return window.scrollY;' },
          ],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    const innerTop = (ev[1].data as { value: number }).value;
    // Region 30 is at 29 × 40 px inside the container; offset -40.
    expect(Math.abs(innerTop - (29 * 40 - 40))).toBeLessThanOrEqual(2);
    expect((ev[0].data as { container: string }).container).not.toBe('document');
    const docTop = (ev[5].data as { value: number }).value;
    expect(docTop).toBeGreaterThan(1500);
    expect(ev[4].target?.bbox?.y).toBeCloseTo(120, -1);
  });
});

describe('dry-run, --until, failures, cancellation', () => {
  const twoScenes: Omit<Scenario, 'video'> = {
    scenes: [
      {
        id: 'one',
        open: '/dry.html',
        steps: [{ click: 'Save draft' }, { click: 'Delete everything', irreversible: true }, { click: 'After' }],
      },
      { id: 'two', steps: [{ click: 'Other' }, { assert: { text: 'save other' } }] },
    ],
  };

  it('dry-run stops a scene at an irreversible step (hovered, not clicked) and continues with the next scene', async () => {
    const rec = await run('dry', twoScenes);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(rec.stopped_at).toEqual({ scene: 'one', step: 1, reason: 'irreversible' });
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    expect(ev.map((e) => `${e.scene}.${e.step}:${e.status}`)).toEqual(['one.0:ok', 'one.1:dry', 'one.2:skipped', 'two.0:ok', 'two.1:ok']);
    expect(ev[1].target?.desc).toContain('Delete everything');
    expect(tl.scenes.map((s) => s.status)).toEqual(['partial', 'ok']);
    expect(rec.screenshots.length).toBe(4);
    for (const f of rec.screenshots) expect(existsSync(f)).toBe(true);
    expect(tl.mode).toBe('dry');
  });

  it('--until stops after the given step', async () => {
    const rec = await run('until', twoScenes, { until: 'one.0' });
    expect(rec.status).toBe('succeeded');
    expect(rec.stopped_at).toEqual({ scene: 'one', step: 0, reason: 'until' });
    const tl = await readTimeline(rec.timeline!);
    expect(stepEvents(tl.events).map((e) => `${e.scene}.${e.step}`)).toEqual(['one.0']);
    expect(rec.steps_total).toBe(1);
    await expect(run('until-bad', twoScenes, { until: 'nope.9' })).rejects.toThrow(/matches no step/);
  });

  it('a failing step writes an error screenshot + DOM snippet, marks the run failed and still tears down', async () => {
    const sigint = process.listenerCount('SIGINT');
    const rec = await run(
      'failing',
      {
        scenes: [
          { id: 'one', open: '/dry.html', steps: [{ click: 'Save draft' }, { click: 'Publish catalogue', timeout: 0.6 }, { click: 'After' }] },
          { id: 'two', steps: [{ click: 'Other' }] },
        ],
      },
      { mode: 'capture' },
    );
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatchObject({ scene: 'one', step: 1, action: 'click' });
    expect(rec.error!.message).toMatch(/no visible element matches text="Publish catalogue" after 0\.6 s/);
    expect(rec.error!.message).toMatch(/nearby visible texts: .*"Save draft"/);
    expect(existsSync(rec.error!.screenshot!)).toBe(true);
    const html = await readFile(rec.error!.dom!, 'utf8');
    expect(html).toContain('Delete everything');
    expect(html).toContain('Publish catalogue');
    const onDisk = JSON.parse(await readFile(join(rec.dir, 'run.json'), 'utf8')) as RunRecord;
    expect(onDisk.status).toBe('failed');
    expect(onDisk.finished_at).toBeTruthy();
    // Teardown: recording stopped and encoded, timeline written, signal handlers removed.
    expect(existsSync(rec.capture!)).toBe(true);
    const tl = await readTimeline(rec.timeline!);
    expect(stepEvents(tl.events).map((e) => e.status)).toEqual(['ok', 'failed']);
    expect(tl.scenes.map((s) => s.status)).toEqual(['failed']);
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    const log = (await readFile(join(rec.dir, 'log.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(log[0].type).toBe('run_start');
    expect(log[log.length - 1].type).toBe('run_end');
  });

  it('an optional failing step is logged and the run continues', async () => {
    const rec = await run('optional', {
      scenes: [{ id: 'one', open: '/dry.html', steps: [{ click: 'Nowhere', timeout: 0.3, optional: true }, { click: 'Other' }] }],
    });
    expect(rec.status).toBe('succeeded');
    expect(rec.warnings.join(' ')).toMatch(/optional/);
  });

  it('an AbortSignal cancels the run and teardown still happens', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1200);
    const t0 = Date.now();
    const rec = await run('cancel', { scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 20 }] }] }, { signal: ac.signal, mode: 'capture' });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(rec.status).toBe('cancelled');
    expect(existsSync(rec.timeline!)).toBe(true);
    expect(rec.capture).toBeUndefined();
  });
});
