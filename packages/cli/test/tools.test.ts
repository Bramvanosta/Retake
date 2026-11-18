/**
 * `retake tools`: status, install (`--from-archives`, never the network here), check, prune — in the app (a
 * fake bundle naming the fixture Tools: core overrideBundleInfo, the test seam) and in a checkout (status says what a
 * checkout uses; install, check and prune are refused); and the in-process commands that need a Tool refusing before
 * they start while it is not downloaded.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { overrideBundleInfo, toolState } from '@retake/core/io';
import { scratchHome } from '@retake/test-support/home';
import { fakeToolsBundle, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';
import { CHECKOUT_TOOLS } from '@retake/engine/tools';
import { EXIT, main, memoryIo } from '../src/index.js';
import { CLI_TOOL_NEEDS, commandPaths } from '../src/main.js';
import { commandRefusal } from '../src/tool-needs.js';
import { cliEnginePorts } from '../src/workspace.js';
import type { Command } from 'commander';
import { fixtureWorkspace } from '@retake/test-support/workspace';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-cli-tools-')));
const home = scratchHome();
afterAll(() => {
  home.restore();
  spawnSync('/bin/chmod', ['-R', 'u+w', tmp]);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => overrideBundleInfo(undefined));
// A browser named by the environment needs no Tool (tools/gate.ts): the CI tier names a missing program in both
// (scripts/test-ci.mjs), so these tests run without them and give them back after.
const NAMED_BROWSERS = ['RETAKE_CHROMIUM', 'RETAKE_CHROMIUM_HEADLESS_SHELL'] as const;
const namedBrowsers = Object.fromEntries(NAMED_BROWSERS.map((k) => [k, process.env[k]]));
beforeAll(() => {
  for (const k of NAMED_BROWSERS) delete process.env[k];
});
afterAll(() => {
  for (const k of NAMED_BROWSERS)
    if (namedBrowsers[k] === undefined) delete process.env[k];
    else process.env[k] = namedBrowsers[k];
});

let fx: FixtureTools;
let n = 0;
beforeAll(async () => {
  fx = await toolFixtures(join(tmp, 'fx'));
});

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** A fresh home and an app whose bundle.json names the fixture Tools. */
function app(): string {
  const h = home.use(join(tmp, `home${n++}`));
  overrideBundleInfo(fakeToolsBundle(join(tmp, `app${n}`), fx.entries));
  return join(h, 'tools');
}

