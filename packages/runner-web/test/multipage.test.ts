/**
 * L2.11 runner: a multi-page scene (`pages:`) films its pages at the same time on one clock — one screencast per page,
 * each encoded on the shared CFR grid (capture-<id>.mp4) —, with independent viewports (a mobile one emulated), a
 * cursor per page (only the acting page's moves; a short pause when the acting page changes), a timeline track per
 * page and every event tagged with its page. Single-page scenes around it record capture.mp4 as before.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PACING, TimelineSchema, PERSON_POLICY } from '@retake/core';
import type { RunRecord, Timeline } from '@retake/core';
import { runScenario } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';

const SHOP = `<!doctype html><html><head><title>Shop</title><meta name="viewport" content="width=device-width"></head>
<body style="font-family:sans-serif;margin:0;padding:40px;background:#f6f1ea">
<h1>Shop</h1><p id="info"></p>
<button id="send" style="font-size:22px;padding:14px 28px" onclick="fetch('/send',{method:'POST'}).then(()=>{document.getElementById('done').textContent='Request sent'})">Send request</button>
<p id="done"></p>
<script>document.getElementById('info').textContent = 'shop width ' + innerWidth</script>
</body></html>`;

const CONSOLE = `<!doctype html><html><head><title>Console</title><meta name="viewport" content="width=device-width"></head>
<body style="font-family:sans-serif;margin:0;padding:24px;background:#eef2f6">
<h1>Console</h1><p id="info"></p>
<ul id="list"></ul>
<button id="ack" style="font-size:20px;padding:12px 20px;display:none" onclick="this.textContent='Acknowledged'">Acknowledge</button>
<script>
document.getElementById('info').textContent = 'console width ' + innerWidth + ' touch ' + (navigator.maxTouchPoints > 0);
setInterval(() => fetch('/state').then((r) => r.json()).then((s) => {
  if (s.sent && !document.getElementById('got')) {
    const li = document.createElement('li'); li.id = 'got'; li.textContent = 'Got it'; document.getElementById('list').appendChild(li);
    document.getElementById('ack').style.display = 'inline-block';
  }
}), 150);
</script>
</body></html>`;

let server: { url: string; close: () => Promise<void> };
let dir: string;
let rec: RunRecord;
let tl: Timeline;

beforeAll(async () => {
  let sent = false;
  const srv = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/send') {
      sent = true;
      res.writeHead(204).end();
      return;
    }
    if (path === '/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ sent }));
      return;
    }
    const body = path === '/console.html' ? CONSOLE : SHOP;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  server = { url, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
  dir = await tempDir('rw-multipage-');
  rec = await runScenario({
    policy: PERSON_POLICY,
    project: makeProject(dir, { shop: url, console: url }),
    scenario: makeScenario('two-pages', {
      pacing: { ...FAST, page_switch_ms: 400 },
      scenes: [
        { id: 'intro', open: '/shop.html', steps: [{ hold: 0.3 }] },
        {
          id: 'both',
          pages: {
            buyer: { page: 'shop', open: '/shop.html', label: 'Buyer' },
            seller: { page: 'console', open: '/console.html', viewport: { width: 360, height: 560, mobile: true, touch: true }, label: 'Seller' },
          },
          steps: [
            { assert: { text: 'shop width 800' } },
            { on: 'seller', assert: { text: 'console width 360 touch true' } },
            { click: { css: '#send' } },
            { on: 'seller', wait_for: { text: 'Got it' } },
            { on: 'seller', click: { css: '#ack' } },
            { on: 'seller', assert: { text: 'Acknowledged' } },
            { hold: 0.3 },
          ],
        },
        { id: 'after', steps: [{ assert: { text: 'Request sent' } }, { hold: 0.3 }] },
      ],
    }),
    mode: 'capture',
    runId: `multipage-${Date.now()}`,
  });
  expect(rec.error?.message).toBeUndefined();
  tl = await readTimeline(rec.timeline!);
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const stepsOf = (scene: string) => tl.events.filter((e) => e.scene === scene && e.step >= 0);
const probe = (file: string) =>
  execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' })
    .trim()
    .split(',')
    .map(Number);

describe('multi-page scenes (R-MPC-01)', () => {
  it('records each page of the scene on its own track: one file per page on the shared frame grid, own viewport', async () => {
    expect(rec.status).toBe('succeeded');
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    const tracks = tl.tracks ?? [];
    expect(tracks.map((t) => t.id)).toEqual(['buyer', 'seller']);
    const [buyer, seller] = tracks;
    expect(buyer).toMatchObject({ width: 800, height: 600, file: 'capture-buyer.mp4', frames_file: 'frames-buyer.jsonl' });
    expect(buyer.mobile).toBeUndefined();
    expect(seller).toMatchObject({ width: 360, height: 560, mobile: true, touch: true, file: 'capture-seller.mp4' });
    for (const t of tracks) {
      expect(existsSync(join(rec.dir, t.file)), t.file).toBe(true);
      expect(existsSync(join(rec.dir, t.frames_file)), t.frames_file).toBe(true);
      expect(t.frames, t.id).toBeGreaterThan(3);
      expect(t.recording.length, t.id).toBeGreaterThan(0);
    }
    // Same grid: every track (and the main capture) has the same frame count at the same fps.
    const [bw, bh, bn] = probe(join(rec.dir, buyer.file));
    const [sw, sh, sn] = probe(join(rec.dir, seller.file));
    const [, , mn] = probe(rec.capture!);
    expect([bw, bh]).toEqual([800, 600]);
    expect([sw, sh]).toEqual([360, 560]);
    expect(sn).toBe(bn);
    expect(mn).toBe(bn);
    // The pages really ran at their viewport (the scenario asserts what each page reports: width, touch support).
    const sellerFrames = (await readFile(join(rec.dir, seller.frames_file), 'utf8')).trim().split('\n');
    expect(sellerFrames.length).toBeGreaterThan(3);
    // Each track records while its scene films it only.
    const scene = tl.scenes.find((s) => s.id === 'both')!;
    for (const t of tracks) {
      expect(t.recording[0].t_start, t.id).toBeGreaterThanOrEqual(scene.t_start - 0.05);
      expect(t.recording[t.recording.length - 1].t_end, t.id).toBeLessThanOrEqual(scene.t_end + 0.3);
    }
  });

  it('the timeline scene lists its pages (viewport, label, track); every event is tagged with its page', () => {
    const scene = tl.scenes.find((s) => s.id === 'both')!;
    expect(scene.pages).toEqual([
      expect.objectContaining({ id: 'buyer', page: 'shop', label: 'Buyer', track: 'buyer', viewport: expect.objectContaining({ width: 800, height: 600 }) }),
      expect.objectContaining({ id: 'seller', page: 'console', label: 'Seller', track: 'seller', viewport: expect.objectContaining({ width: 360, height: 560, mobile: true }) }),
    ]);
    expect(scene.pages![0].url).toContain('/shop.html');
    expect(scene.pages![1].url).toContain('/console.html');
    const ev = stepsOf('both');
    expect(ev.map((e) => [e.action, e.page])).toEqual([
      ['assert', 'buyer'],
      ['assert', 'seller'],
      ['click', 'buyer'],
      ['wait_for', 'seller'],
      ['click', 'seller'],
      ['assert', 'seller'],
      ['hold', 'buyer'],
    ]);
    const opens = tl.events.filter((e) => e.scene === 'both' && e.action === 'scene_open');
    expect(opens.map((e) => e.page)).toEqual(['buyer', 'seller']);
    // Single-page scenes are unchanged: no `pages`, the main capture.
    expect(tl.scenes.find((s) => s.id === 'intro')!.pages).toBeUndefined();
    expect(tl.scenes.find((s) => s.id === 'after')!.page).toBe('buyer');
    expect(stepsOf('after').every((e) => e.page === undefined || e.page === 'buyer')).toBe(true);
  });

  it('one cursor per page: only the acting page’s cursor moves; a pause when the acting page changes (R-MPC-05)', () => {
    const [buyer, seller] = tl.tracks!;
    const ev = stepsOf('both').slice(2);
    const moved = (track: typeof buyer, from: number, to: number) => {
      const s = track.cursor.filter((c) => c.t >= from && c.t <= to);
      return s.some((c) => Math.hypot(c.x - s[0].x, c.y - s[0].y) > 2);
    };
    const click = ev[0];
    expect(moved(buyer, click.t_start, click.t_end)).toBe(true);
    expect(moved(seller, click.t_start, click.t_end)).toBe(false);
    const ack = ev[2];
    expect(moved(seller, ack.t_start, ack.t_end)).toBe(true);
    expect(moved(buyer, ack.t_start, ack.t_end)).toBe(false);
    // The click landed on each page in its own coordinates (the mobile page is 360 px wide).
    expect(ack.point!.x).toBeLessThan(360);
    // Switching from the buyer to the seller pauses `page_switch_ms` (400 ms here) first.
    expect(ev[1].t_start - click.t_end).toBeGreaterThanOrEqual(0.38);
    expect(DEFAULT_PACING.page_switch_ms).toBe(500);
    // The seller's page saw the buyer's request arrive while both were filmed (the wait ended on its own track).
    expect(ev[1].status).toBe('ok');
  });
});

describe('multi-page scenes: errors', () => {
  it('a mobile page cannot be filmed by a single-page scene; a page keeps its viewport', async () => {
    const project = makeProject(dir, { shop: server.url, console: server.url });
    const bad = await runScenario({
      policy: PERSON_POLICY,
      project,
      scenario: makeScenario('bad-mobile', {
        pacing: FAST,
        scenes: [
          { id: 'both', pages: { a: { page: 'shop', open: '/shop.html' }, b: { page: 'console', open: '/console.html', viewport: 'mobile' } }, steps: [{ hold: 0.1 }] },
          { id: 'solo', page: 'b', steps: [{ hold: 0.1 }] },
        ],
      }),
      mode: 'dry',
      runId: `bad-mobile-${Date.now()}`,
    });
    expect(bad.status).toBe('failed');
    expect(bad.error?.message).toMatch(/page "b" has a 390×844 viewport: a single-page scene films the capture size/);
    const twice = await runScenario({
      policy: PERSON_POLICY,
      project,
      scenario: makeScenario('bad-viewport', {
        pacing: FAST,
        scenes: [
          { id: 'one', pages: { a: { page: 'shop', open: '/shop.html' }, b: { page: 'console', open: '/console.html' } }, steps: [{ hold: 0.1 }] },
          { id: 'two', pages: { a: null, b: { viewport: 'mobile' } }, steps: [{ hold: 0.1 }] },
        ],
      }),
      mode: 'dry',
      runId: `bad-viewport-${Date.now()}`,
    });
    expect(twice.status).toBe('failed');
    expect(twice.error?.message).toMatch(/page "b" was filmed at 800×600 and is now asked at 390×844/);
  }, 120_000);
});

describe('multi-page scenes: the main capture and page URLs', () => {
  it('a capture that films no scene (all skipped) fails clearly, as before multi-page scenes: no frame was recorded', async () => {
    const r = await runScenario({
      policy: PERSON_POLICY,
      project: makeProject(dir, { shop: server.url, console: server.url }),
      scenario: makeScenario('all-skipped', {
        pacing: FAST,
        scenes: [
          { id: 'one', skip: true, open: '/shop.html', steps: [{ hold: 0.1 }] },
          { id: 'two', skip: true, pages: { a: { page: 'shop', open: '/shop.html' }, b: { page: 'console', open: '/console.html' } }, steps: [{ hold: 0.1 }] },
        ],
      }),
      mode: 'capture',
      runId: `all-skipped-${Date.now()}`,
    });
    // Nothing navigates, nothing paints: the L2.7 rule (a capture without a frame is a failed capture) applies.
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('the capture recorded no frame');
  }, 120_000);

  it('a relative `open` on a page id of `pages` resolves against its environment page (base path kept), like the page-level `open`', async () => {
    const r = await runScenario({
      policy: PERSON_POLICY,
      project: makeProject(dir, { shop: `${server.url}/app`, console: server.url }),
      scenario: makeScenario('base-path', {
        pacing: FAST,
        scenes: [
          {
            id: 'both',
            pages: { buyer: { open: 'shop:/shop.html' }, seller: { page: 'console', open: '/console.html' } },
            steps: [{ open: '/shop.html?again=1' }, { hold: 0.1 }],
          },
        ],
      }),
      mode: 'dry',
      runId: `base-path-${Date.now()}`,
    });
    expect(r.error?.message).toBeUndefined();
    const t = await readTimeline(r.timeline!);
    const urls = t.events.filter((e) => e.scene === 'both' && (e.action === 'scene_open' || e.action === 'open')).map((e) => [e.action, e.page, e.url]);
    expect(urls).toEqual([
      ['scene_open', 'buyer', `${server.url}/app/shop.html`],
      ['scene_open', 'seller', `${server.url}/console.html`],
      ['open', 'buyer', `${server.url}/app/shop.html?again=1`],
    ]);
  }, 120_000);
});
