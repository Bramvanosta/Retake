/**
 * The per-page in-flight request tracker behind `wait_for: {network_idle}` and the login steps' idle wait (network.ts),
 * on a real session: a request whose document went away without Playwright reporting its end is forgotten when the
 * frame commits its new document — a cross-site navigation (127.0.0.1 → localhost: the renderer is swapped) and a
 * dedicated worker's request across a same-origin navigation —, while a same-document change (pushState) and the new
 * document's own requests are still waited for.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { kitConfigFor, openSession } from '../src/index.js';
import type { BrowserSession } from '../src/index.js';
import { UNREAD_BODY_MS, networkIdle } from '../src/network.js';
import { startServer } from './helpers.js';
import type { TestServer } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';

const html = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Network</title></head><body>${body}</body></html>`;
/**
 * Polls /api every 300 ms (each answer takes 1.5 s: requests are always in flight). The bodies are read: an unread
 * `no-store` body (the test server's) is never reported as finished.
 */
const POLL = `setInterval(() => fetch('/api?' + Math.random()).then((r) => r.text()).catch(() => {}), 300)`;

let server: TestServer;
let session: BrowserSession;

beforeAll(async () => {
  server = await startServer({
    '/api': { body: 'ok', type: 'text/plain', delay_ms: 1500 },
    '/slow.png': { body: '', type: 'image/png', delay_ms: 1200 },
    '/w.js': { body: POLL, type: 'text/javascript' },
    // The sign-in link goes to the same server under another site name (localhost), as an identity provider would.
    '/app': { body: (h) => html(`<a id="away" href="http://${String(h.host).replace('127.0.0.1', 'localhost')}/login">Sign in</a><script>${POLL}</script>`) },
    '/worker': html(`<a id="next" href="/next">Next</a><script>new Worker('/w.js')</script>`),
    '/spa': html(`<button id="route" onclick="fetch('/api').then((r) => r.text()); history.pushState({}, '', '/spa/next')">Route</button>`),
    '/heavy': html(`<img src="/slow.png">`),
    '/track': { body: '{}', type: 'application/json' },
    '/fire': html(`<button id="send" onclick="fetch('/track?' + Math.random())">Send</button>`),
    '/login': html('<h1>Sign in</h1>'),
    '/next': html('<h1>Next</h1>'),
  });
  session = await openSession({ policy: PERSON_POLICY, width: 800, height: 600, scale: 1, kit: kitConfigFor(undefined, { style: 'debug' }) });
});

afterAll(async () => {
  await session?.close();
  await server?.close();
});

async function timedIdle(page: Page, timeoutMs = 3000) {
  const t0 = Date.now();
  const res = await networkIdle(page, { timeoutMs });
  return { res, ms: Date.now() - t0 };
}

describe('network idle across documents (R-ACT-21)', () => {
  it("forgets the previous site's requests after a cross-site navigation (127.0.0.1 → localhost)", async () => {
    const page = await session.context.newPage();
    try {
      await page.goto(`${server.url}/app`);
      await page.waitForTimeout(700); // a poll or two in flight
      await page.click('#away');
      await page.waitForURL(/localhost:\d+\/login/);
      const { res, ms } = await timedIdle(page);
      expect(res).toEqual({ idle: true });
      expect(ms).toBeLessThan(1500); // not the 1.5 s of a poll answer: the old renderer's polls are not waited for
    } finally {
      await page.close();
    }
  });

  it("forgets a dedicated worker's request when the page navigates, even on the same origin", async () => {
    const page = await session.context.newPage();
    try {
      await page.goto(`${server.url}/worker`);
      await page.waitForTimeout(700);
      await page.click('#next');
      await page.waitForURL(/\/next$/);
      const { res, ms } = await timedIdle(page);
      expect(res).toEqual({ idle: true });
      expect(ms).toBeLessThan(1500);
    } finally {
      await page.close();
    }
  });

  it('does not wait forever for a response body nobody reads (a fire-and-forget fetch of a no-store answer)', async () => {
    const page = await session.context.newPage();
    try {
      await page.goto(`${server.url}/fire`);
      await page.click('#send'); // answered at once; the page never reads the body: Chromium never ends the request
      const { res, ms } = await timedIdle(page, 4000);
      expect(res).toEqual({ idle: true });
      expect(ms).toBeGreaterThanOrEqual(UNREAD_BODY_MS); // still counted until then
      expect(ms).toBeLessThan(UNREAD_BODY_MS + 1500);
    } finally {
      await page.close();
    }
  });

  it('still waits for a request started with a pushState, and for the new document’s own requests', async () => {
    const page = await session.context.newPage();
    try {
      await page.goto(`${server.url}/spa`);
      await page.waitForTimeout(600);
      await page.click('#route'); // fetch /api (1.5 s), then a same-document navigation
      let { res, ms } = await timedIdle(page);
      expect(res).toEqual({ idle: true });
      expect(ms).toBeGreaterThanOrEqual(1500);
      await page.goto(`${server.url}/heavy`, { waitUntil: 'commit' });
      ({ res, ms } = await timedIdle(page));
      expect(res).toEqual({ idle: true });
      expect(ms).toBeGreaterThanOrEqual(1000); // the image answers 1.2 s after its request
    } finally {
      await page.close();
    }
  });
});
