import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { LoadedProject, Scenario, TimelineEvent } from '@retake/core';
import { runScenario } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { LATE_DIALOG_PAGE, NAV2_PAGE, NAV_PAGE, STRATEGY_PAGE, localePage } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/nav.html': NAV_PAGE,
    '/nav2.html': NAV2_PAGE,
    '/late.html': LATE_DIALOG_PAGE,
    '/strategies.html': STRATEGY_PAGE,
    '/locale.html': (headers) => localePage(String(headers['accept-language'] ?? '')),
  });
  dir = await tempDir('rw-pacing-');
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const stepEvents = (events: TimelineEvent[]) => events.filter((e) => e.step >= 0);

async function run(name: string, scenario: Omit<Scenario, 'video'>, opts: Partial<RunOptions> & { project?: LoadedProject } = {}) {
  const project = opts.project ?? makeProject(dir, { app: server.url });
  const rec = await runScenario({ policy: PERSON_POLICY, project, scenario: makeScenario(name, scenario), mode: 'dry', runId: `${name}-${Date.now()}`, ...opts });
  expect(rec.error?.message).toBeUndefined();
  expect(rec.status).toBe('succeeded');
  return stepEvents((await readTimeline(rec.timeline!)).events);
}

describe('pacing from the field notes', () => {
  it('a plain click whose dialog opens after after_click_ms is recorded as opening it and keeps the post-popup pause (R-MAC-08)', async () => {
    const ev = await run('late', {
      pacing: { ...FAST, after_click_ms: 120, after_popup_ms: 500, popup_timeout_ms: 1200 },
      scenes: [
        {
          id: 'late',
          open: '/late.html',
          steps: [
            // Its target exists: the plain click is not slowed down by the late-popup check.
            { click: 'Plain' },
            { click: 'Open later' },
            // Not on screen yet when the step starts: the dialog opens 450 ms after the click.
            { type: { text: 'Ada', into: { label: 'Name' } } },
          ],
        },
      ],
    });
    expect(ev[0].popup_opened).toBeUndefined();
    expect(ev[0].t_end - ev[0].t_click!).toBeLessThan(0.45);
    expect(ev[1].popup_opened).toBe(true);
    // The click step lasts until the dialog opened (≈ 0.45 s) and the post-popup pause ended; no gap before the next.
    expect(ev[1].t_end - ev[1].t_click!).toBeGreaterThanOrEqual(0.45 + 0.5 * 0.9);
    expect(ev[2].t_start - ev[1].t_end).toBeLessThan(0.08);
  });

  it('content that renders late without a popup ends the late-popup wait as soon as it shows (R-MAC-08)', async () => {
    const ev = await run('late-content', {
      pacing: { ...FAST, after_click_ms: 120, after_popup_ms: 500, popup_timeout_ms: 3000 },
      scenes: [{ id: 'late', open: '/late.html', steps: [{ click: 'Show later' }, { click: 'Shown later' }] }],
    });
    expect(ev[0].popup_opened).toBeUndefined();
    // The button shows 300 ms after the click: the next step starts then, not popup_timeout_ms (3 s) after it.
    expect(ev[1].t_start - ev[0].t_click!).toBeLessThan(0.9);
    expect(ev[0].t_end - ev[0].t_click!).toBeLessThan(0.45);
  });

  it('holds at least after_navigation_ms after a click that changed the page (URL or document), not after a plain click (R-CHO-07)', async () => {
    const ev = await run('nav', {
      pacing: { ...FAST, after_navigation_ms: 1000 },
      scenes: [
        {
          id: 'nav',
          open: '/nav.html',
          steps: [
            { click: 'Plain' },
            { click: 'Open view two' },
            { assert: { text: 'View two', url: '?view=2' } },
            { click: 'Go to page two' },
            { assert: { text: 'Page two' } },
          ],
        },
      ],
    });
    const held = (e: TimelineEvent) => e.t_end - e.t_click!;
    expect(held(ev[0])).toBeLessThan(0.6);
    expect(ev[0].data).toBeUndefined();
    expect(held(ev[1])).toBeGreaterThanOrEqual(0.98);
    expect(ev[1].data).toMatchObject({ navigation: { kind: 'url' } });
    expect(held(ev[3])).toBeGreaterThanOrEqual(0.98);
    expect(ev[3].data).toMatchObject({ navigation: { kind: 'document' } });
  });

  it('falls back to the next click strategy after popup_fallback_ms, not popup_timeout_ms (R-CHO-09)', async () => {
    // popup_timeout_ms is huge on purpose: only the last strategy may wait that long.
    const ev = await run('fallback', {
      pacing: { ...FAST, popup_fallback_ms: 250, popup_timeout_ms: 4000, after_popup_ms: 100 },
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
          ],
        },
      ],
    });
    expect(ev[0]).toMatchObject({ strategy: 'real', popup_opened: true });
    expect(ev[2]).toMatchObject({ strategy: 'dom', popup_opened: true });
    expect(ev[4]).toMatchObject({ strategy: 'pointer', popup_opened: true });
    const took = (e: TimelineEvent) => e.t_end - e.t_click!;
    // real (opens at once) < dom fallback (≈ 250 ms of polling first) < pointer fallback (≈ 2 × 250 ms first).
    expect(took(ev[0])).toBeLessThan(0.45);
    expect(took(ev[2])).toBeGreaterThanOrEqual(0.25);
    expect(took(ev[2])).toBeLessThan(0.8);
    expect(took(ev[4])).toBeGreaterThanOrEqual(0.5);
    expect(took(ev[4])).toBeLessThan(1.1);
  });

  it('project locale drives navigator.language and Accept-Language unless browser.locale is set (R-PROJ-08)', async () => {
    const base = makeProject(dir, { app: server.url });
    const scenes: Scenario['scenes'] = [
      {
        id: 'locale',
        open: '/locale.html',
        steps: [{ eval: "return document.getElementById('nav').textContent + ' ' + document.getElementById('accept').textContent;" }],
      },
    ];
    const withLocale: LoadedProject = { ...base, config: { ...base.config, locale: 'fr-FR' } };
    const fr = await run('locale-fr', { pacing: FAST, scenes }, { project: withLocale });
    expect((fr[0].data as { value: string }).value).toMatch(/^nav=fr-FR accept=fr-FR/);

    const explicit: LoadedProject = { ...withLocale, config: { ...withLocale.config, browser: { locale: 'de-DE' } } };
    const de = await run('locale-de', { pacing: FAST, scenes }, { project: explicit });
    expect((de[0].data as { value: string }).value).toMatch(/^nav=de-DE accept=de-DE/);
  });
});
