/**
 * L3.1 part D: `auth_login` and `sandbox_up` / `sandbox_reset` jobs run by the worker in a process of its own. A sign-in
 * (`auto`: the persona's login steps against the fixture's signed-in side) saves a session the next status sees, and
 * its result carries no path or cookie; sandbox jobs start, seed and reset a small process sandbox, and its shell seed
 * step runs only with a human approval of its fingerprint (trust `mcp`), taken at submit — a job queued without one
 * fails before the seed changes anything it should not. Plus the job history (history.jsonl) and the usage counters.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import { hookFingerprint } from '@demo-studio/hooks';
import { openSandbox } from '@demo-studio/sandbox';
import { EngineError, FileJobQueue, createEngine, historyFile, seedApprovalItems } from '../src/index.js';
import type { ApprovalRequest, Approver, Engine, JobRecord } from '../src/index.js';
import { REPO } from './helpers.js';

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const posix = process.platform !== 'win32';

interface Fixture {
  urls: { console: string; shop: string; signedIn: { console: string; shop: string } };
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

/** A tiny service: GET /health → 200. */
const SERVICE = `import { createServer } from 'node:http';
createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok'); }).listen(Number(process.argv[2]), '127.0.0.1');
`;

let ws: string;
let home: string;
let savedHome: string | undefined;
let port: number;
let fixture: Fixture | undefined;
let accounts: Record<'supplier' | 'buyer', { email: string; password: string; name: string }>;
let engine: Engine;
let queue: FileJobQueue;
const children: ChildProcess[] = [];

