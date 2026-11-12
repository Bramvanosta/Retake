/**
 * The CaptureRunner port's sessions, js-hook pages, recording window and site: the contract suite on the runner package
 * (a real Chromium on local test pages: a cookie sign-in app, a page to record, the brand-site fixture over the unsafe
 * test resolver — the browser cases skipped without Chromium, the site case without openssl) and on the in-memory
 * runner; then what only the in-memory one has (its calls, its scripted state, a sign-in that changes its check).
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE, PERSON_POLICY, resolveEnvironment, resolvePersonas } from '@retake/core';
import type { LoadedProject, RecordedEvent } from '@retake/core';
import { chromiumExecutable } from '@retake/runner-web';
import { runnerWebCapture } from '../src/index.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemoryHookPages, MemorySessions, memoryRecord, memorySite } from '../src/capture/memory-sessions.js';
import { ACCOUNTS, startAuthServer } from '../../runner-web/test/auth-server.js';
import type { AuthServer } from '../../runner-web/test/auth-server.js';
import { startServer } from '../../runner-web/test/helpers.js';
import type { TestServer } from '../../runner-web/test/helpers.js';
import { BRAND_SITE_COLORS, BRAND_SITE_URL, hasOpenssl, startBrandSite } from '../../runner-web/test/site-fixture.js';
import type { BrandSite } from '../../runner-web/test/site-fixture.js';
import { captureSessionsContract } from './capture-sessions-contract.js';
import type { ContractSessions } from './capture-sessions-contract.js';

const PASSWORD_ENV = 'RETAKE_CONTRACT_ADA_PASSWORD';
const hasChromium = chromiumExecutable().path !== null;
const root = await mkdtemp(join(tmpdir(), 'retake-capture-sessions-'));
const home = join(root, '.home');
let auth: AuthServer;
let rec: TestServer;
let site: BrandSite | undefined;
const saved = { home: process.env.RETAKE_HOME, pw: process.env[PASSWORD_ENV] };

beforeAll(async () => {
  process.env.RETAKE_HOME = home;
  process.env[PASSWORD_ENV] = ACCOUNTS.supplier.password;
  auth = await startAuthServer();
  rec = await startServer({
    '/rec.html': '<!doctype html><html><body><h1>Record</h1><button id="go">Go</button><p id="s"></p><script>go.onclick = () => (s.textContent = "went")</script></body></html>',
  });
  if (hasChromium && hasOpenssl()) site = await startBrandSite();
}, 60_000);

afterAll(async () => {
  await auth?.close();
  await rec?.close();
  await site?.close();
  await rm(root, { recursive: true, force: true });
  for (const [k, v] of [
    ['RETAKE_HOME', saved.home],
    [PASSWORD_ENV, saved.pw],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let n = 0;
/** A project of its own per case (its personas' files apart in the Retake home). */
async function projectOf(name: string): Promise<LoadedProject> {
  const slug = `contract-${name}-${n++}`;
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  return {
    slug,
    dir,
    root,
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: {
      name: 'Northfield',
      environments: { test: { app: auth.url, rec: `${rec.url}/rec.html` } },
      capture: { ...DEFAULT_CAPTURE, width: 1280, height: 720 },
      frame: 'card',
      template: 'default',
      auth: {
        login_url: '/sign-in',
        personas: {
          ada: {
            pages: ['app'],
            check: { url: 'app:/home', expect_text: ACCOUNTS.supplier.name },
            login: [
              { open: 'app:/sign-in' },
              { type: { into: { label: 'Email' }, text: ACCOUNTS.supplier.email } },
              { type: { into: { label: 'Password' }, text: `{{env:${PASSWORD_ENV}}}` } },
              { click: { role: 'button', name: 'Sign in' } },
              { wait_for: { text: ACCOUNTS.supplier.name, timeout: 5 } },
            ],
          },
          plain: { pages: ['app'] },
        },
      },
    },
  } as LoadedProject;
}

const personaOf = (p: LoadedProject) => (name: 'ada' | 'plain') => resolvePersonas(p, 'test', { home }).find((x) => x.name === name)!;

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** A pid that runs no process (a stale lock's). */
async function deadPid(): Promise<number> {
  for (let pid = 4_000_000; pid > 3_000_000; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no free pid found');
}

const ANSWER = 'return 6 * 7';

captureSessionsContract('runner package', async (name): Promise<ContractSessions> => {
  const project = await projectOf(name);
  return {
    runner: runnerWebCapture(),
    project,
    persona: personaOf(project),
    arrangeLock: async (dir, state) => {
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'SingletonLock');
      await rm(file, { force: true });
      if (state === 'stale') await symlink(`${hostname()}-${await deadPid()}`, file);
      if (state === 'live') await symlink(`${hostname()}-${process.pid}`, file);
    },
    arrangeStatus: writeJson,
    answer: ANSWER,
    record: {
      url: `${rec.url}/rec.html`,
      headless: true,
      windowSize: { width: 1000, height: 700 },
      drive: async (page) => {
        await page.getByRole('heading', { name: 'Record' }).waitFor();
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: 'Go' }).click();
        await page.getByText('went').waitFor();
        await page.waitForTimeout(300);
        await page.close();
      },
    },
    ...(site ? { site: { url: BRAND_SITE_URL, host: 'brand.test', testResolve: site.testResolve } } : {}),
    browser: hasChromium,
  };
});

