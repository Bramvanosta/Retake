/**
 * The render bundle's Response.blob() workaround (src/remotion/response-blob.ts) in the render browser: Playwright's
 * Chromium headless shell, in a context with no disk (its blobs cannot be paged, as on a nearly full disk).
 * Chrome for Testing 159 keeps every large body read with Response.blob() until the page closes, so the fetch after
 * 2 GB of them fails ("Failed to fetch"). Remotion's OffthreadVideo reads every frame that way: a render on a busy
 * disk failed with nothing written. With the workaround, 2.5 GB of bodies read, made object URLs and revoked go
 * through. Without it (the mutation check), Chrome 159 fails at about the 64th 32 MB body.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { playwrightHeadlessShell } from '../src/render/browser.js';
import { installResponseBlobWorkaround } from '../src/remotion/response-blob.js';

const SHELL = playwrightHeadlessShell();
const BODY = Buffer.alloc(32 * 1024 * 1024, 7);
const COUNT = 80;

let server: Server;
let port = 0;
let browser: Browser;

describe.skipIf(!SHELL)('the Response.blob() workaround in the render browser (no disk for blobs)', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/body')) {
        res.writeHead(200, { 'content-type': 'image/bmp', 'content-length': BODY.length, 'cache-control': 'no-store' });
        res.end(BODY);
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>blobs</title>');
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as { port: number }).port;
    browser = await chromium.launch({ executablePath: SHELL!, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((ok) => server?.close(ok));
  });

  it('reads 2.5 GB of large bodies as the frames of a render are read, none kept', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    // As the bundle runs it (esbuild may name functions with __name).
    await page.evaluate(`(() => { var __name = (f) => f; (${installResponseBlobWorkaround.toString()})(); })()`);
    const result = await page.evaluate(async (count) => {
      for (let i = 0; i < count; i++) {
        try {
          // OffthreadVideo's read of a frame: the body as a Blob, an object URL for an <img>, revoked after.
          const res = await fetch(`/body?${i}`, { cache: 'no-store' });
          const blob = await res.blob();
          if (blob.size !== 32 * 1024 * 1024 || blob.type !== 'image/bmp') return `body ${i}: ${blob.size} B, ${blob.type}`;
          URL.revokeObjectURL(URL.createObjectURL(blob));
        } catch (e) {
          return `body ${i}: ${String(e)}`;
        }
      }
      return 'ok';
    }, COUNT);
    expect(result).toBe('ok');
    await page.context().close();
  }, 120_000);
});