function startWorker(env: NodeJS.ProcessEnv = {}): { exited: Promise<number | null>; err(): string; out(): string } {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(REPO, 'packages/engine/src/worker-main.ts'), '--root', ws, '--idle-exit', '600'], {
    cwd: REPO,
    env: { ...process.env, DEMO_STUDIO_HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  return { exited: new Promise((r) => child.on('exit', (code) => r(code))), err: () => err, out: () => out };
}

/** A test approver: says yes (or no) and records what it was asked. */
function approver(answer: boolean, asked: ApprovalRequest[]): Approver {
  return { approve: async (req) => (asked.push(req), answer ? { approved: true } : { approved: false, reason: 'declined' }) };
}

async function finished(id: string): Promise<JobRecord> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const j = await queue.get(id);
    if (j && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) return j;
    if (Date.now() > deadline) throw new Error(`job ${id} did not finish: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe.skipIf(!posix)('sign-in and sandbox jobs (worker in its own process)', () => {
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'studio-jobs-d-'));
    home = join(ws, '.home');
    // The worker saves sessions in its DEMO_STUDIO_HOME; this process reads them from the same one.
    savedHome = process.env.DEMO_STUDIO_HOME;
    process.env.DEMO_STUDIO_HOME = home;
    port = await freePort();
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const dir = join(ws, 'projects', 's');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(join(dir, 'sandbox', 'service.mjs'), SERVICE);
    await writeFile(
      join(dir, 'sandbox', 'sandbox.yaml'),
      [
        'version: 1',
        'provider: process',
        'services:',
        '  app:',
        `    command: [node, service.mjs, "${port}"]`,
        `    url: http://localhost:${port}`,
        '    health: /health',
        '    stop_timeout_s: 3',
        '    pages:',
        `      app: {url: "http://localhost:${port}", display: app.example}`,
        'seed:',
        '  - name: ping',
        '    http: {url: "{{app}}/health"}',
        '  - name: mark',
        '    shell: {run: "echo seeded >> seed-marker.txt"}',
        '',
      ].join('\n'),
    );
    if (chromiumAvailable()) {
      const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: object): Promise<Fixture> };
      fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', auth: { consolePort: 0, shopPort: 0 } });
      accounts = ((await import(join(REPO, 'fixtures/wholesale/server/auth.mjs'))) as { ACCOUNTS: typeof accounts }).ACCOUNTS;
    }
    await writeFile(
      join(dir, 'project.yaml'),
      [
        'name: S',
        'environments:',
        `  local: {app: "http://localhost:${port}"}`,
        ...(fixture ? [`  signed-in: {console: "${fixture.urls.signedIn.console}", admin: "${fixture.urls.signedIn.console}"}`] : []),
        'sandboxes:',
        '  sandbox: sandbox/sandbox.yaml',
        'default_env: local',
        ...(fixture
          ? [
              'auth:',
              '  signed-in:',
              '    login_url: /sign-in',
              '    personas:',
              '      supplier:',
              '        pages: [console]',
              `        check: {url: "console:/products", expect_text: ${accounts.supplier.name}}`,
              '        login:',
              '          - open: "console:/sign-in"',
              `          - type: {into: {label: Email}, text: ${accounts.supplier.email}}`,
              '          - type: {into: {label: Password}, text: "{{env:NF_JOB_SUPPLIER}}"}',
              '          - click: {role: button, name: Sign in}',
              `          - wait_for: {text: ${accounts.supplier.name}}`,
              `      viewer: {pages: [admin], check: {url: "admin:/products", expect_text: ${accounts.supplier.name}}}`,
            ]
          : []),
        'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
        'template: default',
        '',
      ].join('\n'),
    );
    engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    queue = new FileJobQueue(ws);
  });

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    try {
      await openSandbox(await loadProject('s', ws)).down();
    } catch {
      /* never started */
    }
    await fixture?.close();
    if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
    else process.env.DEMO_STUDIO_HOME = savedHome;
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('sandbox_up: a shell seed step needs a human — no approver: needs_approval with the command; a decline: refused', async () => {
    const items = await seedApprovalItems(await loadProject('s', ws), 'sandbox');
    expect(items).toEqual([expect.objectContaining({ phase: 'seed', index: 1, name: 'mark', reason: 'a shell command (runs local code)' })]);
    const none = await engine.sandbox.up({ project: 's' }).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(EngineError);
    expect(none).toMatchObject({ code: 'needs_approval', fix: `studio -C ${ws} sandbox up s` });
    const asked: ApprovalRequest[] = [];
    const declined = await engine.sandbox.up({ project: 's' }, { approver: approver(false, asked) }).catch((e: unknown) => e);
    expect(declined).toMatchObject({ code: 'refused' });
    expect(asked[0]).toMatchObject({ project: 's', env: { name: 'sandbox', production: false }, items: [{ index: 1, description: expect.stringContaining('echo seeded') }] });
    expect(await queue.list({ project: 's' })).toEqual([]);
  });

  it('sandbox_up approved: started, seeded (the shell step ran); sandbox_reset seeds again; history counts them', async () => {
    const asked: ApprovalRequest[] = [];
    const up = await engine.sandbox.up({ project: 's' }, { approver: approver(true, asked) });
    const project = await loadProject('s', ws);
    const fp = hookFingerprint(project.sandboxes!.sandbox.manifest.seed![1] as never, { phase: 'seed', index: 1, env: 'sandbox' });
    expect(up.job.input).toMatchObject({ kind: 'sandbox_up', approvals: [{ fingerprint: fp, by: 'human-elicitation' }] });
    const w = startWorker();
    const job = await finished(up.job.id);
    expect(job.state, JSON.stringify(job)).toBe('succeeded');
    expect(job.result).toMatchObject({ kind: 'sandbox_up', env: 'sandbox', provider: 'process', services: { started: ['app'] }, reset: { strategy: 'reseed', seed: { steps: 2 } }, pages: { app: `http://localhost:${port}` } });
    expect(await readFile(join(project.dir, 'sandbox', 'seed-marker.txt'), 'utf8')).toBe('seeded\n');
    expect(await w.exited).toBe(0);
    expect(w.out()).toBe('');

    const reset = await engine.sandbox.reset({ project: 's', reseed: true }, { approver: approver(true, []) });
    expect(reset.job.input).toMatchObject({ kind: 'sandbox_reset', reseed: true });
    const w2 = startWorker();
    expect(await finished(reset.job.id)).toMatchObject({ state: 'succeeded', result: { kind: 'sandbox_reset', reset: { seed: { steps: 2 } } } });
    expect(await readFile(join(project.dir, 'sandbox', 'seed-marker.txt'), 'utf8')).toBe('seeded\nseeded\n');
    await w2.exited;
    const lines = (await readFile(historyFile(ws), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { job: string; kind: string; state: string });
    expect(lines.map((l) => [l.job, l.kind, l.state])).toEqual(expect.arrayContaining([[up.job.id, 'sandbox_up', 'succeeded'], [reset.job.id, 'sandbox_reset', 'succeeded']]));
  });

  it('a sandbox job queued without the approval (bypassing the submit): the shell seed step is refused, the job fails', async () => {
    const job = await queue.enqueue({ version: 1, kind: 'sandbox_reset', project: 's', reseed: true, submitted_by: 'test' });
    const w = startWorker();
    const done = await finished(job.id);
    expect(done.state).toBe('failed');
    expect(done.error?.message).toContain('without a human approval');
    await w.exited;
  });

  it.skipIf(!chromiumAvailable())('auth_login auto: the login steps sign the persona in; the result has no path or cookie; status sees it', async () => {
    const bad = await engine.auth.login({ project: 's', env: 'signed-in', persona: 'viewer', mode: 'auto' }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ code: 'invalid', message: expect.stringContaining('declares no login steps') });
    const several = await engine.auth.login({ project: 's', env: 'signed-in', mode: 'auto' }).catch((e: unknown) => e);
    expect(several).toMatchObject({ code: 'invalid', message: expect.stringContaining('pick one with persona supplier | viewer') });
    const sub = await engine.auth.login({ project: 's', env: 'signed-in', persona: 'supplier', mode: 'auto' });
    expect(sub).toMatchObject({ persona: 'supplier', env: 'signed-in' });
    expect(sub.job.input).toEqual({ version: 1, kind: 'auth_login', project: 's', env: 'signed-in', persona: 'supplier', mode: 'auto', submitted_by: 'test' });
    const w = startWorker({ NF_JOB_SUPPLIER: accounts.supplier.password });
    const job = await finished(sub.job.id);
    expect(job, JSON.stringify(job)).toMatchObject({ state: 'succeeded', result: { kind: 'auth_login', persona: 'supplier', status: 'valid', signed_in: true, command: `studio -C ${ws} login s --env signed-in --persona supplier --auto` } });
    const text = JSON.stringify(job) + JSON.stringify(await queue.events(sub.job.id));
    expect(text).not.toContain(home);
    expect(text).not.toContain(accounts.supplier.password);
    const status = await engine.auth.status({ project: 's', env: 'signed-in' });
    expect(status.personas.find((p) => p.persona === 'supplier')).toMatchObject({ status: 'valid', by: 'login' });
    await w.exited;
    expect(w.out()).toBe('');
    const killed = spawnSync('pgrep', ['-f', `${home}`]).stdout.toString().trim();
    expect(killed).toBe('');
  });

  it('usage counters read the history; entitlements are the internal stub', async () => {
    const usage = await engine.usage();
    expect(usage.entries).toBeGreaterThanOrEqual(3);
    expect(usage).toMatchObject({ captures: 0, renders: 0 });
    expect(engine.info().entitlements).toEqual({ tier: 'internal', features: 'all', limits: null });
    expect(engine.info().features).toEqual(expect.arrayContaining(['auth.login', 'sandbox.up', 'sandbox.reset', 'history']));
  });
});
