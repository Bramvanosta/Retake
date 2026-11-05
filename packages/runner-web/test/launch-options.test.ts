/**
 * Every browser the runner launches runs with Chromium's OS sandbox and site isolation on (src/launch.ts): a source scan
 * keeps each launch on launchOptions and refuseUnsandboxed; each launch site, launched for real, reports a command line
 * without a switch that turns them off and puts a cross-site iframe in a process of its own (the headless shell
 * included, which leaves site isolation off unless asked); each one refuses a browser whose executable adds
 * --no-sandbox itself; on macOS (RETAKE_TEST_SLOW, python3) the kernel confirms the renderer and GPU processes are
 * sandboxed. The sign-in and recording windows are launched headless here (same launch site, same options).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { resolveEnvironment, resolvePersonas, sandboxOffArgProblem, useAgentPolicy } from '@retake/core';
import {
  ArtefactRenderer,
  RunnerError,
  extractSite,
  kitConfigFor,
  launchOptions,
  launchTarget,
  openSession,
  probeChromium,
  recordSession,
  renderCursorAtlas,
  signIn,
} from '../src/index.js';
import { startAuthServer } from './auth-server.js';
import type { AuthServer } from './auth-server.js';
import { makeProject, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';
import { BRAND_SITE_URL, hasOpenssl, startBrandSite } from './site-fixture.js';
import type { BrandSite } from './site-fixture.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sourceFiles(p) : n.endsWith('.ts') ? [p] : [];
  });
}

/** Where the bracket at `open` closes (strings, template literals and comments skipped). */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced brackets');
}

