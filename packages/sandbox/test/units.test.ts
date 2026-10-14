/**
 * @demo-studio/sandbox, the parts that need no app (L1.8): process identity (ps lstart read with LC_ALL=C, `sh -c`
 * exec'd, a leader gone with its group alive, a pid that is another program's), group stops (SIGKILL after the timeout,
 * descendants that left the group), the take lock (busy, stale), the state file, ports (probe, lsof owner), health
 * checks (refused → 503 → 200, text, timeout, abort, a process gone), commands and the environment of a service.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject, LoadedSandbox, SandboxManifest } from '@demo-studio/core';
import {
  BREAKER_STALE_MS,
  SandboxError,
  TakeLock,
  bootTime,
  busyPorts,
  groupMembers,
  groupTree,
  identify,
  listeners,
  parseBootTime,
  parseLsof,
  parseLstart,
  parseProcessTable,
  probePort,
  processStart,
  processTable,
  readLock,
  readState,
  resolveCommand,
  sandboxPorts,
  serviceEnv,
  serviceHealth,
  signalState,
  stopGroup,
  waitHealthy,
  writeState,
} from '@demo-studio/sandbox';

const posix = process.platform !== 'win32';
/** The built lock module (`pnpm build`): the race test runs it in separate processes. */
const LOCK_MODULE = fileURLToPath(new URL('../dist/lock.js', import.meta.url));
let tmp = '';
const children: ChildProcess[] = [];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'demo-studio-sandbox-units-'));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.pid !== undefined) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A detached child (its own process group), killed after the test. */
function detached(file: string, args: string[]): ChildProcess {
  const c = spawn(file, args, { detached: true, stdio: 'ignore' });
  c.unref();
  children.push(c);
  return c;
}

const IDLE = 'setInterval(() => {}, 1000)';

