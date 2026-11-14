/**
 * The Sandboxes port (L7.25) on its contract (sandbox-contract.ts): the sandbox package's adapter (packageSandboxes)
 * with a process sandbox — two node services answering /health, an http and a shell seed step — and, with
 * RETAKE_TEST_DOCKER=1 and a running Docker holding busybox:1.38.0, with a docker-compose one (one busybox httpd, an
 * exec seed step; its compose project `retake-test-<token>-*`, removed after); and the in-memory sandboxes on a manifest
 * of each kind. Plus what only the fake or only the adapter says: the fake's calls and its refusal of a scaffold; the
 * adapter's handle is the package's Sandbox (the same refusals, the same class of error). And the engine's call sites
 * read the port they are handed: the MCP status answer (sandboxStatus) and the check of a sandbox environment.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, SandboxError } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { loadProject, probePort } from '@retake/core/io';
import { ManualClock } from '../src/clock.js';
import { MemorySandboxes } from '../src/sandboxes/memory-sandboxes.js';
import { packageSandboxes } from '../src/sandboxes/package-sandboxes.js';
import type { Sandboxes } from '../src/sandboxes/sandboxes.js';
import { checkSandboxEnv } from '../src/execute-run.js';
import { sandboxStatus } from '../src/sandbox.js';
import type { ProjectFolder } from '../src/store/store.js';
import { EngineError } from '../src/errors.js';
import { createEngine, enginePorts } from '../src/index.js';
import { sandboxContract } from './sandbox-contract.js';
import type { SandboxSubject } from './sandbox-contract.js';

const posix = process.platform !== 'win32';
const DOCKER = process.env.RETAKE_TEST_DOCKER === '1';
/** This run's compose project names: a token of its own, so a run never removes another's. */
const PREFIX = `retake-test-${randomBytes(3).toString('hex')}-`;

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    if (!(await probePort(port))) return port;
  }
}

const SERVICE = `import { createServer } from 'node:http';
createServer((req, res) => { console.log(req.method + ' ' + req.url); res.writeHead(req.url === '/health' ? 200 : 404); res.end('ok'); }).listen(Number(process.argv[2]), '127.0.0.1');
`;

/** A workspace folder with project `s` (one sandbox, `manifest`, plus `files` in its sandbox folder) and project `bare`. */
async function workspace(root: string, manifest: string, files: Record<string, string>, pages: string): Promise<{ project: LoadedProject; bare: LoadedProject }> {
  const dir = join(root, 's');
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'sandbox', name), text);
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest);
  await writeFile(join(dir, 'project.yaml'), ['name: S', 'environments:', `  local: {app: "${pages}"}`, 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', 'default_env: local', ''].join('\n'));
  const bareDir = join(root, 'bare');
  await mkdir(bareDir, { recursive: true });
  await writeFile(join(bareDir, 'project.yaml'), ['name: Bare', 'environments:', '  local: {app: "http://localhost:9"}', ''].join('\n'));
  return { project: await loadProject(dir), bare: await loadProject(bareDir) };
}

/** A process sandbox: services app and api (node, /health), an http and a shell seed step. */
async function processWorkspace(root: string): Promise<{ project: LoadedProject; bare: LoadedProject }> {
  const [a, b] = [await freePort(), await freePort()];
  const manifest = [
    'version: 1',
    'provider: process',
    'services:',
    '  app:',
    `    command: [node, service.mjs, "${a}"]`,
    `    url: http://localhost:${a}`,
    '    health: /health',
    '    stop_timeout_s: 3',
    `    pages: {app: "http://localhost:${a}"}`,
    '  api:',
    `    command: [node, service.mjs, "${b}"]`,
    `    url: http://localhost:${b}`,
    '    health: /health',
    '    stop_timeout_s: 3',
    'seed:',
    '  - name: ping',
    '    http: {url: "{{app}}/health"}',
    '  - name: mark',
    '    shell: {run: "echo seeded >> seed-marker.txt"}',
    '',
  ].join('\n');
  return workspace(root, manifest, { 'service.mjs': SERVICE }, `http://localhost:${a}`);
}

/** A docker-compose sandbox: one busybox httpd (`web`), an exec seed step. */
async function composeWorkspace(root: string, name: string): Promise<{ project: LoadedProject; bare: LoadedProject }> {
  const port = await freePort();
  const compose = [
    'services:',
    '  web:',
    '    image: busybox:1.38.0',
    '    init: true',
    '    command: ["httpd", "-f", "-v", "-p", "8080", "-h", "/etc"]',
    `    ports: ["127.0.0.1:${port}:8080"]`,
    '    healthcheck:',
    '      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]',
    '      interval: 1s',
    '      timeout: 2s',
    '      retries: 30',
    '',
  ].join('\n');
  const manifest = [
    'version: 1',
    'provider: docker-compose',
    `compose: {project: ${name}}`,
    'services:',
    `  web: {url: "http://localhost:${port}", health: {path: /hostname, timeout_s: 60}, pages: {web: "http://localhost:${port}"}}`,
    'seed:',
    '  - exec: {service: web, command: [touch, /tmp/seeded]}',
    '',
  ].join('\n');
  return workspace(root, manifest, { 'compose.yaml': compose }, `http://localhost:${port}`);
}

const roots: string[] = [];
async function scratch(tag: string): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), `retake-sandboxes-${tag}-`));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A subject whose workspace is made in beforeAll; afterAll stops what the real adapter left running. */
function subjectOf(
  name: string,
  kind: SandboxSubject['kind'],
  make: () => Promise<{ project: LoadedProject; bare: LoadedProject }>,
  sandboxes: () => Sandboxes,
  services: string[],
  seedSteps: number,
): () => SandboxSubject {
  let s: SandboxSubject | undefined;
  beforeAll(async () => {
    const { project, bare } = await make();
    s = { name, kind, sandboxes: sandboxes(), project, bare, services, seedSteps };
  }, 60_000);
  afterAll(async () => {
    if (!s) return;
    await (await s.sandboxes.open(s.project, undefined, PERSON_POLICY)).down({ volumes: true }).catch(() => undefined);
  }, 120_000);
  return () => s!;
}