describe('every runner launch goes through launchOptions (source scan)', () => {
  it('each launch / launchPersistentContext / launchServer call ends its options with ...launchOptions(…); nothing else sets chromiumSandbox', () => {
    const calls: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const at = relative(SRC, file);
      if (at !== 'launch.ts') expect(text, `${at} sets chromiumSandbox itself`).not.toMatch(/chromiumSandbox|ignoreDefaultArgs/);
      for (const m of text.matchAll(/\.(launch|launchPersistentContext|launchServer)\s*\(/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        const open = m.index + m[0].length - 1;
        const args = text.slice(open + 1, closing(text, open));
        calls.push(`${at}:${m[1]}`);
        expect(m[1], `${at}:${line} uses ${m[1]}`).not.toBe('launchServer');
        // The helper's spread is the options object's last entry: nothing after it can put the sandbox back off.
        const spread = args.lastIndexOf('...launchOptions(');
        expect(spread, `${at}:${line} does not spread ...launchOptions(…) into its launch options`).toBeGreaterThan(-1);
        const rest = args.slice(closing(args, spread + '...launchOptions'.length) + 1);
        expect(rest, `${at}:${line}: ...launchOptions(…) is not the last entry of its launch options`).toMatch(/^\s*,?\s*\}\s*$/);
        // Every launch but the doctor's probe (which reports the sandbox instead) refuses an unsandboxed browser right after.
        if (at !== 'probe.ts') {
          const after = text.slice(closing(text, open) + 1, closing(text, open) + 1200);
          expect(after, `${at}:${line} does not call refuseUnsandboxed(…) right after its launch`).toMatch(/^[\s\S]{0,900}?await refuseUnsandboxed\(/);
        }
      }
    }
    // The seven launch sites (a new one is scanned too: this list only proves the scan finds them).
    expect(calls.sort()).toEqual(
      [
        'artefacts/render.ts:launch',
        'login.ts:launchPersistentContext',
        'probe.ts:launch',
        'raw/layer.ts:launch',
        'record-session.ts:launchPersistentContext',
        'session.ts:launchPersistentContext',
        'site/extract.ts:launch',
      ].sort(),
    );
  });

  it('launchOptions turns the sandbox on, asks for site isolation, and refuses a switch that turns either off', () => {
    expect(launchOptions({ args: ['--hide-scrollbars'] })).toEqual({ chromiumSandbox: true, args: ['--hide-scrollbars', '--site-per-process'] });
    expect(launchOptions({ args: ['--site-per-process', '--hide-scrollbars'] }).args).toEqual(['--site-per-process', '--hide-scrollbars']);
    expect(() => launchOptions({ args: ['--remote-debugging-port=9222'] })).toThrow(/Chromium was not launched: --remote-debugging-port opens a debugging port/);
    expect(() => launchOptions({ args: ['--hide-scrollbars', '--no-sandbox'] })).toThrow(RunnerError);
    expect(() => launchOptions({ args: ['--disable-features=Translate,IsolateOrigins'] })).toThrow(/Chromium was not launched: --disable-features=IsolateOrigins turns Chromium's site isolation off/);
  });

  it('under the agent policy (a job of the worker): no argument that is not a switch, none that loads code or files, no executable inside the workspace', () => {
    const ws = '/ws-of-an-agent';
    const args = ['--hide-scrollbars', 'https://example.com/', '--user-data-dir=/tmp/p', '--proxy-server=http://127.0.0.1:1'];
    expect(launchOptions({ args }).args).toEqual([...args, '--site-per-process']);
    expect(launchTarget({ executable: `${ws}/bin/chrome` })).toEqual({ executablePath: `${ws}/bin/chrome`, channel: undefined });
    useAgentPolicy([ws]);
    try {
      expect(() => launchOptions({ args })).toThrow(/^Chromium was not launched: "https:\/\/example\.com\/" is not a switch .*; --user-data-dir opens the browser on a profile folder/);
      expect(launchOptions({ args: ['--hide-scrollbars', '--proxy-server=http://127.0.0.1:1'] }).args).toContain('--proxy-server=http://127.0.0.1:1');
      expect(() => launchTarget({ executable: `${ws}/bin/chrome` })).toThrow(/^Chromium was not launched: browser\.executable \(\/ws-of-an-agent\/bin\/chrome\) lies inside the workspace/);
      expect(() => launchTarget({ executable: 'bin/chrome' })).toThrow(/browser\.executable \(bin\/chrome\) is a relative path/);
      expect(launchTarget({ executable: '/opt/chromium/chrome' }).executablePath).toBe('/opt/chromium/chrome');
      expect(launchTarget({})).toEqual({ executablePath: process.env.RETAKE_CHROMIUM, channel: process.env.RETAKE_CHROMIUM ? undefined : 'chromium' });
    } finally {
      useAgentPolicy(null);
    }
  });
});

/** The command line of every browser launched while `site` is set, as the browser reports it, and whether it isolates sites. */
const launched: Array<{ site: string; argv: string[]; isolated: boolean }> = [];
let site = '';

/** Hosts of two sites, served by a route of the page itself (no server, no DNS: the extraction's browser too). */
const SITE_A = 'http://page.site-a.test/';
const SITE_B = 'http://frame.site-b.test/frame';

/**
 * Does `browser` give a cross-site iframe a process of its own? A page of `open` loads SITE_A, whose iframe is on
 * SITE_B: with site isolation the frame is a target of its own (CDP Target.getTargets, type iframe). The page is closed.
 */
async function isolatesSites(browser: Browser, open: () => Promise<Page>): Promise<boolean> {
  const page = await open();
  try {
    await page.route('**/*', (r) =>
      r.request().url().startsWith(SITE_A) ? r.fulfill({ contentType: 'text/html', body: `<iframe src="${SITE_B}"></iframe>` }) : r.fulfill({ contentType: 'text/html', body: '<p>frame</p>' }),
    );
    await page.goto(SITE_A);
    await page.waitForFunction(() => document.querySelector('iframe') !== null);
    for (let i = 0; i < 40 && page.frames().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await page.frames()[1]?.waitForLoadState().catch(() => undefined);
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = (await cdp.send('Target.getTargets')) as { targetInfos: Array<{ type: string; url: string }> };
    await cdp.detach();
    return targetInfos.some((t) => t.type === 'iframe' && t.url === SITE_B);
  } finally {
    await page.close();
  }
}

async function note(browser: Browser | null, open: () => Promise<Page>): Promise<void> {
  if (!browser) throw new Error('a launch without a browser');
  const cdp = await browser.newBrowserCDPSession();
  const { arguments: argv } = (await cdp.send('Browser.getBrowserCommandLine')) as { arguments: string[] };
  await cdp.detach();
  launched.push({ site, argv, isolated: await isolatesSites(browser, open) });
}

/** The switches of `site`'s browser that turn the sandbox or site isolation off (none expected), its argv, and whether every browser of it isolated sites. */
function commandLineOf(name: string): { argv: string[]; off: string[]; isolated: boolean } {
  const seen = launched.filter((l) => l.site === name);
  expect(seen.length, `${name} launched no browser`).toBeGreaterThan(0);
  const argv = seen.flatMap((l) => l.argv);
  return { argv, off: argv.filter((a) => sandboxOffArgProblem(a) !== null), isolated: seen.every((l) => l.isolated) };
}

describe('each launch site, launched for real: no switch turns the sandbox or site isolation off; a cross-site iframe is a process of its own', () => {
  let dir: string;
  let app: TestServer;
  let auth: AuthServer;

  beforeAll(async () => {
    const launch = chromium.launch.bind(chromium);
    const persistent = chromium.launchPersistentContext.bind(chromium);
    vi.spyOn(chromium, 'launch').mockImplementation(async (o) => {
      const b = await launch(o);
      await note(b, async () => (await b.newContext()).newPage());
      return b;
    });
    vi.spyOn(chromium, 'launchPersistentContext').mockImplementation(async (d, o) => {
      const c: BrowserContext = await persistent(d, o);
      await note(c.browser(), () => c.newPage());
      return c;
    });
    dir = await tempDir('rw-launch-');
    app = await startServer({ '/': '<!doctype html><title>App</title><h1>Orders</h1>' });
    auth = await startAuthServer();
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    await auth?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the capture session (persistent profile, new headless)', async () => {
    site = 'session';
    const session = await openSession({ width: 640, height: 400, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('main');
      await page.goto(`${app.url}/`);
      expect(await page.title()).toBe('App');
    } finally {
      await session.close();
    }
    const { argv, off, isolated } = commandLineOf('session');
    expect(off).toEqual([]);
    expect(isolated).toBe(true);
    expect(argv).toContain('--disable-renderer-backgrounding');
  }, 60_000);

  it('the capture session on the headless shell (browser.channel: headless-shell), which isolates sites only when asked', async () => {
    site = 'shell';
    const session = await openSession({ width: 640, height: 400, scale: 1, kit: kitConfigFor(undefined), browser: { channel: 'headless-shell' } });
    try {
      const page = await session.page('main');
      await page.goto(`${app.url}/`);
      expect(await page.title()).toBe('App');
    } finally {
      await session.close();
    }
    const { argv, off, isolated } = commandLineOf('shell');
    expect(off).toEqual([]);
    expect(argv).toContain('--site-per-process');
    expect(isolated).toBe(true);
  }, 60_000);

  it("the doctor's probe, which also reads the sandbox from the command line", async () => {
    site = 'probe';
    const probe = await probeChromium();
    expect(probe.launched, probe.error).toBe(true);
    expect(probe.sandbox).toEqual({ on: true, off: [] });
    expect(commandLineOf('probe').off).toEqual([]);
    expect(commandLineOf('probe').isolated).toBe(true);
  }, 60_000);

  it('the probe reads what the browser was really started with: a wrapper executable that adds --no-sandbox is seen', async () => {
    site = 'wrapper';
    const wrapper = join(dir, 'chromium-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(chromium.executablePath())} --no-sandbox "$@"\n`, { mode: 0o755 });
    const saved = process.env.RETAKE_CHROMIUM;
    process.env.RETAKE_CHROMIUM = wrapper;
    try {
      const probe = await probeChromium();
      expect(probe.launched, probe.error).toBe(true);
      expect(probe.source).toBe('RETAKE_CHROMIUM');
      expect(probe.sandbox).toEqual({ on: false, off: ['--no-sandbox'] });
    } finally {
      if (saved === undefined) delete process.env.RETAKE_CHROMIUM;
      else process.env.RETAKE_CHROMIUM = saved;
    }
  }, 60_000);

  it('the artefact renderer', async () => {
    site = 'artefacts';
    const r = new ArtefactRenderer();
    try {
      await r.email('<!doctype html><p>Your quote is ready.</p>', join(dir, 'mail.png'));
    } finally {
      await r.close();
    }
    const { argv, off, isolated } = commandLineOf('artefacts');
    expect(off).toEqual([]);
    expect(isolated).toBe(true);
    expect(argv).toContain('--hide-scrollbars');
  }, 60_000);

  it("the raw layer's cursor atlas", async () => {
    site = 'atlas';
    const atlas = await renderCursorAtlas({ kit: kitConfigFor(undefined), scale: 1 });
    expect(atlas.ripple.length).toBeGreaterThan(0);
    expect(commandLineOf('atlas').off).toEqual([]);
    expect(commandLineOf('atlas').isolated).toBe(true);
  }, 60_000);

  it.skipIf(!hasOpenssl())('the site extraction (behind its proxy)', async () => {
    site = 'extract';
    let brand: BrandSite | undefined;
    try {
      brand = await startBrandSite();
      const out = await tempDir('rw-launch-site-');
      const r = await extractSite({ url: BRAND_SITE_URL, host: 'brand.test', outDir: out, testResolve: brand.testResolve });
      expect(r.status, JSON.stringify(r.untrusted)).toBe('ok');
    } finally {
      await brand?.close();
    }
    const { argv, off, isolated } = commandLineOf('extract');
    expect(off).toEqual([]);
    expect(isolated).toBe(true);
    expect(argv.some((a) => a.startsWith('--proxy-server=http://127.0.0.1:'))).toBe(true);
  }, 120_000);

  it('the sign-in window (headless here)', async () => {
    site = 'login';
    const home = await tempDir('rw-launch-home-');
    const saved = process.env.RETAKE_HOME;
    process.env.RETAKE_HOME = home;
    try {
      const project = makeProject(await tempDir('rw-launch-login-'), { app: auth.url });
      project.config.auth = { login_url: '/sign-in', personas: { supplier: { pages: ['app'] } } };
      const persona = resolvePersonas(project, 'test').find((p) => p.name === 'supplier')!;
      await signIn({ project, env: { name: 'test', pages: { app: auth.url } }, persona, mode: 'headed', headless: true, drive: async (page) => void (await page.close()) }).catch(() => undefined);
    } finally {
      process.env.RETAKE_HOME = saved;
      await rm(home, { recursive: true, force: true });
    }
    expect(commandLineOf('login').off).toEqual([]);
    expect(commandLineOf('login').isolated).toBe(true);
  }, 60_000);

  it('the recording window (headless here)', async () => {
    site = 'record';
    const project = makeProject(await tempDir('rw-launch-record-'), { app: app.url });
    const eventsFile = join(dir, 'events.jsonl');
    await writeFile(eventsFile, '');
    await recordSession({
      project,
      env: resolveEnvironment(project, 'test'),
      url: `${app.url}/`,
      eventsFile,
      headless: true,
      windowSize: { width: 800, height: 600 },
      drive: async (page) => {
        await page.waitForLoadState('domcontentloaded');
        await page.close();
      },
    });
    const { argv, off, isolated } = commandLineOf('record');
    expect(off).toEqual([]);
    expect(isolated).toBe(true);
    expect(argv).toContain('--window-size=800,600');
  }, 60_000);
});

describe('each launch site refuses a browser whose own command line turns the sandbox off (an executable that adds --no-sandbox)', () => {
  let dir: string;
  let app: TestServer;
  let auth: AuthServer;
  let saved: string | undefined;
  const REFUSED = /was refused: it runs with --no-sandbox on its command line .*use one that starts Chromium as it is given/;

  beforeAll(async () => {
    dir = await tempDir('rw-launch-wrap-');
    const wrapper = join(dir, 'chromium-wrapper.sh');
    await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(chromium.executablePath())} --no-sandbox "$@"\n`, { mode: 0o755 });
    app = await startServer({ '/': '<!doctype html><title>App</title><h1>Orders</h1>' });
    auth = await startAuthServer();
    saved = process.env.RETAKE_CHROMIUM;
    process.env.RETAKE_CHROMIUM = wrapper;
  }, 60_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env.RETAKE_CHROMIUM;
    else process.env.RETAKE_CHROMIUM = saved;
    await app?.close();
    await auth?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the capture session refuses it', async () => {
    await expect(openSession({ width: 640, height: 400, scale: 1, kit: kitConfigFor(undefined) })).rejects.toThrow(REFUSED);
  }, 60_000);

  it('the artefact renderer refuses it', async () => {
    const r = new ArtefactRenderer();
    try {
      await expect(r.email('<!doctype html><p>Your quote is ready.</p>', join(dir, 'mail.png'))).rejects.toThrow(REFUSED);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("the raw layer's cursor atlas refuses it", async () => {
    await expect(renderCursorAtlas({ kit: kitConfigFor(undefined), scale: 1 })).rejects.toThrow(REFUSED);
  }, 60_000);

  it.skipIf(!hasOpenssl())('the site extraction refuses it (a failed extraction, saying why)', async () => {
    const brand = await startBrandSite();
    try {
      const r = await extractSite({ url: BRAND_SITE_URL, host: 'brand.test', outDir: await tempDir('rw-launch-wrap-site-'), testResolve: brand.testResolve });
      expect(r.status).toBe('failed');
      expect(r.untrusted.error).toMatch(REFUSED);
    } finally {
      await brand.close();
    }
  }, 120_000);

  it('the sign-in window refuses it', async () => {
    const home = await tempDir('rw-launch-wrap-home-');
    const savedHome = process.env.RETAKE_HOME;
    process.env.RETAKE_HOME = home;
    try {
      const project = makeProject(await tempDir('rw-launch-wrap-login-'), { app: auth.url });
      project.config.auth = { login_url: '/sign-in', personas: { supplier: { pages: ['app'] } } };
      const persona = resolvePersonas(project, 'test').find((p) => p.name === 'supplier')!;
      await expect(signIn({ project, env: { name: 'test', pages: { app: auth.url } }, persona, mode: 'headed', headless: true, drive: async (page) => void (await page.close()) })).rejects.toThrow(REFUSED);
    } finally {
      process.env.RETAKE_HOME = savedHome;
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('the recording window refuses it', async () => {
    const project = makeProject(await tempDir('rw-launch-wrap-record-'), { app: app.url });
    await expect(
      recordSession({ project, env: resolveEnvironment(project, 'test'), url: `${app.url}/`, headless: true, windowSize: { width: 800, height: 600 }, drive: async (page) => void (await page.close()) }),
    ).rejects.toThrow(REFUSED);
  }, 60_000);
});

/** python3 that can call the macOS kernel's sandbox_check (libSystem). */
function sandboxChecker(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('python3', ['-I', '-c', "import ctypes; ctypes.CDLL('/usr/lib/libSystem.B.dylib').sandbox_check"], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const SANDBOX_CHECK = `import ctypes, sys
l = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
l.sandbox_check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
for p in sys.argv[1:]:
    print(p, l.sandbox_check(int(p), None, 0))
`;

describe.skipIf(!process.env.RETAKE_TEST_SLOW || !sandboxChecker())('macOS: the kernel sees the capture browser sandboxed (slow)', () => {
  it('its renderers and GPU process are sandboxed, the browser process alone is not', async () => {
    const session = await openSession({ width: 640, height: 400, scale: 1, kit: kitConfigFor(undefined) });
    try {
      const page = await session.page('main');
      await page.setContent('<canvas id="c"></canvas><script>document.getElementById("c").getContext("webgl")</script><h1>GPU</h1>');
      const cdp = await page.context().browser()!.newBrowserCDPSession();
      const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number }> };
      await cdp.detach();
      const out = execFileSync('python3', ['-I', '-c', SANDBOX_CHECK, ...processInfo.map((p) => String(p.id))], { encoding: 'utf8', timeout: 10_000 });
      const sandboxed = new Map(out.trim().split('\n').map((l) => l.split(' ')).map(([pid, v]) => [Number(pid), v !== '0']));
      const byType = (type: string) => processInfo.filter((p) => p.type === type).map((p) => sandboxed.get(p.id));
      expect(byType('renderer').length).toBeGreaterThan(0);
      expect(byType('renderer')).toEqual(byType('renderer').map(() => true));
      expect(byType('GPU')).toEqual([true]);
      expect(byType('browser')).toEqual([false]);
    } finally {
      await session.close();
    }
  }, 60_000);
});
