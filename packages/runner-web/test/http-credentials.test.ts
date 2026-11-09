/**
 * Sign-in details in an environment page URL (`http://user:password@host/`): the run opens the page without them and
 * the browser answers that origin's authentication challenge with them — never another origin's (another port of
 * localhost asks too, from a fetch of the page, and is not answered). They appear nowhere the run writes (run.json, timeline.json,
 * log.jsonl, the progress events). The sign-in and recording windows get them too. Pages on two origins with details
 * are refused before any browser opens.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { resolveEnvironment, resolvePersonas, PERSON_POLICY } from '@retake/core';
import { recordSession, runScenario, signIn } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';
import { retakeHome } from '@retake/core/io';

const USER = 'demo-viewer';
const PASSWORD = 'staging-pass-8317';
const BASIC = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

interface Srv {
  url: string;
  port: number;
  /** The Authorization header of each request ('' when none). */
  auth: string[];
  close: () => Promise<void>;
}

async function serve(port: number, handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<Srv> {
  const auth: string[] = [];
  const srv = createServer((req, res) => {
    auth.push(req.headers.authorization ?? '');
    handle(req, res);
  });
  await new Promise<void>((ok) => srv.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${port}`, port, auth, close: () => new Promise((ok) => srv.close(() => ok())) };
}

const challenge = (res: ServerResponse, cors?: string) => {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="staging"', 'content-type': 'text/plain', ...(cors ? { 'access-control-allow-origin': cors, 'access-control-allow-credentials': 'true' } : {}) });
  res.end('sign in');
};

/** Every file under `dir` (text read as UTF-8). */
async function filesUnder(dir: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...(await filesUnder(p)));
    else out.push({ path: p, text: await readFile(p, 'utf8') });
  }
  return out;
}

describe('an environment page URL with sign-in details', () => {
  let app: Srv;
  let other: Srv;
  let dir: string;

  beforeAll(async () => {
    // Ports 4972–4973. Another origin that asks for HTTP sign-in too: the page calls it with its credentials included.
    other = await serve(4973, (_req, res) => challenge(res, 'http://127.0.0.1:4972'));
    app = await serve(4972, (req, res) => {
      if (req.headers.authorization !== BASIC) return challenge(res);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Staging</title><h1>Signed in to staging</h1><script>fetch(${JSON.stringify(`${other.url}/api`)}, { credentials: 'include' })</script>`);
    });
    dir = await tempDir('rw-credentials-');
  }, 30_000);

  afterAll(async () => {
    await Promise.all([app?.close(), other?.close()]);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('opens the page, signed in to its origin only; the details are nowhere in what the run writes', async () => {
    const project = makeProject(dir, { app: `http://${USER}:${PASSWORD}@127.0.0.1:${app.port}`, other: other.url });
    const events: unknown[] = [];
    const rec = await runScenario({ policy: PERSON_POLICY,
      project,
      scenario: makeScenario('staging', { pacing: FAST, scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ wait_for: { text: 'Signed in to staging' } }, { wait: 0.8 }] as never }] }),
      mode: 'dry',
      runId: `staging-${Date.now()}`,
      onProgress: (e) => events.push(e),
    });
    expect(rec.status, JSON.stringify(rec.error)).toBe('succeeded');
    // The browser answered the page's challenge with them; the other origin's challenge (its iframe) got nothing.
    expect(app.auth).toContain(BASIC);
    expect(other.auth.length).toBeGreaterThan(0);
    expect(other.auth.filter((a) => a !== '')).toEqual([]);
    const tl = await readTimeline(rec.timeline!);
    expect(tl.pages.map((p) => p.url)).toEqual([`${app.url}/`]);
    const written = [...(await filesUnder(rec.dir)).filter((f) => !/\.(png|jpe?g|webm|mp4)$/.test(f.path)), { path: 'progress', text: JSON.stringify(events) }];
    expect(written.length).toBeGreaterThan(2);
    for (const f of written) {
      expect(f.text, f.path).not.toContain(PASSWORD);
      expect(f.text, f.path).not.toContain(`${USER}:`);
      expect(f.text, f.path).not.toContain(`${USER}@`);
    }
  }, 120_000);

  it('the sign-in window, the automatic sign-in and the recording window open the page signed in to its origin too', async () => {
    const project = makeProject(dir, { app: `http://${USER}:${PASSWORD}@127.0.0.1:${app.port}` });
    const env = resolveEnvironment(project, 'test');
    expect(env.pages.app).toBe(app.url);
    const seen: string[] = [];
    const read = async (page: Page) => {
      await page.waitForSelector('h1', { timeout: 15_000 });
      seen.push((await page.textContent('h1')) ?? '');
      await page.close();
    };
    const eventsFile = join(dir, 'events.jsonl');
    await writeFile(eventsFile, '');
    await recordSession({ policy: PERSON_POLICY, project, env, url: `${app.url}/`, eventsFile, headless: true, windowSize: { width: 800, height: 600 }, drive: read });
    const home = await tempDir('rw-credentials-home-');
    const saved = process.env.RETAKE_HOME;
    process.env.RETAKE_HOME = home;
    try {
      project.config.auth = { login_url: '/', personas: { viewer: { pages: ['app'] } } };
      const persona = resolvePersonas(project, 'test', { home: retakeHome() }).find((p) => p.name === 'viewer')!;
      await signIn({ policy: PERSON_POLICY, project, env, persona, mode: 'headed', headless: true, drive: read }).catch(() => undefined);
      // The automatic sign-in's browser (its check of the page, headless) gets them too.
      project.config.auth = { login_url: '/sign-in', personas: { viewer: { pages: ['app'], check: { url: 'app:/', expect_text: 'Signed in to staging' }, login: [{ open: 'app:/' }] } } };
      const checked = resolvePersonas(project, 'test', { home: retakeHome() }).find((p) => p.name === 'viewer')!;
      expect((await signIn({ policy: PERSON_POLICY, project, env, persona: checked, mode: 'auto' })).check.status).toBe('valid');
    } finally {
      process.env.RETAKE_HOME = saved;
      await rm(home, { recursive: true, force: true });
    }
    expect(seen).toEqual(['Signed in to staging', 'Signed in to staging']);
  }, 120_000);

  it('details on two origins are refused before any browser opens, without showing them', async () => {
    const project = makeProject(dir, { app: `http://${USER}:${PASSWORD}@127.0.0.1:${app.port}`, other: `http://other-user:other-pass@127.0.0.1:${other.port}` });
    const before = app.auth.length + other.auth.length;
    const rec = await runScenario({ policy: PERSON_POLICY,
      project,
      scenario: makeScenario('two', { pacing: FAST, scenes: [{ id: 'home', page: 'app', open: '/', steps: [{ wait: 0.1 }] as never }] }),
      mode: 'dry',
      runId: `two-${Date.now()}`,
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(/environment test has sign-in details \(`user:password@`\) in page URLs of 2 origins .*sign in to the others with a persona/);
    expect(rec.error?.message).not.toMatch(new RegExp(`${PASSWORD}|other-pass`));
    expect(app.auth.length + other.auth.length).toBe(before);
  }, 60_000);
});