/** The events of one press of Go, as the recorder writes them. */
const pressGo = (): RecordedEvent[] => [
  { seq: 0, t: 0, page: 'p1', path: '/rec.html', kind: 'navigation', cause: 'start', same_document: false, where: 'environment', page_key: 'rec' },
  { seq: 1, t: 900, page: 'p1', path: '/rec.html', kind: 'pointer', button: 'left', via: 'pointer', el: null, quiet_ms: 800, ms: 2 },
  { seq: 2, t: 1500, page: 'p1', path: '/rec.html', kind: 'stop', reason: 'closed' },
];

captureSessionsContract('memory', async (name): Promise<ContractSessions> => {
  const project = await projectOf(name);
  const sessions = new MemorySessions();
  return {
    runner: new MemoryCaptureRunner({
      sessions,
      hookPages: new MemoryHookPages({ evaluate: (code) => (code === ANSWER ? 42 : undefined), cookies: { ada: 'sid=0123456789abcdef' } }),
      record: memoryRecord({ events: pressGo() }),
      site: memorySite((o) => ({
        version: 1,
        url: o.url,
        host: o.host,
        at: '2026-11-11T10:00:00.000Z',
        status: 'ok',
        http_status: 200,
        redirects: 0,
        palette: { roles: { ...BRAND_SITE_COLORS }, swatches: [] },
        candidates: [],
        screenshot: null,
        network: { requests: 1, blocked: {}, tunnels: 1, bytes: 100, refused: {}, capped: 0 },
        warnings: [],
        untrusted: {},
      })),
    }),
    project,
    persona: personaOf(project),
    arrangeLock: async (dir, state) => {
      if (state === 'none') sessions.locks.delete(dir);
      else sessions.locks.set(dir, { state, pid: state === 'live' ? process.pid : 3_999_999, host: hostname() });
    },
    arrangeStatus: async (file, r) => void sessions.statuses.set(file, r),
    answer: ANSWER,
    record: { url: `${rec.url}/rec.html` },
    site: { url: BRAND_SITE_URL, host: 'brand.test', testResolve: new Map() },
    browser: true,
  };
});

describe('the in-memory sessions', () => {
  it('keeps every call; a sign-in becomes the check a later check sees; a scripted error is thrown as is', async () => {
    const project = await projectOf('memory-only');
    const persona = personaOf(project);
    const env = resolveEnvironment(project, 'test');
    const s = new MemorySessions({ checks: { ada: { status: 'expired', detail: 'app:/home landed on the sign-in page', ms: 0 } } });
    expect((await s.check({ project, policy: PERSON_POLICY, env, persona: persona('ada') })).status).toBe('expired');
    const r = await s.signIn({ project, policy: PERSON_POLICY, env, persona: persona('ada'), mode: 'auto' });
    expect(r.check.status).toBe('valid');
    expect((await s.check({ project, policy: PERSON_POLICY, env, persona: persona('ada') })).status).toBe('valid');
    expect(s.calls).toEqual([
      { member: 'check', persona: 'ada' },
      { member: 'signIn', persona: 'ada', mode: 'auto' },
      { member: 'check', persona: 'ada' },
    ]);
    const broken = new MemorySessions({ checks: { ada: new Error('its profile is open in another browser') } });
    await expect(broken.check({ project, policy: PERSON_POLICY, env, persona: persona('ada') })).rejects.toThrow('its profile is open in another browser');
  });

  it('a js hook tab that lands on the sign-in page is refused with the words the engine gives', async () => {
    const project = await projectOf('memory-landing');
    const env = resolveEnvironment(project, 'test');
    const pages = new MemoryHookPages({ landing: (page, _persona, url) => (page === 'app' ? `${url}/sign-in` : url) });
    const b = await pages.open({ policy: PERSON_POLICY, project, runId: 'r', log: () => undefined });
    const loginLanding = (key: string, url: string) => (url.endsWith('/sign-in') ? `js hook page "${key}" landed on the sign-in page` : null);
    await expect(pages.evalIn(b, { project, env, log: () => undefined, loginLanding }, 'app', 'return 1')).rejects.toThrow('js hook page "app" landed on the sign-in page');
    await expect(pages.evalIn(b, { project, env, log: () => undefined }, 'nope', 'return 1')).rejects.toThrow('has no page "nope"');
    await b.close();
    await expect(pages.evalIn(b, { project, env, log: () => undefined }, 'rec', 'return 1')).rejects.toMatchObject({ code: 'internal' });
  });
});
