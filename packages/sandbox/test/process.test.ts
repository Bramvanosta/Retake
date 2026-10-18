/**
 * The process provider for real (L1.8): the bundled fixture as a sandbox on free ports — up (healthy, seeded), an
 * idempotent up, reset (a created quote, a sent mail and the demo clock undone; pending rollbacks superseded), the take
 * lock, a second sandbox refused on the same ports (naming the program), down (the PDF browser it started outside its
 * group stopped too, ports free), a state whose process is gone, a crashing service (exit code + log tail) and an
 * interrupt during the health wait (the whole group of what that call started stopped). Never the fixed 45xx ports: a
 * developer's own sandbox may hold them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import { Journal } from '@demo-studio/hooks';
import type { NewJournalEntry } from '@demo-studio/hooks';
import { SandboxError, groupTree, openSandbox, probePort, processStart, processTable, readState, sandboxPaths, signalState, writeState } from '@demo-studio/sandbox';
import type { Sandbox } from '@demo-studio/sandbox';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER = join(REPO, 'fixtures/wholesale/server.mjs');
const posix = process.platform !== 'win32';

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'fixtures/wholesale/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** `n` distinct free TCP ports (on 127.0.0.1 and ::1). */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!out.includes(port) && !(await probePort(port))) out.push(port);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A project folder with one sandbox (`sandbox.yaml` text), loaded. */
async function makeProject(root: string, name: string, manifest: string): Promise<LoadedProject> {
  const dir = join(root, name);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(
    join(dir, 'project.yaml'),
    ['name: Sandbox test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'),
  );
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest);
  return loadProject(dir);
}

/** The fixture's process sandbox (signed-in side as the pages) on ports [console, shop, auth console, auth shop]. */
function fixtureManifest(p: number[]): string {
  return [
    'version: 1',
    'provider: process',
    'services:',
    '  fixture:',
    `    command: [node, ${JSON.stringify(SERVER)}, --no-build, --console-port, "${p[0]}", --shop-port, "${p[1]}", --auth-console-port, "${p[2]}", --auth-shop-port, "${p[3]}"]`,
    `    url: http://localhost:${p[0]}`,
    '    health: /api/health',
    '    stop_timeout_s: 5',
    '    pages:',
    `      console: {url: "http://localhost:${p[2]}", display: console.northfield.example}`,
    `      shop: {url: "http://localhost:${p[3]}", display: shop.northfield.example}`,
    'seed:',
    '  - name: reset-fixture',
    '    http: {method: POST, url: "{{console}}/api/reset"}',
    `mailbox: {provider: mailpit, url: "http://localhost:${p[0]}/mailbox"}`,
    '',
  ].join('\n');
}

let root = '';
let ports: number[] = [];
let project: LoadedProject;
let sb: Sandbox;
const logs: string[] = [];
const log = (level: string, msg: string) => logs.push(`${level} ${msg}`);
const api = (path: string) => `http://localhost:${ports[0]}${path}`;
const json = async (url: string, init?: RequestInit) => (await fetch(url, init)).json() as Promise<any>;

