import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TimelineSchema, PERSON_POLICY } from '@retake/core';
import type { RunRecord, Scenario, TimelineEvent } from '@retake/core';
import { RunnerError, runScenario, scaleArgs } from '../src/index.js';
import { NO_HOOK_RUNNER } from '../src/hooks-bridge.js';
import type { RunOptions } from '../src/index.js';
import { DOC_PAGE, DROP_PAGE, DRY_PAGE, SCROLL_PAGE, STRATEGY_PAGE, TABS_PAGE } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir, testHookRunner } from './helpers.js';
import type { TestServer } from './helpers.js';
// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

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
    // Hooks' endpoints (R-RUN-08): requests are logged in server.hits.
    '/arm': { body: '{"armed":true}', type: 'application/json' },
    '/reset': { body: '{"reset":true}', type: 'application/json' },
    '/slow-arm': { body: '{"armed":true}', type: 'application/json', delay_ms: 600 },
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
    policy: PERSON_POLICY,
    project,
    scenario: makeScenario(name, { pacing: FAST, ...scenario }),
    mode: 'dry',
    runId: `${name}-${Date.now()}`,
    hookRunner: testHookRunner(),
    ...opts,
  });
}

const stepEvents = (events: TimelineEvent[]) => events.filter((e) => e.step >= 0);

/** Scroll positions of the scroll page: the document and its inner container, with their maximum. */
const POSITIONS =
  "const i = document.getElementById('inner'), d = document.scrollingElement; return { doc: Math.round(scrollY), docMax: d.scrollHeight - innerHeight, inner: Math.round(i.scrollTop), innerMax: i.scrollHeight - i.clientHeight };";

/** A real price list dropped by drop_file `path`. */
const PRICES = 'Origin,Grade,Price per kg,Currency\nFinca Quenaro,AA,12.40,EUR\n';

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
    const lines = (await readFile(join(rec.dir, 'frames.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { t: number });
    const afterSwitch = lines.filter((f) => f.t > ev[4].t_end).length;
    expect(afterSwitch).toBeGreaterThan(3);
    expect(existsSync(rec.capture!)).toBe(true);
  });
});

describe('device scale 2 (4K-class captures, L2.8)', () => {
  it('scaleArgs forces the browser scale factor for headless scale ≠ 1 only', () => {
    expect(scaleArgs(2, false)).toEqual(['--force-device-scale-factor=2']);
    expect(scaleArgs(1, false)).toEqual([]);
    expect(scaleArgs(2, true)).toEqual([]);
    expect(scaleArgs(2, false, ['--force-device-scale-factor=3'])).toEqual([]);
  });

  it('captures real 2× frames: the screencast frames and capture.mp4 are width·2 × height·2', async () => {
    const project = makeProject(dir, { app: server.url }, { width: 640, height: 360 });
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project,
      scenario: makeScenario('scale2', { pacing: FAST, capture: { scale: 2 }, scenes: [{ id: 'doc', open: '/doc.html', steps: [{ hold: 0.6 }] }] }),
      mode: 'capture',
      runId: `scale2-${Date.now()}`,
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    expect(tl.capture).toMatchObject({ width: 640, height: 360, scale: 2 });
    expect(tl.capture.frames).toBeGreaterThan(3);
    const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', rec.capture!], { encoding: 'utf8' }).trim();
    expect(size).toBe('1280,720');
    expect(tl.warnings.filter((w) => /screencast frames stay/.test(w))).toEqual([]);
  });
});