describe('process identity (ps lstart, LC_ALL=C)', () => {
  it('parses lstart as ps prints it under LC_ALL=C (local time); a localised one is not read', () => {
    expect(parseLstart('Tue Oct 13 22:49:00 2026')).toBe(new Date(2026, 9, 13, 22, 49, 0).getTime());
    expect(parseLstart('Tue Oct  6 08:01:02 2026')).toBe(new Date(2026, 9, 6, 8, 1, 2).getTime());
    expect(parseLstart('mar. 13 oct. 21:56:49 2026')).toBeNull();
    const table = parseProcessTable('  123     1   123 Tue Oct 13 22:49:00 2026\n  456   123   123 Tue Oct 13 22:49:01 2026\n');
    expect(table).toEqual([
      { pid: 123, ppid: 1, pgid: 123, start: new Date(2026, 9, 13, 22, 49, 0).getTime() },
      { pid: 456, ppid: 123, pgid: 123, start: new Date(2026, 9, 13, 22, 49, 1).getTime() },
    ]);
  });

  it.skipIf(!posix)('a live group leader with its start time is ours; another start time is a reused pid; an ended one is gone', async () => {
    const c = detached(process.execPath, ['-e', IDLE]);
    await sleep(200);
    const start = await processStart(c.pid!);
    expect(start).not.toBeNull();
    expect(await identify(c.pid!, new Date(start!).toISOString())).toBe('ours');
    expect(await identify(c.pid!, new Date(start! - 3600_000).toISOString())).toBe('reused');
    process.kill(-c.pid!, 'SIGKILL');
    await sleep(200);
    expect(await identify(c.pid!, new Date(start!).toISOString())).toBe('gone');
  });

  it.skipIf(!posix)('`sh -c "cmd"` exec\'d into cmd keeps its pid and start time: still ours', async () => {
    const c = detached('/bin/sh', ['-c', 'sleep 30']);
    const start = await processStart(c.pid!);
    await sleep(300);
    expect(await processStart(c.pid!)).toBe(start);
    expect(await identify(c.pid!, new Date(start!).toISOString())).toBe('ours');
  });

  it.skipIf(!posix)('a leader gone with its group alive is ours only with a recorded member in it (or started by this call), and stopGroup stops the group', async () => {
    const c = detached('/bin/sh', ['-c', '(sleep 30 &) ; sleep 0.4 ; exit 0']);
    const start = await processStart(c.pid!);
    await sleep(150);
    const members = groupMembers(await processTable(), c.pid!);
    expect(members.length).toBeGreaterThan(1);
    await sleep(600);
    expect(signalState(c.pid!)).toBe('gone');
    expect(signalState(-c.pid!)).toBe('alive');
    const at = new Date(start ?? Date.now()).toISOString();
    // A group of that id whose members nobody recorded: possibly another program's after a pid reuse (P2).
    expect(await identify(c.pid!, at)).toBe('reused');
    expect(await identify(c.pid!, at, { members: [{ pid: c.pid! + 1, start: Date.now() - 3600_000 }] })).toBe('reused');
    expect(await identify(c.pid!, at, { members })).toBe('ours');
    expect(await identify(c.pid!, at, { spawned: true })).toBe('ours');
    const r = await stopGroup(c.pid!, 2000);
    expect(r.forced).toBe(false);
    // A killed member is a zombie for a moment (kill(-pgid, 0) says EPERM on macOS), then the group is gone.
    expect(signalState(-c.pid!)).not.toBe('alive');
  });

  it.skipIf(!posix)('after a reboot nothing recorded is ours (boot time in the state)', async () => {
    expect(parseBootTime('{ sec = 1791711260, usec = 669616 } Sun Oct 11 11:34:20 2026')).toBe(1791711260);
    expect(parseBootTime('nonsense')).toBeNull();
    const boot = bootTime();
    expect(boot).toBeGreaterThan(1_000_000_000);
    const c = detached(process.execPath, ['-e', IDLE]);
    await sleep(200);
    const at = new Date((await processStart(c.pid!))!).toISOString();
    expect(await identify(c.pid!, at, { boot })).toBe('ours');
    expect(await identify(c.pid!, at, { boot: boot! - 86_400 })).toBe('gone');
  });

  it.skipIf(!posix)('stopGroup kills a group that ignores SIGTERM after the timeout, and the descendants that left the group', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      `const g = spawn(process.execPath, ['-e', '${IDLE}'], { detached: true, stdio: 'ignore' }); g.unref();`,
      "console.log(g.pid); process.on('SIGTERM', () => {});",
      IDLE,
    ].join('\n');
    const c = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(c);
    const grandchild = await new Promise<number>((resolve) => c.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    await sleep(200);
    const tree = groupTree(await processTable(), c.pid!);
    expect(tree.map((p) => p.pid)).toEqual(expect.arrayContaining([c.pid!, grandchild]));
    expect(tree.find((p) => p.pid === grandchild)!.pgid).toBe(grandchild);
    const r = await stopGroup(c.pid!, 300);
    expect(r).toEqual({ forced: true, leftovers: 1 });
    await sleep(100);
    expect(signalState(-c.pid!)).not.toBe('alive');
    expect(signalState(grandchild)).not.toBe('alive');
  });
});