describe.skipIf(!posix)('process provider: the fixture as a sandbox', () => {
  beforeAll(async () => {
    // Build the fixture's bundle once (the sandboxes start it with --no-build: parallel forks would race on it).
    const build = (await import(join(REPO, 'fixtures/wholesale/build.mjs'))) as { bundleState(): Promise<{ fresh: boolean }>; build(): Promise<unknown> };
    if (!(await build.bundleState()).fresh) await build.build();
    root = await mkdtemp(join(tmpdir(), 'demo-studio-sandbox-proc-'));
    ports = await freePorts(4);
    project = await makeProject(root, 'p1', fixtureManifest(ports));
    sb = openSandbox(project);
  });

  afterAll(async () => {
    await sb?.down().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('up starts it, waits until healthy and seeds it; a second up keeps it (same pid, no seed)', async () => {
    const r = await sb.up({ log });
    expect(r.started).toEqual(['fixture']);
    expect(r.reset).toMatchObject({ strategy: 'reseed', restored: false, seed: { steps: 1 }, mailbox: 'cleared' });
    expect(logs).toContain('info seeding sandbox sandbox (never seeded)');
    const st = await sb.status();
    expect(st).toMatchObject({ env: 'sandbox', provider: 'process', state: 'up', seed: { current: true }, last_reset: { strategy: 'reseed', by: 'sandbox up' } });
    expect(st.services).toEqual([expect.objectContaining({ name: 'fixture', state: 'running', healthy: true, health: 'ok' })]);
    const pid = st.services[0].pid!;
    expect(signalState(-pid)).toBe('alive');
    const state = readState(sandboxPaths(project.dir, 'sandbox').state, 'sandbox', 'process').state;
    expect(state.services.fixture).toMatchObject({ kind: 'process', pid, status: 'running', command: expect.stringContaining('server.mjs --no-build') });
    expect(await readFile(join(sandboxPaths(project.dir, 'sandbox').logs, 'fixture.log'), 'utf8')).toContain('Northfield fixture is running');
    const again = await sb.up({ log });
    expect(again).toMatchObject({ started: [], kept: ['fixture'] });
    expect(again.reset).toBeUndefined();
    expect((await sb.status()).services[0].pid).toBe(pid);
  });

  it('reset brings the seed back — a quote created, a mail sent, the demo clock — and supersedes the pending rollbacks of the sandbox', async () => {
    const before = (await json(api('/api/quotes'))).length;
    const q = await json(api('/api/quotes'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_slug: 'selowa-ridge', bags: 2, bag_size: '5 kg', grind: 'Whole bean', label_language: 'Swedish', window_start: '2027-01-10', window_end: '2027-01-24' }),
    });
    await fetch(api('/api/signup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cafe: 'Café Test', name: 'Ada Test', email: 'ada@cafe-test.example' }) });
    expect((await json(api('/api/quotes'))).length).toBe(before + 1);
    // The confirmation mail lands a moment after the sign-up.
    for (let i = 0; i < 50 && (await json(api('/mailbox/api/v1/messages'))).total === 0; i++) await sleep(100);
    expect((await json(api('/mailbox/api/v1/messages'))).total).toBe(1);
    // Pending rollbacks of an earlier run: the sandbox's are superseded by the reset, another environment's are not.
    const journal = await Journal.open(join(project.dir, '.demo-studio', 'journals', 'hooks-20261013-120000.json'));
    const at = new Date().toISOString();
    const entry = (env: string): NewJournalEntry => ({
      kind: 'http',
      phase: 'setup',
      description: 'POST quote',
      env,
      started_at: at,
      finished_at: at,
      status: 'ok',
      rollback: { kind: 'http', method: 'DELETE', url: `{{console}}/api/quotes/${q.id}` } as NewJournalEntry['rollback'],
    });
    await journal.record(entry('sandbox'));
    await journal.record(entry('local'));
    await sleep(1100);
    const r = await sb.reset({ log, by: 'test reset' });
    expect(r).toMatchObject({ strategy: 'reseed', mailbox: 'cleared', superseded: 1 });
    expect((await json(api('/api/quotes'))).length).toBe(before);
    expect((await json(api('/mailbox/api/v1/messages'))).total).toBe(0);
    expect((await json(api('/api/health'))).now).toMatch(/^2026-11-02T10:24:0[0-2]/);
    const after = await Journal.open(journal.file);
    expect(after.entries.map((e) => [e.env, e.superseded?.by])).toEqual([
      ['sandbox', 'test reset'],
      ['local', undefined],
    ]);
  });

  it('prepareTake holds the take lock: a reset or another take fails fast naming the run; released, they work', async () => {
    const take = await sb.prepareTake({ log, command: 'run sandbox-quote' });
    take.note('20261014-101500-sandbox-quote');
    expect(take.info).toEqual({ name: 'sandbox', provider: 'process', strategy: 'reseed', restored: false, reset_ms: expect.any(Number), seed_hash: expect.stringMatching(/^[0-9a-f]{12}$/), at: expect.any(String) });
    expect(take.up.kept).toEqual(['fixture']);
    const busy = await sb.reset().catch((e) => e);
    expect(busy).toBeInstanceOf(SandboxError);
    expect(busy.code).toBe('busy');
    expect(busy.message).toMatch(/^sandbox sandbox is in use: run 20261014-101500-sandbox-quote \(pid \d+\) since \d\d:\d\d:\d\d — wait for it/);
    expect((await sb.status()).lock).toMatchObject({ run: '20261014-101500-sandbox-quote' });
    await take.release();
    await expect(sb.reset()).resolves.toMatchObject({ strategy: 'reseed' });
    expect((await sb.status()).lock).toBeUndefined();
  });

  it('a second sandbox on the same ports is refused before it starts, naming the program that holds them', async () => {
    const pid = (await sb.status()).services[0].pid!;
    const other = openSandbox(await makeProject(root, 'p2', fixtureManifest(ports)));
    const e = await other.up({ log }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxError);
    expect(e.code).toBe('port');
    expect(e.message).toContain(`port ${ports[0]} (service fixture, url) is in use by another program (node, pid ${pid})`);
    expect(e.message).toContain(`port ${ports[3]} (service fixture, page shop) is in use by another program (node, pid ${pid})`);
    expect(e.message).toMatch(/— stop it or change the port in .*sandbox\.yaml$/);
    expect((await other.status()).state).toBe('down');
  });

  it.skipIf(!chromiumAvailable())('down stops it and the PDF browser it started outside its group; its ports are free and it reads as down', async () => {
    const quotes = (await json(api('/api/quotes'))) as Array<{ id: string; proposal: unknown }>;
    const withProposal = quotes.find((q) => q.proposal);
    const pdf = await fetch(`http://localhost:${ports[1]}/quotes/${withProposal!.id}/quote.pdf`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const pid = (await sb.status()).services[0].pid!;
    const tree = groupTree(await processTable(), pid);
    const outside = tree.filter((p) => p.pgid !== pid);
    expect(outside.length).toBeGreaterThan(0); // the browser Playwright launched detached
    const r = await sb.down({ log });
    expect(r.stopped).toEqual(['fixture']);
    await sleep(300);
    expect(tree.filter((p) => signalState(p.pid) === 'alive')).toEqual([]);
    for (const port of ports) expect(await probePort(port)).toBe(false);
    const st = await sb.status();
    expect(st.state).toBe('down');
    expect(st.seed).toBeUndefined();
  });

  it('a state whose process is gone reads as down; up starts it again (the previous log kept as .log.1)', async () => {
    await sb.down();
    const paths = sandboxPaths(project.dir, 'sandbox');
    const done = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => done.once('exit', r));
    writeState(paths.state, { version: 1, env: 'sandbox', provider: 'process', services: { fixture: { kind: 'process', pid: done.pid!, started_at: new Date().toISOString(), command: 'node server.mjs', hash: 'x', status: 'running' } } });
    const st = await sb.status();
    expect(st.state).toBe('down');
    expect(st.services[0].state).toBe('stopped');
    const r = await sb.up({ log });
    expect(r.started).toEqual(['fixture']);
    expect(existsSync(join(paths.logs, 'fixture.log.1'))).toBe(true);
    await sb.down();
  });

  it('a service that exits fails up at once with its exit code and the end of its log; nothing is left behind', async () => {
    const [port] = await freePorts(1);
    const p = await makeProject(
      root,
      'p3',
      ['version: 1', 'provider: process', 'services:', '  app:', `    command: [node, -e, "console.log('boom: no database at localhost:5999'); process.exit(3)"]`, `    url: http://localhost:${port}`, `    pages: {app: "http://localhost:${port}"}`, ''].join('\n'),
    );
    const crash = openSandbox(p);
    const t0 = Date.now();
    const e = await crash.up({ log }).catch((x) => x);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(e).toBeInstanceOf(SandboxError);
    expect(e.code).toBe('unhealthy');
    expect(e.message).toMatch(/^sandbox sandbox: service app exited with code 3 — last lines of \/.*\/p3\/\.demo-studio\/sandbox\/sandbox\/logs\/app\.log:\n/);
    expect(e.message).toContain('boom: no database at localhost:5999');
    expect(readState(sandboxPaths(p.dir, 'sandbox').state, 'sandbox', 'process').state.services).toEqual({});
  });

  it('an interrupt during the health wait stops the whole group this call started (a shell and its child)', async () => {
    const [port] = await freePorts(1);
    const p = await makeProject(
      root,
      'p4',
      ['version: 1', 'provider: process', 'services:', '  slow:', `    command: '${process.execPath} -e "setInterval(() => {}, 1000)" & wait'`, `    url: http://localhost:${port}`, '    health: {path: /, timeout_s: 60}', `    pages: {app: "http://localhost:${port}"}`, ''].join('\n'),
    );
    const slow = openSandbox(p);
    const ac = new AbortController();
    const up = slow.up({ log, signal: ac.signal }).catch((x) => x);
    const paths = sandboxPaths(p.dir, 'sandbox');
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      await sleep(100);
      const s = readState(paths.state, 'sandbox', 'process').state.services.slow as { pid?: number } | undefined;
      pid = s?.pid ?? 0;
    }
    await sleep(500);
    const tree = groupTree(await processTable(), pid);
    expect(tree.length).toBeGreaterThanOrEqual(2);
    expect(await processStart(pid)).not.toBeNull();
    ac.abort();
    const e = await up;
    expect(e).toBeInstanceOf(SandboxError);
    expect(e.code).toBe('interrupted');
    await sleep(200);
    expect(tree.filter((x) => signalState(x.pid) === 'alive')).toEqual([]);
    expect(readState(paths.state, 'sandbox', 'process').state.services).toEqual({});
    expect(logs).toContain('warn stopped what this command had started: slow');
  });
});

/** A small service for the review-fix tests: HTTP on the ports given now, one more after a delay; counts seeds and mailbox clears. */
const SVC = `import { createServer } from 'node:http';
const [now, late, lateMs] = process.argv.slice(2);
let seeds = 0;
let deletes = 0;
const handler = (req, res) => {
  if (req.method === 'POST' && req.url === '/seed') seeds++;
  if (req.method === 'DELETE' && req.url === '/api/v1/messages') deletes++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ seeds, deletes }));
};
for (const p of now.split(',').filter(Boolean)) createServer(handler).listen(Number(p));
if (late) setTimeout(() => createServer(handler).listen(Number(late)), Number(lateMs));
`;

describe.skipIf(!posix)('process sandboxes: what a reset touches, interrupts, identity (L1.8 review)', () => {
  let dir = '';
  const opened: Sandbox[] = [];
  const lines: string[] = [];
  const say = (level: string, msg: string) => lines.push(`${level} ${msg}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'demo-studio-sandbox-review-'));
    await writeFile(join(dir, 'svc.mjs'), SVC);
  });
  afterAll(async () => {
    for (const s of opened) await s.down().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  /** A sandbox of the small service (`app`) with these extra sandbox.yaml lines. */
  async function svcSandbox(name: string, command: string, service: string[], extra: string[] = []): Promise<{ sb: Sandbox; project: LoadedProject }> {
    const project = await makeProject(dir, name, ['version: 1', 'provider: process', 'services:', '  app:', `    command: ${command}`, ...service.map((l) => `    ${l}`), ...extra, ''].join('\n'));
    const s = openSandbox(project);
    opened.push(s);
    return { sb: s, project };
  }
  const svc = (...args: Array<number | string>) => `[node, ${JSON.stringify(join(dir, 'svc.mjs'))}, ${args.map((a) => JSON.stringify(String(a))).join(', ')}]`;
  const count = async (port: number) => (await fetch(`http://localhost:${port}/`)).json() as Promise<{ seeds: number; deletes: number }>;

  it('health: false still probes the pages, and a port bound late is waited for — never blamed on another program (P5)', async () => {
    const [a, b] = await freePorts(2);
    const { sb, project } = await svcSandbox('late', svc(a, b, 1200), [`url: http://localhost:${b}`, 'health: false', `pages: {app: "http://localhost:${a}"}`]);
    const t0 = Date.now();
    const r = await sb.up({ log: say });
    expect(r.started).toEqual(['app']);
    expect(Date.now() - t0).toBeGreaterThan(1000);
    // Identity once healthy: the boot time and the group's members (P2).
    const entry = readState(sandboxPaths(project.dir, 'sandbox').state, 'sandbox', 'process').state.services.app as { pid: number; boot?: number; members?: Array<{ pid: number }> };
    expect(entry.boot).toEqual(expect.any(Number));
    expect(entry.members?.map((m) => m.pid)).toContain(entry.pid);
    await sb.down();
    // A declared port nothing ever listens on: said as it is.
    const [c, d] = await freePorts(2);
    const never = (await svcSandbox('never', svc(c), [`url: http://localhost:${d}`, `health: {tcp: ${c}, timeout_s: 2}`, `pages: {app: "http://localhost:${c}"}`])).sb;
    const e = await never.up({ log: say }).catch((x) => x);
    expect(e).toMatchObject({ code: 'unhealthy' });
    expect(e.message).toContain(`service app: nothing listens on port ${d} (service app, url) after 2 s — is it the port the service listens on?`);
    expect(e.message).not.toContain("another user's program");
  });

  it('a restarted process service drops the seed record: up --no-seed, then up seeds again (P7)', async () => {
    const [a] = await freePorts(1);
    const { sb, project } = await svcSandbox('noseed', svc(a), [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`], ['seed:', '  - http: {method: POST, url: "{{app}}/seed"}']);
    await sb.up({ log: say });
    expect((await sb.status()).seed?.current).toBe(true);
    const pid = (await sb.status()).services[0].pid!;
    process.kill(-pid, 'SIGKILL');
    for (let i = 0; i < 50 && signalState(-pid) === 'alive'; i++) await sleep(50);
    const r = await sb.up({ log: say, seed: 'never' });
    expect(r.started).toEqual(['app']);
    expect(readState(sandboxPaths(project.dir, 'sandbox').state, 'sandbox', 'process').state.seed).toBeUndefined();
    expect((await sb.status()).seed).toBeUndefined();
    expect((await count(a)).seeds).toBe(0);
    lines.length = 0;
    const again = await sb.up({ log: say });
    expect(again.reset).toBeDefined();
    expect(lines).toContain('info seeding sandbox sandbox (never seeded)');
    expect((await count(a)).seeds).toBe(1);
  });

  it("the mailbox a reset empties must be the sandbox's own — or `external: true` (I4)", async () => {
    let deleted = 0;
    const other = createHttpServer((req, res) => {
      if (req.method === 'DELETE') deleted++;
      res.end('{}');
    });
    await new Promise<void>((r) => other.listen(0, () => r()));
    const foreign = (other.address() as { port: number }).port;
    try {
      const [a] = await freePorts(1);
      const svcLines = [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`];
      const seed = ['seed:', '  - http: {method: POST, url: "{{app}}/seed"}'];
      const { sb } = await svcSandbox('mailforeign', svc(a), svcLines, [...seed, `mailbox: {provider: mailpit, url: "http://localhost:${foreign}"}`]);
      await sb.up({ log: say, seed: 'never' });
      const e = await sb.reset({ log: say }).catch((x) => x);
      expect(e).toBeInstanceOf(SandboxError);
      expect(e.message).toBe(
        `sandbox sandbox: port ${foreign} (the mailbox http://localhost:${foreign}) is not a port of a service of this sandbox (its url, pages or health) — every reset empties it, so it must be the sandbox's own: serve it from the sandbox, add \`external: true\` to the mailbox in sandbox.yaml if it is the sandbox's alone, or \`clear: false\` to keep its messages`,
      );
      expect(deleted).toBe(0);
      expect((await count(a)).seeds).toBe(0); // refused before the seed
      await sb.down();
      const ext = (await svcSandbox('mailexternal', svc(a), svcLines, [...seed, `mailbox: {provider: mailpit, url: "http://localhost:${foreign}", external: true}`])).sb;
      expect((await ext.up({ log: say })).reset).toMatchObject({ mailbox: 'cleared' });
      expect(deleted).toBe(1);
      await ext.down();
      // Served by the sandbox's own service: emptied, nothing to acknowledge.
      const own = (await svcSandbox('mailown', svc(a), svcLines, [...seed, `mailbox: {provider: mailpit, url: "http://localhost:${a}"}`])).sb;
      expect((await own.up({ log: say })).reset).toMatchObject({ mailbox: 'cleared' });
      expect(await count(a)).toEqual({ seeds: 1, deletes: 1 });
      await own.down();
    } finally {
      other.close();
    }
  });

  it("a sql seed step's database must be served by the sandbox — or `external: true` (I4)", async () => {
    const [a, db] = await freePorts(2);
    const svcLines = [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`];
    const seed = ['seed:', '  - http: {method: POST, url: "{{app}}/seed"}', '  - sql: {query: "TRUNCATE quotes"}'];
    const { sb } = await svcSandbox('dbforeign', svc(a), svcLines, [...seed, 'databases:', `  main: {url: "postgres://demo:sandbox-db-4632@localhost:${db}/app"}`]);
    await sb.up({ log: say, seed: 'never' });
    const e = await sb.reset({ log: say }).catch((x) => x);
    expect(e).toMatchObject({ code: 'seed' });
    expect(e.message).toContain(`port ${db} (database main) is not a port of a service of this sandbox (its url, pages or health) — the seed rewrites it at every reset`);
    expect(e.message).toContain('add `external: true` to databases.main in sandbox.yaml');
    expect((await count(a)).seeds).toBe(0); // refused before any step
    await sb.down();
    const ext = (await svcSandbox('dbexternal', svc(a), svcLines, [...seed, 'databases:', `  main: {url: "postgres://demo:sandbox-db-4632@localhost:${db}/app", external: true}`])).sb;
    await ext.up({ log: say, seed: 'never' });
    const e2 = await ext.reset({ log: say }).catch((x) => x);
    expect(e2).toMatchObject({ code: 'seed' });
    expect(e2.message).toContain(`seed step 2/2 (sql "TRUNCATE quotes" on main (localhost:${db}/app)) failed: cannot connect to database main`);
    expect((await count(a)).seeds).toBe(1);
  });

  it('the pending rollbacks are superseded as soon as the seed ran, even when the reset fails after it (P9)', async () => {
    const [a, mail] = await freePorts(2);
    const { sb, project } = await svcSandbox('supersede', svc(a), [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`], [
      'seed:',
      '  - http: {method: POST, url: "{{app}}/seed"}',
      `mailbox: {provider: mailpit, url: "http://localhost:${mail}", external: true}`,
    ]);
    await sb.up({ log: say, seed: 'never' });
    const journal = await Journal.open(join(project.dir, '.demo-studio', 'journals', 'hooks-20261014-090000.json'));
    const at = new Date().toISOString();
    await journal.record({ kind: 'http', phase: 'setup', description: 'POST x', env: 'sandbox', started_at: at, finished_at: at, status: 'ok', rollback: { kind: 'http', request: { method: 'DELETE', url: `http://localhost:${a}/x` }, description: 'DELETE x', data: {} } });
    const e = await sb.reset({ log: say, by: 'p9 reset' }).catch((x) => x);
    expect(e.message).toMatch(new RegExp(`the mailbox could not be emptied \\(DELETE http://localhost:${mail}/api/v1/messages\\)`));
    expect((await count(a)).seeds).toBe(1);
    expect((await Journal.open(journal.file)).entries[0].superseded?.by).toBe('p9 reset');
  });

  it('Ctrl-C stops a running shell seed step and its group (exit 130); a second one kills it at once (P4)', async () => {
    const [a] = await freePorts(1);
    const svcLines = [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`];
    const { sb, project } = await svcSandbox('shellseed', svc(a), svcLines, ['seed:', "  - shell: 'sleep 30 & echo $! > child.pid; wait'"]);
    await sb.up({ log: say, seed: 'never' });
    const pidFile = join(project.dir, 'sandbox', 'child.pid');
    const childPid = async () => {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
      for (let i = 0; i < 20; i++) {
        const t = (await readFile(pidFile, 'utf8')).trim();
        if (t) return Number(t);
        await sleep(50);
      }
      return 0;
    };
    const ac = new AbortController();
    const reset = sb.reset({ log: say, signal: ac.signal }).catch((x) => x);
    const child = await childPid();
    expect(signalState(child)).toBe('alive');
    ac.abort();
    const e = await reset;
    expect(e).toMatchObject({ code: 'interrupted' });
    await sleep(200);
    expect(signalState(child)).not.toBe('alive');
    // A second Ctrl-C (killStartedSync) while the step runs: SIGKILL to its group at once.
    await rm(pidFile, { force: true });
    const again = sb.reset({ log: say }).catch((x) => x);
    const child2 = await childPid();
    expect(signalState(child2)).toBe('alive');
    sb.killStartedSync();
    await sleep(200);
    expect(signalState(child2)).not.toBe('alive');
    expect(await again).toMatchObject({ code: 'seed' });
  });

  it('the state entry is on disk before anything is awaited after the spawn: a crash then still leaves the service tracked (P6)', async () => {
    const [a] = await freePorts(1);
    const { project } = await svcSandbox('early', svc(a), [`url: http://localhost:${a}`, `pages: {app: "http://localhost:${a}"}`]);
    // A ps that takes 3 s to give a start time (the window the entry used to wait in), then leaves a marker named after
    // the pid it answered for: the service's entry must be on disk before its marker exists. (Not "while a marker made
    // when ps starts exists": the poll can read the entry between the save and the moment the shell running ps has
    // started — a race that failed loaded full suites. Another ps call before the spawn answers for another pid.)
    const bin = join(dir, 'slowbin');
    await mkdir(bin, { recursive: true });
    const answered = join(dir, 'ps-answered');
    await mkdir(answered, { recursive: true });
    await writeFile(join(bin, 'ps'), `#!/bin/sh\ncase "$*" in *lstart=*-p*) for a; do last=$a; done; sleep 3; touch ${JSON.stringify(answered)}/$last;; esac\nexec /bin/ps "$@"\n`, { mode: 0o755 });
    const script = [
      `import { loadProject } from ${JSON.stringify(join(REPO, 'packages/core/dist/index.js'))};`,
      `import { openSandbox } from ${JSON.stringify(join(REPO, 'packages/sandbox/dist/index.js'))};`,
      `await openSandbox(await loadProject(${JSON.stringify(project.dir)})).up({ seed: 'never' });`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
    const paths = sandboxPaths(project.dir, 'sandbox');
    let beforePsAnswered = false;
    let pid = 0;
    // Up to 15 s for the child to load and spawn (a loaded machine), polled every 50 ms.
    for (let i = 0; i < 300 && !pid; i++) {
      await sleep(50);
      const s = readState(paths.state, 'sandbox', 'process').state.services.app as { pid?: number } | undefined;
      if (s?.pid) {
        pid = s.pid;
        beforePsAnswered = !existsSync(join(answered, String(s.pid)));
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(beforePsAnswered).toBe(true);
    // The command dies in that window (kill -9): the service stays tracked, and down stops it.
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(signalState(-pid)).toBe('alive');
    const down = await openSandbox(project).down();
    expect(down.stopped).toEqual(['app']);
    expect(signalState(-pid)).not.toBe('alive');
  });
});