describe('in-memory sandboxes, a process manifest', () => {
  sandboxContract(
    subjectOf(
      'memory process',
      'process',
      async () => processWorkspace(await scratch('mp')),
      () => new MemorySandboxes(),
      ['app', 'api'],
      2,
    ),
  );
});

describe('in-memory sandboxes, a docker-compose manifest', () => {
  sandboxContract(
    subjectOf(
      'memory compose',
      'docker-compose',
      async () => composeWorkspace(await scratch('mc'), `${PREFIX}memory`),
      () => new MemorySandboxes(),
      ['web'],
      1,
    ),
  );
});

describe.skipIf(!posix)('the sandbox package, a process sandbox', () => {
  sandboxContract(
    subjectOf(
      'package process',
      'process',
      async () => processWorkspace(await scratch('pp')),
      () => packageSandboxes(enginePorts().secrets),
      ['app', 'api'],
      2,
    ),
  );
});

describe.skipIf(!DOCKER)('the sandbox package, a docker-compose sandbox (RETAKE_TEST_DOCKER=1)', () => {
  afterAll(() => {
    // The compose projects of this run, whatever a failed case left.
    try {
      const listed = JSON.parse(execFileSync('docker', ['compose', 'ls', '-a', '--format', 'json'], { encoding: 'utf8' }) || '[]') as Array<{ Name: string }>;
      for (const p of listed) if (p.Name.startsWith(PREFIX)) execFileSync('docker', ['compose', '-p', p.Name, 'down', '--volumes', '--remove-orphans'], { stdio: 'ignore' });
    } catch {
      /* no docker left to ask */
    }
  }, 120_000);
  sandboxContract(
    subjectOf(
      'package compose',
      'docker-compose',
      async () => composeWorkspace(await scratch('pc'), `${PREFIX}package`),
      () => packageSandboxes(enginePorts().secrets),
      ['web'],
      1,
    ),
    240_000,
  );
});

describe('what each adapter says beyond the contract', () => {
  it('the in-memory sandboxes record their calls (no function, signal or progress among their options), and write no scaffold', async () => {
    const { project } = await processWorkspace(await scratch('calls'));
    const mem = new MemorySandboxes({ clock: new ManualClock('2026-11-12T08:00:00.000Z') });
    const sb = await mem.open(project, 'sandbox', PERSON_POLICY);
    const r = await sb.up({ seed: 'never', signal: new AbortController().signal, log: () => undefined });
    expect(r.reset).toBeUndefined();
    const reset = await sb.reset({ by: 'me' });
    expect(reset.at).toBe('2026-11-12T08:00:00.000Z');
    expect(mem.calls).toEqual([
      { op: 'open', env: 'sandbox' },
      { op: 'up', env: 'sandbox', opts: { seed: 'never' } },
      { op: 'reset', env: 'sandbox', opts: { by: 'me' } },
    ]);
    await expect(mem.init(project, { write: async () => undefined })).rejects.toBeInstanceOf(SandboxError);
  });

  it('an interrupted up stops what it started and says so (code interrupted), on the fake as the package does', async () => {
    // A signal aborted before up: nothing starts, in the words of the process provider (the fake said `… up: interrupted`
    // until this case ran on the package too).
    const adapters: Array<[string, Sandboxes]> = [['memory', new MemorySandboxes()], ...(posix ? ([['package', packageSandboxes(enginePorts().secrets)]] as Array<[string, Sandboxes]>) : [])];
    for (const [name, sandboxes] of adapters) {
      const { project } = await processWorkspace(await scratch(`abort-${name}`));
      const sb = await sandboxes.open(project, undefined, PERSON_POLICY);
      const ac = new AbortController();
      ac.abort();
      try {
        await expect(sb.up({ signal: ac.signal }), name).rejects.toMatchObject({ name: 'SandboxError', code: 'interrupted', message: 'sandbox sandbox: interrupted' });
        expect((await sb.status()).state, name).toBe('down');
        expect((await sb.status()).lock, name).toBeUndefined();
      } finally {
        await sb.down().catch(() => undefined);
      }
    }
  }, 60_000);

  it.skipIf(!posix)('the package adapter hands out the package Sandbox: its refusals are the package SandboxError, the class core exports', async () => {
    const { bare } = await processWorkspace(await scratch('class'));
    const sb = await import('@retake/sandbox');
    expect(sb.SandboxError).toBe(SandboxError);
    const err = await packageSandboxes(enginePorts().secrets)
      .open(bare, undefined, PERSON_POLICY)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(sb.SandboxError);
  });
});

