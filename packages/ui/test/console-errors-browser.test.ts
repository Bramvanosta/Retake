/**
 * console-errors.ts in headless Chromium against a real player origin (src/server/player.ts, a stub bundle whose first
 * script fetches a registered font when the page asks): ⚑ a live preview frame's font refused (its capability
 * released) is the CORS error Chrome reports and it counts, before and after the frame leaves the page; the Studio
 * page logs every iframe that joins or leaves it — added, its src changed, removed with its box — with its src, on
 * the browser clock that console messages carry (what the rule compares).
 */
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPlayerServer } from '../src/server/player.js';
import type { PlayerServer } from '../src/server/player.js';
import type { PlayerBundle } from '../src/player/bundle-player.js';
import { REPO } from '@retake/test-support/repo';
import { ConsoleErrors } from './console-errors.js';

// The frame's first script: on the page's message, load the font named by the frame URL's hash (an /m/ path).
const BOOT = `addEventListener('message', (e) => {
  if (e.data && e.data.font) new FontFace('T', 'url("' + e.data.font + '")').load().then(() => parent.postMessage('loaded', '*'), () => parent.postMessage('refused', '*'));
});
parent.postMessage('ready', '*');`;
const BUNDLE: PlayerBundle = { hash: '0123456789abcdef', js: Buffer.from('/* the frame bundle */'), boot: Buffer.from(BOOT), components: [], excluded: [], held: [], ms: 0 };

let root: string;
let studio: Server;
let player: PlayerServer;
let browser: Browser;
let page: Page;
let errors: ConsoleErrors;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ds-console-errors-'));
  await mkdir(join(root, 'theme'));
  await copyFile(join(REPO, 'templates', 'editorial', 'fonts', 'Inter-Regular.ttf'), join(root, 'theme', 'Face.ttf'));
  // The Studio page stand-in: an empty page of its own origin (the one the frame's frame-ancestors names).
  studio = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><body></body>');
  });
  await new Promise<void>((ok) => studio.listen(0, '127.0.0.1', ok));
  const studioPort = (studio.address() as { port: number }).port;
  player = await startPlayerServer({ studioPort, bundle: async () => BUNDLE });
  const executablePath = process.env.RETAKE_CHROMIUM;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chromium' }) });
  const context = await browser.newContext();
  errors = new ConsoleErrors();
  await errors.watch(context);
  page = await context.newPage();
  page.on('console', (m) => errors.add(m));
  await page.goto(`http://127.0.0.1:${studioPort}/`);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await player?.close();
  await new Promise<void>((ok) => (studio ? studio.close(() => ok()) : ok()));
  if (root) await rm(root, { recursive: true, force: true });
});

/** Frame `src` in the page (sandboxed as the Studio frames it, inside a box); resolves once its first script runs. */
async function addFrame(src: string): Promise<void> {
  await page.evaluate(
    (s) =>
      new Promise<void>((ok) => {
        const box = document.createElement('div');
        const f = document.createElement('iframe');
        f.sandbox.add('allow-scripts');
        f.src = s;
        addEventListener('message', function ready(e) {
          if (e.source === f.contentWindow && e.data === 'ready') {
            removeEventListener('message', ready);
            ok();
          }
        });
        box.append(f);
        document.body.append(box);
      }),
    src,
  );
}

/** Ask the page's only frame to load `font`: 'loaded' or 'refused'. */
const loadFont = (font: string) =>
  page.evaluate(
    (u) =>
      new Promise<string>((ok) => {
        const f = document.querySelector('iframe')!;
        addEventListener('message', function done(e) {
          if (e.source === f.contentWindow && (e.data === 'loaded' || e.data === 'refused')) {
            removeEventListener('message', done);
            ok(e.data as string);
          }
        });
        f.contentWindow!.postMessage({ font: u }, '*');
      }),
    font,
  );

describe('console-errors in Chromium', () => {
  it("⚑ a live frame's font refused (its capability released) is a CORS error that counts — before and after the frame leaves", async () => {
    const font = player.register(join(root, 'theme', 'Face.ttf'), [join(root, 'theme')], 'live')!;
    const src = player.frameUrl('live');
    await addFrame(src);
    expect(await loadFont(font)).toBe('loaded');
    expect(errors.list()).toEqual([]);
    const before = Date.now();
    player.release('live');
    expect(await loadFont(font.replace('Face.ttf', 'Face.ttf?again'))).toBe('refused');
    await expect.poll(() => errors.list().length).toBe(1);
    const [error] = errors.list();
    expect(error).toMatch(
      /^Access to font at 'http:\/\/127\.0\.0\.1:\d+\/m\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{22}\/Face\.ttf\?again' from origin 'null' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header/,
    );
    // The frame leaves the page after the error: it still counts.
    const moved = () => errors.frameMoves().map((m) => `${m.move} ${m.src}`);
    await page.evaluate(() => document.querySelector('iframe')!.remove());
    await expect.poll(moved).toEqual([`in ${src}`, `out ${src}`]);
    expect(errors.list()).toEqual([error]);
    // The browser clock on both sides: the error's time and the departure's are both this run's (ms since the epoch).
    const [seen] = errors.seen();
    const [joined, left] = errors.frameMoves();
    expect(joined.at).toBeLessThanOrEqual(seen.at);
    expect(seen.at).toBeGreaterThanOrEqual(before - 1000);
    expect(left.at).toBeGreaterThanOrEqual(seen.at);
    expect(left.at).toBeLessThanOrEqual(Date.now() + 1000);
  }, 60_000);

  it('the Studio page logs the iframes that join and leave it, with their src: added, src changed, removed with its box', async () => {
    const first = player.frameUrl('one');
    const second = player.frameUrl('two');
    const moved = () => errors.frameMoves().map((m) => `${m.move} ${m.src}`);
    const before = moved().length;
    await addFrame(first);
    await expect.poll(() => moved().slice(before)).toEqual([`in ${first}`]);
    await page.evaluate((s) => document.querySelector('iframe')!.setAttribute('src', s), second);
    await expect.poll(() => moved().slice(before)).toEqual([`in ${first}`, `out ${first}`, `in ${second}`]);
    // Removed with the element that holds it (a screen leaving removes its subtree).
    await page.evaluate(() => document.querySelector('iframe')!.parentElement!.remove());
    await expect.poll(() => moved().slice(before)).toEqual([`in ${first}`, `out ${first}`, `in ${second}`, `out ${second}`]);
    // Other capabilities leaving excuse nothing: the live frame's error still counts.
    expect(errors.list()).toEqual(errors.seen().map((e) => e.text));
    expect(errors.list()).toHaveLength(1);
  });
});