describe('drop_file', () => {
  it('drops on a drop zone, falls back to the hidden input, sets an explicit input, and drops real files', async () => {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'prices.csv'), PRICES);
    await writeFile(join(dir, 'assets', 'notes.bin'), 'tasting notes');
    // 64 MiB + 1 byte, sparse (no disk used): above the cap.
    await writeFile(join(dir, 'assets', 'huge.bin'), '');
    await truncate(join(dir, 'assets', 'huge.bin'), 64 * 1024 * 1024 + 1);
    const rec = await run('drop', {
      // Glides long enough to tell an eased move from a jump whatever the rest point (FAST moves take 60–160 ms).
      pacing: { ...FAST, move_base_ms: 0, move_ms_per_px: 0.9, move_min_ms: 450, move_max_ms: 1100 },
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
            // Real project files (R-ACT-19): their bytes, the mime inferred from the name or given, the size cap.
            { drop_file: { zone: { text: 'Drop your price list here' }, path: 'assets/prices.csv' } },
            { assert: { text: `dropped:prices.csv:${PRICES.length}:text/csv` } },
            { assert: { text: `content:${PRICES.slice(0, 24)}` } },
            { drop_file: { zone: { text: 'Drop your price list here' }, path: 'assets/notes.bin', mime: 'text/plain' } },
            { assert: { text: 'dropped:notes.bin:13:text/plain' } },
            { assert: { text: 'content:tasting notes' } },
            { drop_file: { zone: { text: 'Drop your price list here' }, path: 'assets/huge.bin' }, optional: true },
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
    expect(ev.slice(6, 12).map((e) => e.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(ev[6].data).toMatchObject({ delivered: 'drop' });
    expect(ev[12].status).toBe('failed');
    expect(ev[12].error).toMatch(/huge\.bin is 64\.0 MB; files above 64\.0 MB cannot be dropped/);
    // The cursor travels to the screen edge to fetch the file (eased), it never jumps there.
    for (const i of [0, 2]) {
      const inStep = tl.cursor.filter((c) => c.t >= ev[i].t_start - 0.001 && c.t <= ev[i].t_end);
      const steps = inStep.slice(1).map((c, k) => Math.hypot(c.x - inStep[k].x, c.y - inStep[k].y));
      expect(Math.max(...steps), `drop_file ${i}`).toBeLessThan(200);
      expect(inStep.some((c) => c.x <= 4 || c.x >= 796)).toBe(true); // it did reach the edge
    }
    // R-ISS-05: the drop is recorded like a click (role trigger) and described by the top-level fields.
    for (const [i, strategy] of [
      [0, 'drop'],
      [2, 'input'],
      [4, 'input'],
    ] as const) {
      const e = ev[i];
      const clicks = (e.data as { clicks: Array<Record<string, unknown>> }).clicks;
      expect(clicks).toHaveLength(1);
      expect(clicks[0]).toMatchObject({ role: 'trigger', strategy, popup_opened: false, t_click: e.t_click, point: e.point });
      expect(clicks[0].bbox).toEqual(e.target?.bbox);
      expect(e).toMatchObject({ strategy, popup_opened: false });
    }
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
            // By px, to top / bottom / a number, in an explicit container (R-ACT-16); positions read after each.
            { scroll: { to: 'top', duration: 0.2 } },
            { eval: POSITIONS },
            { scroll: { by: 300, duration: 0.2 } },
            { eval: POSITIONS },
            { scroll: { to: 560, duration: 0.2 } },
            { eval: POSITIONS },
            { scroll: { to: 'bottom', duration: 0.2 } },
            { eval: POSITIONS },
            { scroll: { in: '#inner', to: 'bottom', duration: 0.2 } },
            { eval: POSITIONS },
            { scroll: { in: '#inner', by: -80, duration: 0.2 } },
            { eval: POSITIONS },
          ],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    const ev = stepEvents(tl.events);
    type Pos = { doc: number; docMax: number; inner: number; innerMax: number };
    const pos = (i: number) => (ev[i].data as { value: Pos }).value;
    const moved = (i: number) => ev[i].data as { container: string; from: number; to: number };
    expect(pos(7).doc).toBe(0);
    expect(moved(8)).toMatchObject({ container: 'document', from: 0, to: 300 });
    expect(pos(9).doc).toBe(300);
    expect(pos(11).doc).toBe(560);
    expect(pos(13).docMax).toBeGreaterThan(1000);
    expect(pos(13).doc).toBe(pos(13).docMax);
    // The container's own scroll; the document stays where it was.
    expect(moved(14).container).not.toBe('document');
    expect(pos(15).inner).toBe(pos(15).innerMax);
    expect(pos(15).doc).toBe(pos(13).doc);
    expect(moved(16)).toMatchObject({ from: pos(15).innerMax, to: pos(15).innerMax - 80 });
    expect(pos(17).inner).toBe(pos(15).innerMax - 80);
    expect(pos(17).doc).toBe(pos(13).doc);
    const innerTop = (ev[1].data as { value: number }).value;
    // Region 30 is at 29 × 40 px inside the container; offset -40.
    expect(Math.abs(innerTop - (29 * 40 - 40))).toBeLessThanOrEqual(2);
    expect((ev[0].data as { container: string }).container).not.toBe('document');
    const docTop = (ev[5].data as { value: number }).value;
    expect(docTop).toBeGreaterThan(1500);
    // Default pacing.scroll_offset −140: the target ends ~140 px below the top (field notes, R-CHO-17).
    expect(ev[4].target?.bbox?.y).toBeCloseTo(140, -1);
  });
});

describe('phase-2 contracts: cards, overlays, camera at the end of the step, video block (L2.1)', () => {
  it('records card scenes and overlay anchors; overlay and camera targets are measured after the scroll', async () => {
    const rec = await run('phase2', {
      title: { kicker: 'For suppliers', text: 'Availability' },
      intro: { component: 'studio/intro-minimal', duration: 2 },
      outro: false,
      music: { file: 'assets/bed.mp3', volume: 0.3 },
      scenes: [
        { card: { slots: { kicker: 'Chapter one', title: 'Regions' }, duration: 2 }, id: 'chapter' },
        {
          id: 'regions',
          open: '/scroll.html',
          frame: 'studio/layout-browser',
          steps: [
            // The SPEC example: scroll to "Awards" with a camera on "Awards" (+ an overlay pointing at it).
            {
              scroll: { to: { text: 'Awards' }, duration: 0.3 },
              camera: { zoom: 1.3, target: { text: 'Awards' } },
              overlay: { component: 'studio/overlay-callout', slots: { text: 'Prizes' }, duration: 2, target: { text: 'Awards' } },
            },
            { scroll: { to: 'top', duration: 0.3 } },
            // Default targets: the step's own (post-scroll) target.
            {
              scroll: { to: { text: 'Awards' }, duration: 0.3 },
              camera: { zoom: 1.2 },
              overlay: { component: 'studio/overlay-lower-third', slots: { title: 'Awards' } },
            },
            { wait: 0.1, overlay: { component: 'studio/overlay-lower-third', params: { side: 'left' } } },
            { wait: 0.1, overlay: { component: 'studio/overlay-callout', target: { text: 'No such element' } } },
          ],
        },
        { interstitial: { text: 'Later', component: 'studio/interstitial-plain', params: { tone: 'dark' } } },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    const tl = await readTimeline(rec.timeline!);
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    expect(tl.scenes.map((x) => `${x.id}:${x.kind}`)).toEqual(['chapter:card', 'regions:scene', 'interstitial-2:interstitial']);
    const [card, scene, inter] = tl.scenes;
    expect(card).toMatchObject({ index: 0, card: { slots: { kicker: 'Chapter one', title: 'Regions' }, duration: 2 }, status: 'ok' });
    expect(card.t_start).toBe(card.t_end);
    expect(card.t_end).toBeLessThanOrEqual(scene.t_start);
    expect(scene.frame).toBe('studio/layout-browser');
    expect(inter.interstitial).toEqual({ text: 'Later', component: 'studio/interstitial-plain', params: { tone: 'dark' } });
    expect(tl.video).toEqual({
      title: { kicker: 'For suppliers', text: 'Availability' },
      intro: { component: 'studio/intro-minimal', duration: 2 },
      outro: false,
      frame: 'raw',
      template: 'editorial',
      music: { file: 'assets/bed.mp3', volume: 0.3 },
    });

    const ev = stepEvents(tl.events);
    // Awards starts ~1900 px down the page: the boxes below are the post-scroll ones (~140 px from the top).
    const explicit = ev[0];
    expect(explicit.overlay).toMatchObject({ component: 'studio/overlay-callout', slots: { text: 'Prizes' }, params: {}, duration: 2 });
    expect(explicit.overlay?.target).toContain('Awards');
    expect(explicit.overlay?.bbox?.y).toBeCloseTo(140, -1);
    expect(explicit.overlay?.point).toBeUndefined();
    expect(explicit.camera?.bbox?.y).toBeCloseTo(140, -1);
    expect(explicit.camera?.bbox).toEqual(explicit.overlay?.bbox);
    const byDefault = ev[2];
    expect(byDefault.overlay).toMatchObject({ component: 'studio/overlay-lower-third', slots: { title: 'Awards' }, params: {} });
    expect(byDefault.overlay?.duration).toBeUndefined();
    expect(byDefault.overlay?.bbox?.y).toBeCloseTo(140, -1);
    expect(byDefault.camera?.bbox?.y).toBeCloseTo(140, -1);
    // No target at all: anchored to the cursor; a missing target falls back to the cursor with a warning.
    expect(ev[3].overlay).toMatchObject({ params: { side: 'left' }, point: expect.objectContaining({ x: expect.any(Number) }) });
    expect(ev[3].overlay?.bbox).toBeUndefined();
    expect(ev[4].overlay?.bbox).toBeUndefined();
    expect(ev[4].overlay?.point).toBeDefined();
    expect(tl.warnings.some((w) => w.includes('overlay target') && w.includes('No such element'))).toBe(true);
    // Events without the modifier carry no overlay.
    expect(ev[1].overlay).toBeUndefined();
    // L5.5: every completed step records the cursor at its end, where an overlay added after the take anchors.
    for (const e of ev) expect(e.end_point, `${e.scene}.${e.step}`).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(ev[3].end_point).toEqual(ev[3].overlay?.point);
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
    const log = (await readFile(join(rec.dir, 'log.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
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

  it.skipIf(!MAC_TIMING)('an AbortSignal cancels the run and teardown still happens: teardown hooks, then the setup rollbacks (R-RUN-08)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1200);
    const t0 = Date.now();
    const from = server.hits.length;
    const rec = await run(
      'cancel',
      {
        setup: [{ name: 'arm', http: { method: 'POST', url: '{{app}}/arm', rollback: { method: 'DELETE', url: '{{app}}/arm' } } }],
        teardown: [{ name: 'reset', http: { method: 'POST', url: '{{app}}/reset' } }],
        scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 20 }] }],
      },
      { signal: ac.signal, mode: 'capture' },
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(rec.status).toBe('cancelled');
    expect(existsSync(rec.timeline!)).toBe(true);
    expect(rec.capture).toBeUndefined();
    // Teardown ran after the cancel, then the setup's rollback: nothing is left pending in the run's journal.
    expect(rec.hooks).toEqual({ setup: 'ok', teardown: 'ok' });
    const hooks = server.hits.slice(from).filter((h) => h.path === '/arm' || h.path === '/reset');
    expect(hooks.map((h) => `${h.method} ${h.path}`)).toEqual(['POST /arm', 'POST /reset', 'DELETE /arm']);
    const journal = JSON.parse(await readFile(join(rec.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string; rollback?: unknown }> };
    expect(journal.entries.map((e) => e.status)).toEqual(['rolled_back', 'ok']);
    expect(journal.entries.filter((e) => e.status === 'ok' && e.rollback)).toEqual([]);
  });

  it('a cancel during a setup shell hook stops its process group, rolls the setup back and still tears down (R-RUN-08)', async () => {
    const ac = new AbortController();
    const from = server.hits.length;
    // This copy's own sleep (pid + random): another copy of the suite running at the same time has its own.
    const command = `sleep 29.${process.pid}${Math.floor(Math.random() * 1e6)}`;
    const sleeping = () =>
      execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
        .split('\n')
        .some((l) => l.trim() === command);
    const t0 = Date.now();
    const done = run(
      'cancel-setup',
      {
        setup: [
          { name: 'arm', http: { method: 'POST', url: '{{app}}/arm', rollback: { method: 'DELETE', url: '{{app}}/arm' } } },
          { name: 'seed', shell: command },
          { name: 'never', http: { method: 'POST', url: '{{app}}/reset' } },
        ],
        teardown: [{ name: 'reset', http: { method: 'POST', url: '{{app}}/reset' } }],
        scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 20 }] }],
      },
      { signal: ac.signal, mode: 'capture' },
    );
    while (!sleeping() && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
    expect(sleeping()).toBe(true);
    ac.abort();
    const rec = await done;
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(sleeping()).toBe(false);
    expect(rec.status).toBe('cancelled');
    expect(rec.hooks).toEqual({ setup: 'failed', teardown: 'ok' });
    expect(rec.steps_done).toBe(0);
    // The arming was rolled back as the setup stopped, the next setup hook never ran, then the teardown.
    const hooks = server.hits.slice(from).filter((h) => h.path === '/arm' || h.path === '/reset');
    expect(hooks.map((h) => `${h.method} ${h.path}`)).toEqual(['POST /arm', 'DELETE /arm', 'POST /reset']);
    const journal = JSON.parse(await readFile(join(rec.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string; error?: string }> };
    expect(journal.entries.map((e) => e.status)).toEqual(['rolled_back', 'failed', 'ok']);
    expect(journal.entries[1].error).toContain('was interrupted (its process group stopped)');
  });

  it('a cancel during an http setup hook (it ends first) also rolls the setup back before the teardown (R-RUN-08)', async () => {
    const ac = new AbortController();
    const from = server.hits.length;
    const hooks = () =>
      server.hits
        .slice(from)
        .filter((h) => ['/arm', '/slow-arm', '/never', '/reset'].includes(h.path))
        .map((h) => `${h.method} ${h.path}`);
    const t0 = Date.now();
    const done = run(
      'cancel-http',
      {
        setup: [
          { name: 'arm', http: { method: 'POST', url: '{{app}}/arm', rollback: { method: 'DELETE', url: '{{app}}/arm' } } },
          { name: 'slow', http: { method: 'POST', url: '{{app}}/slow-arm', rollback: { method: 'DELETE', url: '{{app}}/slow-arm' } } },
          { name: 'never', http: { method: 'POST', url: '{{app}}/never' } },
        ],
        teardown: [{ name: 'reset', http: { method: 'POST', url: '{{app}}/reset' } }],
        scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 20 }] }],
      },
      { signal: ac.signal, hooks: 'run' }, // a dry run executes its hooks when asked to
    );
    while (!hooks().includes('POST /slow-arm') && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 20));
    ac.abort(); // the slow hook's answer comes 600 ms later
    const rec = await done;
    expect(rec.status).toBe('cancelled');
    expect(rec.hooks).toEqual({ setup: 'failed', teardown: 'ok' });
    // Both completed hooks rolled back as the setup stopped (most recent first), the next one never ran, then the teardown.
    expect(hooks()).toEqual(['POST /arm', 'POST /slow-arm', 'DELETE /slow-arm', 'DELETE /arm', 'POST /reset']);
    const journal = JSON.parse(await readFile(join(rec.dir, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string }> };
    expect(journal.entries.map((e) => e.status)).toEqual(['rolled_back', 'rolled_back', 'ok']);
  });

  it('the hooks run through the hook runner handed in (L7.12): none handed is refused before anything runs; one whose load fails fails the run as a hooks package that could not be loaded did', async () => {
    const from = server.hits.length;
    const sc = { pacing: FAST, setup: [{ name: 'arm', http: { method: 'POST' as const, url: '{{app}}/arm' } }], scenes: [{ id: 'one', open: '/dry.html', steps: [{ wait: 0.1 }] }] };
    const project = makeProject(dir, { app: server.url });
    const runId = `no-runner-${Date.now()}`;
    const refused = await runScenario({ policy: PERSON_POLICY, project, scenario: makeScenario('no-runner', sc), mode: 'capture', runId }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(RunnerError);
    expect((refused as Error).message).toBe(NO_HOOK_RUNNER);
    expect(NO_HOOK_RUNNER).toBe('this scenario has hooks (setup, teardown or hook steps) but no hook runner was handed to the runner (RunOptions.hookRunner)');
    expect(existsSync(join(dir, 'runs', runId))).toBe(false);
    // --hooks skip: nothing to run them with is needed.
    const skipped = await runScenario({ policy: PERSON_POLICY, project, scenario: makeScenario('no-runner-skip', sc), mode: 'dry', runId: `no-runner-skip-${Date.now()}` });
    expect(skipped.status).toBe('succeeded');
    expect(skipped.hooks.setup).toBe('skipped');

    const used: string[] = [];
    const broken = {
      load: async () => {
        used.push('load');
        throw new Error('Cannot find package');
      },
      run: async () => {
        used.push('run');
        return { ok: true, results: [] };
      },
      journals: {
        open: async () => {
          used.push('open');
          throw new Error('not opened');
        },
      },
    };
    const rec = await run('broken-runner', sc, { mode: 'capture', hookRunner: broken });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toBe('this scenario has hooks (setup, teardown or hook steps) but @retake/hooks could not be loaded: Cannot find package');
    expect(used).toEqual(['load']);
    expect(server.hits.slice(from).filter((h) => h.path === '/arm')).toEqual([]);
  });
});