describe('take lock', () => {
  it('a second command fails fast naming the holder; released, it is free again', () => {
    const file = join(tmp, 'lock1', 'take.lock');
    const a = TakeLock.acquire(file, 'sandbox up', 'sandbox');
    let err: unknown;
    try {
      TakeLock.acquire(file, 'run quote', 'sandbox');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('busy');
    expect((err as Error).message).toMatch(new RegExp(`^sandbox sandbox is in use: sandbox up \\(pid ${process.pid}\\) since \\d\\d:\\d\\d:\\d\\d — wait for it`));
    a.note('20261014-101500-quote');
    expect(readLock(file)?.run).toBe('20261014-101500-quote');
    a.releaseSync();
    expect(readLock(file)).toBeNull();
    TakeLock.acquire(file, 'run quote', 'sandbox').releaseSync();
  });

  it.skipIf(!posix)('a lock whose process is gone, or whose pid is now another program, is stale: removed with a note', async () => {
    const file = join(tmp, 'lock2', 'take.lock');
    const done = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => done.once('exit', r));
    const notes: string[] = [];
    const mkdir = (await import('node:fs/promises')).mkdir;
    await mkdir(join(tmp, 'lock2'), { recursive: true });
    await writeFile(file, JSON.stringify({ pid: done.pid, command: 'sandbox up', since: new Date().toISOString() }));
    TakeLock.acquire(file, 'run quote', 'sandbox', (m) => notes.push(m)).releaseSync();
    // This process's pid, but a start time an hour off: a reused pid.
    await writeFile(file, JSON.stringify({ pid: process.pid, started_at: new Date(Date.now() - 3600_000).toISOString(), command: 'run quote', run: 'r1', since: new Date().toISOString() }));
    TakeLock.acquire(file, 'run quote', 'sandbox', (m) => notes.push(m)).releaseSync();
    expect(notes).toEqual([
      expect.stringMatching(/^removed a stale take lock of sandbox sandbox: sandbox up \(pid \d+\) since .* is not running any more$/),
      expect.stringMatching(/^removed a stale take lock of sandbox sandbox: run r1 \(pid \d+\)/),
    ]);
  });

  it.skipIf(!posix)('two commands finding the same stale lock never both take it (P1): created whole, broken under a breaker', async () => {
    const file = join(tmp, 'lock3', 'take.lock');
    await mkdir(join(tmp, 'lock3'), { recursive: true });
    const script = [
      `import { TakeLock } from ${JSON.stringify(LOCK_MODULE)};`,
      'const [file, at] = process.argv.slice(1);',
      'while (Date.now() < Number(at)) {}',
      "try { const l = TakeLock.acquire(file, 'probe', 'sandbox'); console.log('GOT'); const until = Date.now() + 300; while (Date.now() < until) {} l.releaseSync(); }",
      "catch (e) { console.log(e.code === 'busy' ? 'BUSY' : `ERR ${e.message}`); }",
    ].join('\n');
    const one = (at: number) =>
      new Promise<string>((resolve) => {
        const c = spawn(process.execPath, ['--input-type=module', '-e', script, file, String(at)], { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        c.stdout!.on('data', (d) => (out += d));
        c.once('exit', () => resolve(out.trim()));
      });
    for (let round = 0; round < 5; round++) {
      // A stale lock (its pid cannot exist), or an empty one (a writer that died before writing).
      await writeFile(file, round % 2 ? '' : JSON.stringify({ pid: 999_999, command: 'run x', since: new Date().toISOString() }));
      const at = Date.now() + 600;
      const outs = await Promise.all([one(at), one(at), one(at), one(at)]);
      expect(outs.filter((o) => o === 'GOT').length, `round ${round}: ${outs.join(', ')}`).toBe(1);
      expect(outs.filter((o) => o !== 'GOT' && o !== 'BUSY')).toEqual([]);
    }
    expect(existsSync(file)).toBe(false);
    // A breaker left by a command that died while breaking (older than BREAKER_STALE_MS) does not block anyone.
    await writeFile(file, JSON.stringify({ pid: 999_999, command: 'run x', since: new Date().toISOString() }));
    await writeFile(`${file}.break`, '');
    const old = new Date(Date.now() - BREAKER_STALE_MS - 5000);
    utimesSync(`${file}.break`, old, old);
    const notes: string[] = [];
    TakeLock.acquire(file, 'run quote', 'sandbox', (m) => notes.push(m)).releaseSync();
    expect(notes).toEqual([expect.stringMatching(/^removed a stale take lock of sandbox sandbox: run x \(pid 999999\)/)]);
    expect(existsSync(`${file}.break`)).toBe(false);
  });
});

describe('state file', () => {
  it('round-trips; malformed, another version or another provider read as empty with a note', async () => {
    const file = join(tmp, 'state', 'state.json');
    expect(readState(file, 'sandbox', 'process')).toEqual({ state: { version: 1, env: 'sandbox', provider: 'process', services: {} } });
    const state = { version: 1 as const, env: 'sandbox', provider: 'process' as const, services: { app: { kind: 'process', pid: 42, started_at: '2026-10-13T20:00:00.000Z', command: 'node a.mjs', hash: 'h', status: 'running' as const } } };
    writeState(file, state);
    expect(readState(file, 'sandbox', 'process').state).toEqual(state);
    expect(readState(file, 'sandbox', 'docker-compose').note).toMatch(/written for provider process \(sandbox\.yaml now says docker-compose\)/);
    await writeFile(file, '{"version": 2, "services": {}}');
    expect(readState(file, 'sandbox', 'process').note).toMatch(/not a state file this Demo Studio reads/);
    await writeFile(file, '{oops');
    expect(readState(file, 'sandbox', 'process')).toMatchObject({ state: { services: {} }, note: expect.stringMatching(/not valid JSON/) });
  });
});

/** A local HTTP server on a free port. */
async function serve(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; port: number; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://localhost:${port}` };
}
const closeServer = (s: Server) => new Promise((r) => s.close(r));

describe('ports', () => {
  it('lists the ports of the services (url, pages, health) with who declares them', () => {
    const manifest = {
      version: 1,
      provider: 'process',
      services: {
        app: { command: ['node', 'a.mjs'], url: 'http://localhost:4601', health: '/up', pages: { console: 'http://localhost:4603', shop: { url: 'http://localhost:4604', display: 'shop.example.com' } } },
        db: { command: 'db', health: { tcp: 4632 } },
      },
    } as unknown as SandboxManifest;
    expect(sandboxPorts(manifest)).toEqual([
      { port: 4601, service: 'app', what: ['url'] },
      { port: 4603, service: 'app', what: ['page console'] },
      { port: 4604, service: 'app', what: ['page shop'] },
      { port: 4632, service: 'db', what: ['health'] },
    ]);
  });

  it('probes a port and names the program that listens on it (lsof)', async () => {
    const { server, port } = await serve((_q, r) => r.end('ok'));
    try {
      expect(await probePort(port)).toBe(true);
      const ls = await listeners([port]);
      if (ls !== null) expect(ls).toEqual([expect.objectContaining({ pid: process.pid, port })]);
      const busy = await busyPorts([{ port, service: 'app', what: ['url'] }]);
      expect(busy).toHaveLength(1);
      if (ls !== null) expect(busy[0].by).toEqual([expect.objectContaining({ pid: process.pid })]);
    } finally {
      await closeServer(server);
    }
    expect(await probePort(port)).toBe(false);
    expect(await busyPorts([{ port, service: 'app', what: ['url'] }])).toEqual([]);
    expect(parseLsof('p81234\ng81234\ncnode\nf21\nn127.0.0.1:4501\nf22\nn[::1]:4501\np900\ng900\ncpython3\nf3\nn*:4502\n')).toEqual([
      { pid: 81234, pgid: 81234, command: 'node', port: 4501 },
      { pid: 900, pgid: 900, command: 'python3', port: 4502 },
    ]);
  });
});

describe('health', () => {
  it('what is checked: the health of sandbox.yaml (default a GET of url), then every page answering HTTP', () => {
    expect(serviceHealth('app', { url: 'http://localhost:4601', pages: { shop: 'http://localhost:4604' } })).toEqual({
      service: 'app',
      targets: [{ kind: 'http', url: 'http://localhost:4601' }, { kind: 'http', url: 'http://localhost:4604', anyStatus: true }],
      timeoutMs: 60_000,
      intervalMs: 250,
    });
    expect(serviceHealth('app', { url: 'http://localhost:4601/base', health: '/api/health' }).targets).toEqual([{ kind: 'http', url: 'http://localhost:4601/api/health' }]);
    expect(serviceHealth('app', { url: 'http://localhost:4601', health: { path: '/up', status: 204, text: 'ready', timeout_s: 5, interval_ms: 100 } })).toMatchObject({
      targets: [{ kind: 'http', url: 'http://localhost:4601/up', status: [204], text: 'ready' }],
      timeoutMs: 5000,
      intervalMs: 100,
    });
    expect(serviceHealth('db', { health: { tcp: 4632 } }).targets).toEqual([{ kind: 'tcp', port: 4632 }]);
    // health: false skips the service's own check, never its pages (P5).
    expect(serviceHealth('app', { url: 'http://localhost:4601', health: false, pages: { a: 'http://localhost:4602' } }).targets).toEqual([{ kind: 'http', url: 'http://localhost:4602', anyStatus: true }]);
    // A path always stays on the service's url ("//host" or "/\\host" would name another one; validation refuses them).
    expect(serviceHealth('app', { url: 'http://localhost:4601', health: '//evil.example/up' }).targets).toEqual([{ kind: 'http', url: 'http://localhost:4601/evil.example/up' }]);
    expect(serviceHealth('app', { url: 'http://localhost:4601', health: { path: '/\\evil.example/up' } }).targets).toEqual([{ kind: 'http', url: 'http://localhost:4601/evil.example/up' }]);
  });

  it('waits through refused → 503 → 200 (with the text); times out naming the check, the last failure and the tries', async () => {
    const { server, port } = await serve((q, r) => {
      calls++;
      if (calls < 3) {
        r.statusCode = 503;
        r.end('starting');
      } else r.end('ready');
    });
    let calls = 0;
    await closeServer(server); // refused first
    const later = setTimeout(() => server.listen(port, '127.0.0.1'), 400);
    try {
      const r = await waitHealthy({ service: 'app', targets: [{ kind: 'http', url: `http://127.0.0.1:${port}/`, text: 'ready' }], timeoutMs: 10_000, intervalMs: 50 });
      expect(r.tries).toBeGreaterThan(3);
      expect(calls).toBe(3);
    } finally {
      clearTimeout(later);
      await closeServer(server);
    }
    const e = await waitHealthy({ service: 'app', targets: [{ kind: 'http', url: `http://127.0.0.1:${port}/api/health` }], timeoutMs: 400, intervalMs: 50 }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxError);
    expect(e.code).toBe('unhealthy');
    expect(e.message).toMatch(new RegExp(`^service app is not healthy after 0 s — GET http://127\\.0\\.0\\.1:${port}/api/health: connection refused \\(\\d+ tries\\)$`));
  });

  it('stops waiting when aborted (interrupted) or when the process is gone (unhealthy, with why)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const target = { kind: 'tcp' as const, port: 1 };
    const a = await waitHealthy({ service: 'app', targets: [target], timeoutMs: 10_000, intervalMs: 50 }, { signal: ac.signal }).catch((x) => x);
    expect(a).toMatchObject({ code: 'interrupted' });
    const g = await waitHealthy({ service: 'app', targets: [target], timeoutMs: 10_000, intervalMs: 50 }, { gone: () => 'exited with code 3' }).catch((x) => x);
    expect(g).toMatchObject({ code: 'unhealthy', message: 'service app exited with code 3' });
  });
});

describe('a service: command and environment', () => {
  it('argv "node" runs this Node; a string runs with sh -c', () => {
    expect(resolveCommand(['node', 'server.mjs', '--port', '4601'])).toEqual({ file: process.execPath, args: ['server.mjs', '--port', '4601'], display: 'node server.mjs --port 4601' });
    expect(resolveCommand('npm run dev')).toEqual({ file: '/bin/sh', args: ['-c', 'npm run dev'], display: 'npm run dev' });
  });

  it("inherits the CLI's environment without the package manager's and test runner's variables, plus sandbox.yaml's env (templated)", async () => {
    const project = { slug: 'p', dir: tmp, file: join(tmp, 'project.yaml'), config: { name: 'p', environments: { sandbox: { console: 'http://localhost:4603' } }, vars: { region: 'eu' } } } as unknown as LoadedProject;
    const sandbox = { env: 'sandbox', dir: tmp } as unknown as LoadedSandbox;
    process.env.DEMO_STUDIO_TEST_SECRET = 'from-env-1234';
    try {
      const env = await serviceEnv(
        { project, sandbox },
        { env: { API_URL: '{{console}}/api', TOKEN: '{{env:DEMO_STUDIO_TEST_SECRET}}', REGION: '{{vars.region}}', NODE_ENV: 'development' } },
        { PATH: '/usr/bin', HOME: '/home/me', npm_config_cache: 'x', npm_lifecycle_event: 'studio', PNPM_SCRIPT_SRC_DIR: 'y', VITEST: 'true', VITEST_POOL_ID: '1', NODE_ENV: 'test', INIT_CWD: '/x', LANG: 'C' },
      );
      expect(env).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/me',
        LANG: 'C',
        API_URL: 'http://localhost:4603/api',
        TOKEN: 'from-env-1234',
        REGION: 'eu',
        NODE_ENV: 'development',
        DEMO_STUDIO_SANDBOX: 'sandbox',
      });
    } finally {
      delete process.env.DEMO_STUDIO_TEST_SECRET;
    }
  });
});