describe('the engine reads sandboxes through the port it is handed', () => {
  it('sandboxStatus: the status answer of the handed port (an in-memory sandbox up, its paths as refs of the project)', async () => {
    const { project } = await processWorkspace(await scratch('status'));
    const mem = new MemorySandboxes();
    const folder = { refOf: (p: string) => relative(project.dir, p) } as unknown as ProjectFolder;
    expect(await sandboxStatus(project, undefined, PERSON_POLICY, folder, mem)).toMatchObject({
      project: 's',
      env: 'sandbox',
      provider: 'process',
      state: 'down',
      logs: '.retake/sandbox/sandbox/logs',
      file: 'sandbox/sandbox.yaml',
    });
    await (await mem.open(project, undefined, PERSON_POLICY)).up();
    const st = await sandboxStatus(project, 'sandbox', PERSON_POLICY, folder, mem);
    expect(st.state).toBe('up');
    expect(st.services).toEqual([
      { name: 'app', state: 'running', healthy: true },
      { name: 'api', state: 'running', healthy: true },
    ]);
    expect(st.seed).toMatchObject({ current: true });
    expect(mem.calls.filter((c) => c.op === 'status')).toHaveLength(2);
  });

  it('checkSandboxEnv: a sandbox environment must be up on the handed port; a take holding it is a warning; another environment asks nothing', async () => {
    const { project } = await processWorkspace(await scratch('check'));
    const mem = new MemorySandboxes();
    const notes: string[] = [];
    const note = (level: 'info' | 'warn', message: string) => void notes.push(`${level} ${message}`);
    await expect(checkSandboxEnv(project, 'sandbox', note, PERSON_POLICY, mem)).rejects.toMatchObject({ name: 'SandboxError', code: 'down' });
    const sb = await mem.open(project, 'sandbox', PERSON_POLICY);
    await sb.up();
    await checkSandboxEnv(project, 'sandbox', note, PERSON_POLICY, mem);
    expect(notes).toEqual(['info sandbox sandbox: filmed as it is, without a reset (--sandbox resets it to its seed first)']);
    const take = await sb.prepareTake({ command: 'run other' });
    notes.splice(0);
    await checkSandboxEnv(project, 'sandbox', note, PERSON_POLICY, mem);
    expect(notes[0]).toMatch(/^warn sandbox sandbox is in use by run other \(pid \d+\) since \d\d:\d\d:\d\d: this run films it as it is, while that command may reset it$/);
    await take.release();
    const before = mem.calls.length;
    await checkSandboxEnv(project, 'local', note, PERSON_POLICY, mem);
    expect(mem.calls.length).toBe(before);
  });

  it('the engine of a composition root reads its own port: status from it, and a sandbox job refused before it is queued (an EngineError of its kind)', async () => {
    const root = await scratch('engine');
    await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
    const { project } = await processWorkspace(join(root, 'projects'));
    const mem = new MemorySandboxes();
    const engine = await createEngine({ root, client: 'test', autoStartWorker: false, ports: { sandboxes: mem } });
    expect((await engine.sandbox.status('s')).state).toBe('down');
    await (await mem.open(project, undefined, PERSON_POLICY)).up();
    expect((await engine.sandbox.status('s', 'sandbox')).state).toBe('up');
    const err = await engine.sandbox.up({ project: 's', env: 'nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toMatchObject({ code: 'not_found', message: 'nope is not a sandbox of project s (sandboxes: sandbox)' });
    expect(mem.calls.map((c) => c.op)).toEqual(['open', 'status', 'open', 'up', 'open', 'status', 'open']);
  });
});