describe('retake tools in the app', () => {
  it('status, then install from a folder of archives, then status: each Tool checked and in place', async () => {
    const tools = app();
    const before = await retake('tools');
    expect(before.code).toBe(EXIT.ok);
    expect(before.out).toMatch(/^Tools · needed · .*tools \(\$RETAKE_HOME\)\n/);
    expect(before.out).toMatch(/Render browser\s+0\.0\.1\s+not downloaded \(0\.0 MB\)/);
    expect(JSON.parse((await retake('tools', 'status', '--json')).out)).toMatchObject({ available: true, state: 'needed', folder: tools });
    const r = await retake('tools', 'install', '--from-archives', fx.archives);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/Render browser 0\.0\.1 · checked · .*chromium_headless_shell-001/);
    expect(r.err).toMatch(/Browser 0\.0\.1 · checked · .*chromium-001/);
    for (const e of fx.entries) expect(toolState(e, tools).state).toBe('ready');
    expect((await retake('tools')).out).toMatch(/^Tools · ready/);
  });

  it('install --json: one line per progress step, then the result', async () => {
    app();
    const r = await retake('tools', 'install', '--from-archives', fx.archives, '--json');
    const lines = r.out
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; outcome?: string });
    expect(lines.at(-1)).toMatchObject({ type: 'result', outcome: 'ready' });
    expect(lines.slice(0, -1).every((l) => l.type === 'progress')).toBe(true);
  });

  it('check: a folder changed after its install is found by its digest and stays damaged until installed again', async () => {
    const tools = app();
    await retake('tools', 'install', '--from-archives', fx.archives);
    expect((await retake('tools', 'check')).code).toBe(EXIT.ok);
    // Same size, another byte: the cheap state cannot see it, the digest does.
    const lib = join(tools, 'compositor-0.0.1', 'libcompositor.dylib');
    spawnSync('/bin/chmod', ['u+w', lib]);
    const bytes = readFileSync(lib);
    bytes[0] = bytes[0]! ^ 0x20;
    writeFileSync(lib, bytes);
    expect(toolState(fx.entries[1]!, tools).state).toBe('ready');
    const c = await retake('tools', 'check');
    expect(c.code).toBe(EXIT.failure);
    expect(c.err).toMatch(/compositor: damaged — its tree digest is [0-9a-f]{12}…, not the/);
    expect(toolState(fx.entries[1]!, tools)).toMatchObject({ state: 'damaged', problem: expect.stringMatching(/its last check found its files changed/) });
    expect((await retake('tools', 'install', '--from-archives', fx.archives)).code).toBe(EXIT.ok);
    expect(toolState(fx.entries[1]!, tools).state).toBe('ready');
  });

  it('prune removes an older folder nothing keeps', async () => {
    const tools = app();
    await retake('tools', 'install', '--from-archives', fx.archives);
    mkdirSync(join(tools, 'browsers', 'chromium-1000'), { recursive: true });
    writeFileSync(join(tools, 'browsers', 'chromium-1000', 'x'), 'x');
    const r = await retake('tools', 'prune');
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).toMatch(/removed browsers\/chromium-1000/);
    expect(existsSync(join(tools, 'browsers', 'chromium-1000'))).toBe(false);
  });

  it('while another process downloads them: --no-wait says who and exits 0', async () => {
    const tools = app();
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, '.lock'), JSON.stringify({ pid: process.pid, command: 'tools install', by: 'studio', version: '0.0.1', since: new Date().toISOString() }));
    const r = await retake('tools', 'install', '--no-wait');
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toMatch(/the Tools are being downloaded by the Studio \(pid \d+, Retake 0\.0\.1\): it goes on there/);
    rmSync(join(tools, '.lock'));
  });

  it('a command that runs a browser or renders refuses before it starts while its Tools are not downloaded', async () => {
    app();
    const r = await retake('run', 'p', 's');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toMatch(/retake run needs the browser: the browser is not downloaded yet \(.*\): run `retake tools install`/);
    const s = await retake('render', 'p', 's');
    expect(s.err).toMatch(/retake render needs the render tools: the render browser is not downloaded yet/);
    // Every command the table names exists.
    expect(Object.keys(CLI_TOOL_NEEDS).filter((p) => !commandPaths().includes(p))).toEqual([]);
    // An export re-renders; checking the saved sessions opens a browser; a raw export without a cursor draws none.
    expect((await retake('export', 'p', 'r')).err).toMatch(/retake export needs the render tools/);
    expect((await retake('auth', 'status', '--check')).err).toMatch(/retake auth status needs the browser/);
    expect((await retake('auth', 'status')).err).not.toMatch(/needs the browser/);
    expect((await retake('export-capture', 'p', 'r')).err).toMatch(/retake export-capture needs the browser/);
    expect((await retake('export-capture', 'p', 'r', '--cursor', 'none')).err).not.toMatch(/needs the browser/);
  });

  it('a command whose project launches a browser of its own needs no Tool; the headless shell needs the render tools; a project that cannot be read keeps the refusal', async () => {
    app();
    const root = join(tmp, `ws${n++}`);
    mkdirSync(root);
    await fixtureWorkspace(root);
    const yaml = join(root, 'projects', 'northfield-fixture', 'project.yaml');
    const text = readFileSync(yaml, 'utf8');
    const g = { root, ports: cliEnginePorts() };
    const cmd = (args: string[], opts: Record<string, unknown> = {}) => ({ args, opts: () => opts }) as unknown as Command;
    for (const [browser, path, opts, want] of [
      ['  channel: chrome', 'run', {}, undefined],
      ['  executable: /opt/own/chrome', 'login', {}, undefined],
      ['  channel: headless-shell', 'run', {}, /retake run needs the render tools/],
      // A window (a recording, a sign-in, --headed) is never the headless shell: the browser.
      ['  channel: headless-shell', 'record', {}, /retake record needs the browser/],
      ['  channel: headless-shell', 'run', { headed: true }, /retake run needs the browser/],
      ['  channel: chromium', 'inspect', {}, /retake inspect needs the browser/],
    ] as const) {
      writeFileSync(yaml, `${text}\nbrowser:\n${browser}\n`);
      const r = await commandRefusal(g, path, cmd(['northfield-fixture'], opts));
      if (want) expect(r, `${browser} ${path}`).toMatch(want);
      else expect(r, `${browser} ${path}`).toBeUndefined();
    }
    expect(await commandRefusal(g, 'run', cmd(['no-such-project']))).toMatch(/retake run needs the browser/);
    writeFileSync(yaml, text);
  });

  it('--from-archives with --from-playwright-cache: refused in one sentence, nothing installed', async () => {
    const tools = app();
    const r = await retake('tools', 'install', '--from-archives', fx.archives, '--from-playwright-cache');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toMatch(/--from-archives and --from-playwright-cache are two sources of the same Tools: give one/);
    expect(existsSync(join(tools, 'browsers', 'chromium-001'))).toBe(false);
  });
});

describe('retake tools in a checkout', () => {
  it('status says what a checkout uses; install (from anywhere), check and prune are refused with one sentence', async () => {
    overrideBundleInfo(null);
    home.use(join(tmp, `home${n++}`));
    const s = await retake('tools');
    expect(s.code).toBe(EXIT.ok);
    expect(s.out).toBe(`Tools: none — ${CHECKOUT_TOOLS}\n`);
    expect(JSON.parse((await retake('tools', '--json')).out)).toMatchObject({ available: false, state: 'checkout' });
    for (const args of [['install'], ['install', '--from-playwright-cache'], ['install', '--from-archives', fx.archives], ['check'], ['prune']]) {
      const r = await retake('tools', ...args);
      expect(r.code, args.join(' ')).toBe(EXIT.failure);
      expect(r.err, args.join(' ')).toContain('this Retake runs from a repository checkout');
    }
  });
});
