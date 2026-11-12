/**
 * The product's clock (L1.7, R-ENV-05), in a real Chromium: a Date-only clock (product-clock.ts) installed in every
 * browser of a session, anchored at capture time 0 (the page reads the clock's time then, and it runs), or frozen — in
 * every document, frame, popup and dedicated worker; the product's own timers, animation frames and `performance` stay
 * the browser's (measured: a clock that faked them slowed them down). Pages kept on the real time (the session check,
 * the sign-in) never get it. The kit keeps the time sources it captured when it started, whatever the page does to its
 * globals. A run with `clock:` reads the clock in the capture and records it.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { kitConfigFor, openSession, runScenario, useRealTime } from '../src/index.js';
import type { CursorEffectPayload } from '../src/index.js';
import { FAST, makeScenario } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

let server: Server;
let A = '';
let dir = '';
/** Far from now: a page or a kit that read the real clock instead would be years away. */
const T = Date.UTC(2020, 0, 1, 9, 0, 0);

const html = (body: string) => `<!doctype html><html><head><title>Clock</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return void res.end('onmessage = () => postMessage([Date.now(), new Date().getUTCFullYear()]);');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (path === '/framed.html') return void res.end(html('<p>Outer</p><iframe src="/"></iframe>'));
    if (path === '/tall.html') return void res.end(html(`<h1>Top</h1><div style="height:4000px"></div><p>Bottom</p>`));
    if (path === '/minute.html') return void res.end(html(`<p id="asof"></p><script>document.getElementById('asof').textContent = 'As of ' + new Date().toISOString().slice(0, 16)</script>`));
    if (path === '/now.html')
      return void res.end(html(`<p id="now"></p><button style="margin:200px">Hover me</button><script>document.getElementById('now').textContent = 'Now ' + new Date().toISOString()</script>`));
    // A page that breaks its own timers and animation frames once loaded: the kit must not depend on them.
    if (path === '/hostile.html') {
      return void res.end(
        html(`<h1>Top</h1><div style="height:4000px"></div><script>
          window.requestAnimationFrame = () => 0; window.setTimeout = () => 0; window.setInterval = () => 0;</script>`),
      );
    }
    res.end(html('<h1>Clock</h1><button style="margin:120px">Press</button>'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  A = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await tempDir('rw-clock-');
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the clock in a session (R-ENV-05)', () => {
  it('anchored at capture time 0: every browser, document, frame, popup and worker reads the time then, and it runs', async () => {
    const session = await openSession({
      policy: PERSON_POLICY,
      width: 800,
      height: 600,
      scale: 1,
      kit: kitConfigFor(undefined),
      realms: [{ name: 'a' }, { name: 'b' }],
      realmOf: (id) => (id === 'a' || id === 'b' ? id : ''),
    });
    try {
      const a = await session.page('a');
      const b = await session.page('b');
      await a.goto(`${A}/framed.html`);
      await b.goto(`${A}/`);
      await session.installClock({ epoch_ms: T });
      // The setup hooks run meanwhile: the time runs from the install…
      await sleep(400);
      expect((await a.evaluate(() => Date.now())) - T).toBeGreaterThanOrEqual(350);
      // … and capture time 0 sets it back to T, in every browser: a page reads T + the time since the anchor (bounds
      // from this process's clock around the calls — no fixed tolerance, the machine may be busy).
      const before = Date.now();
      await session.anchorClock();
      const after = Date.now();
      const since = async (read: () => Promise<number>): Promise<void> => {
        const e0 = Date.now();
        const v = (await read()) - T;
        const e1 = Date.now();
        expect(v).toBeGreaterThanOrEqual(e0 - after - 20);
        expect(v).toBeLessThanOrEqual(e1 - before + 20);
      };
      const now = (p: Page) => () => p.evaluate(() => Date.now());
      for (const p of [a, b]) await since(now(p));
      // A frame of a document loaded before the clock, a frame created now (about:blank), a new document.
      await since(() => a.frames()[1].evaluate(() => Date.now()));
      await since(() => a.evaluate(() => (document.body.appendChild(document.createElement('iframe')).contentWindow as Window & typeof globalThis).Date.now()));
      await sleep(300);
      const later = await session.page('later'); // the default browser, launched now
      await later.goto(`${A}/`);
      await a.goto(`${A}/now.html`);
      for (const p of [a, later]) await since(now(p));
      // A popup, and a dedicated worker (its first lines may run before the clock reaches it: asked after it started).
      const [popup] = await Promise.all([a.waitForEvent('popup'), a.evaluate((u) => void window.open(u), `${A}/`)]);
      await popup.waitForLoadState();
      await since(now(popup));
      let workerYear = 0;
      await since(async () => {
        const [ms, y] = await a.evaluate(
          (u) =>
            new Promise<[number, number]>((res) => {
              const w = new Worker(u);
              w.onmessage = (e) => res(e.data as [number, number]);
              setTimeout(() => w.postMessage(1), 300);
            }),
          `${A}/worker.js`,
        );
        workerYear = y;
        return ms;
      });
      expect(workerYear).toBe(2020);
      // Date as the product uses it: Date(), Intl's default date, an explicit date, instanceof and subclasses.
      expect(
        await a.evaluate(() => [
          Date().slice(11, 15),
          new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric' }).format(),
          new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }).formatToParts().find((p) => p.type === 'year')?.value,
          new Date().toLocaleDateString('en-GB', { timeZone: 'UTC' }),
          new Date(0).getTime(),
          new Date() instanceof Date,
          new (class Stamp extends Date {})().getUTCFullYear(),
          new Date().constructor === Date,
        ]),
      ).toEqual(['2020', '2020', '2020', '01/01/2020', 0, true, 2020, true]);
    } finally {
      await session.close();
    }
  });

  it.skipIf(!MAC_TIMING)("the product's own timers, animation frames and performance stay real (T1: a faked rAF / timer slowed them down)", async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('main');
      await page.goto(`${A}/`);
      await session.installClock({ epoch_ms: T });
      await session.anchorClock();
      await page.goto(`${A}/tall.html`);
      const m = await page.evaluate(async () => {
        // Ten rAF loops and a 10 ms interval for 1 s; then 100 setTimeout(0).
        const counts = new Array(10).fill(0);
        let stop = false;
        for (let i = 0; i < 10; i++) {
          const loop = () => {
            counts[i]++;
            if (!stop) requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        }
        let ticks = 0;
        const iv = setInterval(() => ticks++, 10);
        const p0 = performance.now();
        await new Promise((r) => setTimeout(r, 1000));
        stop = true;
        clearInterval(iv);
        const elapsed = performance.now() - p0;
        const b0 = performance.now();
        await new Promise<void>((r) => {
          let left = 100;
          for (let i = 0; i < 100; i++) setTimeout(() => --left === 0 && r(), 0);
        });
        return {
          fps: Math.min(...counts) / (elapsed / 1000),
          ticks: ticks / (elapsed / 1000),
          elapsed,
          burst: performance.now() - b0,
          paints: performance.getEntriesByName('first-contentful-paint').length,
          year: new Date().getUTCFullYear(),
        };
      });
      expect(m.year).toBe(2020);
      expect(m.elapsed).toBeGreaterThanOrEqual(990); // performance.now runs in real time
      expect(m.fps).toBeGreaterThanOrEqual(45); // a faked rAF: 30 fps with ten loops
      expect(m.ticks).toBeGreaterThanOrEqual(80); // a faked interval: 49 per second
      expect(m.burst).toBeLessThan(100); // a faked setTimeout(0): ~250–500 ms for 100
      expect(m.paints).toBe(1); // a faked performance has no entries
    } finally {
      await session.close();
    }
  });

  it('freeze: Date never moves while timers still fire', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('main');
      await page.goto(`${A}/`);
      await session.installClock({ epoch_ms: T, freeze: true });
      await session.anchorClock(); // a no-op on a frozen clock
      await page.goto(`${A}/`);
      const out = await page.evaluate(async () => {
        const before = Date.now();
        const fired = await new Promise<boolean>((r) => setTimeout(() => r(true), 200));
        return { before, after: Date.now(), made: new Date().getTime(), fired };
      });
      expect(out).toEqual({ before: T, after: T, made: T, fired: true });
    } finally {
      await session.close();
    }
  });

  it('a page kept on the real time (session check, sign-in) never gets the clock: its documents and frames included (T5)', async () => {
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const real = await session.page('check');
      await useRealTime(real);
      await real.goto(`${A}/framed.html`);
      const clocked = await session.page('main');
      await clocked.goto(`${A}/`);
      await session.installClock({ epoch_ms: T });
      await session.anchorClock();
      const year = new Date().getUTCFullYear();
      expect(await real.evaluate(() => new Date().getUTCFullYear())).toBe(year);
      await real.goto(`${A}/framed.html`);
      expect(await real.evaluate(() => new Date().getUTCFullYear())).toBe(year);
      expect(await real.frames()[1].evaluate(() => new Date().getUTCFullYear())).toBe(year);
      // Marked after the clock: from then on.
      const late = await session.page('late');
      await useRealTime(late);
      await late.goto(`${A}/`);
      expect((await late.evaluate(() => Date.now())) - T).toBeGreaterThan(365 * 86_400_000);
      expect(await clocked.evaluate(() => new Date().getUTCFullYear())).toBe(2020);
    } finally {
      await session.close();
    }
  });
});

describe('the kit keeps its own time sources (L1.7 hardening)', () => {
  it('a page that breaks its timers and frames, under a clock: cursor effects carry the real time, scrollAnimate lasts its real duration, afterPaint resolves', async () => {
    const effects: CursorEffectPayload[] = [];
    const session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
    session.onCursorEffect = (_p, e) => effects.push(e);
    try {
      const page = await session.page('main');
      await page.goto(`${A}/`);
      await session.installClock({ epoch_ms: T });
      await session.anchorClock();
      await page.goto(`${A}/hostile.html`);
      expect(await page.evaluate(() => [new Date().getUTCFullYear(), window.requestAnimationFrame(() => undefined)])).toEqual([2020, 0]);
      const kit = session.kit(page);
      await page.mouse.move(200, 200);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(100);
      expect(effects.length).toBeGreaterThan(0);
      for (const e of effects) expect(Math.abs(e.time - Date.now())).toBeLessThan(2000);
      // A scroll animation of 400 ms takes 400 ms of real time (the page's rAF and timers never fire).
      const container = await kit.scrollContainerFor(null);
      const t = Date.now();
      await kit.scrollAnimate(container, 1500, 0, 400);
      expect(Date.now() - t).toBeGreaterThanOrEqual(380);
      expect(Date.now() - t).toBeLessThan(1500);
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
      const p0 = Date.now();
      await page.evaluate(() => (window as unknown as { __retake: { afterPaint(): Promise<void> } }).__retake.afterPaint());
      expect(Date.now() - p0).toBeLessThan(1000);
      // The kit injected again into a document that already has the clock (KitClient.install) takes the real Date the
      // clock kept: its effects still carry the real time.
      await page.goto(`${A}/`);
      await page.evaluate(() => {
        (window as unknown as { __retake?: { dispose(): void } }).__retake?.dispose();
        delete (window as unknown as { __retake?: unknown }).__retake;
      });
      effects.length = 0;
      await kit.cursorSet(300, 300, true);
      await page.mouse.move(320, 320);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(100);
      expect(effects.length).toBeGreaterThan(0);
      for (const e of effects) expect(Math.abs(e.time - Date.now())).toBeLessThan(2000);
    } finally {
      await session.close();
    }
  });
});

describe('a run with a clock (R-ENV-05)', () => {
  it('the capture reads the clock from capture time 0; cursor effects stay on the capture clock; the clock is recorded', async () => {
    const project = makeProject(dir, { app: A });
    const rec = await runScenario({
      policy: PERSON_POLICY,
      project,
      scenario: makeScenario('clock-run', {
        pacing: FAST,
        clock: '2020-01-01T09:00:00Z',
        scenes: [{ id: 'a', page: 'app', open: '/now.html', steps: [{ assert: { text: 'Now 2020-01-01T09:00:0' } }, { hover: 'Hover me' }, { click: 'Hover me' }] }],
      }),
      mode: 'capture',
      env: 'test',
      runId: `clock-run-${Date.now()}`,
    });
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(rec.environment).toEqual({ access: 'read-write', clock: { at: '2020-01-01T09:00:00Z' } });
    const tl = await readTimeline(rec.timeline!);
    expect(tl.environment?.clock).toEqual({ at: '2020-01-01T09:00:00Z', epoch_ms: T });
    const effects = tl.cursor_effects ?? [];
    expect(effects.length).toBeGreaterThan(0);
    for (const e of effects) {
      expect(e.t).toBeGreaterThanOrEqual(0);
      expect(e.t).toBeLessThanOrEqual(tl.capture.duration + 0.5);
    }
  });

  it('two takes read the same date and time (capture_text); a frozen clock is recorded with its zone', async () => {
    const project = makeProject(dir, { app: A });
    project.config.browser = { timezone: 'Europe/Paris' };
    const take = async (n: number, clock: string | { at: string; freeze: true }) => {
      const rec = await runScenario({
        policy: PERSON_POLICY,
        project,
        scenario: makeScenario('clock-takes', {
          pacing: FAST,
          clock,
          scenes: [{ id: 'a', page: 'app', open: '/minute.html', steps: [{ capture_text: { target: { css: '#asof' }, as: 'as-of' } }] }],
        }),
        mode: 'dry',
        env: 'test',
        runId: `clock-take-${n}-${Date.now()}`,
      });
      expect(rec.status).toBe('succeeded');
      const tl = await readTimeline(rec.timeline!);
      return { rec, value: tl.artefacts?.find((a) => a.kind === 'text')?.value };
    };
    const first = await take(1, '2020-01-01T10:00:00');
    await sleep(1100);
    const second = await take(2, '2020-01-01T10:00:00');
    expect([first.value, second.value]).toEqual(['As of 2020-01-01T09:00', 'As of 2020-01-01T09:00']);
    expect(second.rec.environment?.clock).toEqual({ at: '2020-01-01T10:00:00', timezone: 'Europe/Paris' });
    const frozen = await take(3, { at: '2020-01-01T10:00:00', freeze: true });
    expect(frozen.value).toBe('As of 2020-01-01T09:00');
    expect(frozen.rec.environment?.clock).toEqual({ at: '2020-01-01T10:00:00', timezone: 'Europe/Paris', freeze: true });
  });
});
