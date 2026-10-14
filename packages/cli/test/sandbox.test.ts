/**
 * `studio sandbox …` and `studio run --sandbox` (L1.8) on the bundled fixture's own sandbox.yaml (the committed one,
 * moved to free ports and started with --no-build) and its `sandbox-quote` scenario (quick pacing): status / up /
 * logs / down, a run on the sandbox environment without --sandbox while it is down (refused) and while it is up (no
 * reset), two takes with --sandbox showing the same data though the sandbox was changed between them, the take lock,
 * the usage errors of --sandbox, and doctor's line. The studio home is a temp folder (DEMO_STUDIO_HOME). Skipped when
 * Chromium is not available.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import type { RunRecord } from '@demo-studio/core';
import { TakeLock, openSandbox, probePort, sandboxPaths } from '@demo-studio/sandbox';
import { EXIT, main, memoryIo } from '../src/index.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE_PROJECT = join(REPO, 'projects/northfield-fixture');
const PROJECT = 'northfield-sbx';

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

let ws = '';
let home = '';
let dir = '';
let ports: number[] = [];

async function studio(args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

/** The newest run of a scenario, with its record and text artefacts. */
async function lastRun(scenario: string): Promise<{ record: RunRecord; texts: Record<string, { value: string; text: string }>; dir: string }> {
  const runs = (await readdir(join(dir, 'runs'))).filter((r) => r.endsWith(`-${scenario}`)).sort();
  const runDir = join(dir, 'runs', runs[runs.length - 1]);
  const record = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunRecord;
  const texts: Record<string, { value: string; text: string }> = {};
  const tdir = join(runDir, 'artefacts', 'texts');
  if (existsSync(tdir)) {
    for (const f of await readdir(tdir)) {
      const t = JSON.parse(await readFile(join(tdir, f), 'utf8'));
      texts[f.replace(/\.json$/, '')] = { value: t.value, text: t.text };
    }
  }
  return { record, texts, dir: runDir };
}

const api = (path: string) => `http://localhost:${ports[0]}${path}`;

describe.skipIf(!chromiumAvailable())('studio sandbox and run --sandbox (the fixture, process provider)', () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'studio-sandbox-home-'));
    process.env.DEMO_STUDIO_HOME = home;
    const build = (await import(join(REPO, 'fixtures/wholesale/build.mjs'))) as { bundleState(): Promise<{ fresh: boolean }>; build(): Promise<unknown> };
    if (!(await build.bundleState()).fresh) await build.build();
    ports = await freePorts(4);
    ws = await mkdtemp(join(tmpdir(), 'studio-sandbox-'));
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    dir = join(ws, 'projects', PROJECT);
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(
      join(dir, 'project.yaml'),
      [
        'name: Northfield sandbox test',
        'environments:',
        '  local: {console: "http://localhost:9", shop: "http://localhost:9"}',
        'sandboxes:',
        '  sandbox: sandbox/sandbox.yaml',
        'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
        'template: default',
        '',
      ].join('\n'),
    );
    // The committed manifest, on free ports, without the bundle check (built above once: parallel forks would race).
    let manifest = await readFile(join(FIXTURE_PROJECT, 'sandbox', 'sandbox.yaml'), 'utf8');
    ['4501', '4502', '4503', '4504'].forEach((p, i) => (manifest = manifest.replaceAll(p, String(ports[i]))));
    manifest = manifest
      .replace('command: [node, server.mjs,', `command: [node, ${JSON.stringify(join(REPO, 'fixtures/wholesale/server.mjs'))}, --no-build,`)
      .replace(/\n\s+cwd: [^\n]+/, '');
    expect(manifest).toContain(`--no-build, --console-port, "${ports[0]}"`);
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), manifest);
    // The committed scenario, quicker.
    const scenario = (await readFile(join(FIXTURE_PROJECT, 'scenarios', 'sandbox-quote.yaml'), 'utf8')).replace(
      /^pacing: .*$/m,
      'pacing: {scene_start_still: 0.2, settle_ms: 300, hover_ms: 60, after_click_ms: 120, after_popup_ms: 250, after_navigation_ms: 300, move_min_ms: 120, move_max_ms: 300}',
    );
    expect(scenario).toContain('settle_ms: 300');
    await writeFile(join(dir, 'scenarios', 'sandbox-quote.yaml'), scenario);
  });

  afterAll(async () => {
    try {
      await openSandbox(await loadProject(dir)).down();
    } catch {
      /* not started */
    }
    delete process.env.DEMO_STUDIO_HOME;
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('down: status says so (exit 1), and a run on the sandbox environment without --sandbox is refused before anything runs', async () => {
    const st = await studio(['sandbox', 'status', PROJECT]);
    expect(st.code).toBe(EXIT.failure);
    expect(st.err).toMatch(/northfield-sbx sandbox sandbox · process · down/);
    expect(st.err).toContain('never seeded');
    expect(st.err).toContain(`→ studio sandbox up ${PROJECT}`);
    const json = await studio(['sandbox', 'status', PROJECT, '--json']);
    expect(JSON.parse(json.out)).toMatchObject({ project: PROJECT, env: 'sandbox', state: 'down', services: [{ name: 'fixture', state: 'stopped' }] });
    const run = await studio(['run', PROJECT, 'sandbox-quote']);
    expect(run.code).toBe(EXIT.failure);
    expect(run.err).toContain(`sandbox sandbox is not running (fixture is not running): studio sandbox up ${PROJECT} --env sandbox, or run with --sandbox`);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });

  it('up starts and seeds it; status --json and logs show it', async () => {
    const up = await studio(['sandbox', 'up', PROJECT]);
    expect(up.code).toBe(EXIT.ok);
    expect(up.err).toMatch(/services {2}started fixture · healthy 1\/1/);
    expect(up.err).toMatch(/seed {6}reseed \d+ ms · seed 1 step \(\d+ ms\) · mailbox emptied/);
    expect(up.err).toContain(`pages     console http://localhost:${ports[2]} (console.northfield.example) · shop http://localhost:${ports[3]} (shop.northfield.example)`);
    const st = await studio(['sandbox', 'status', PROJECT, '--json']);
    expect(st.code).toBe(EXIT.ok);
    expect(JSON.parse(st.out)).toMatchObject({ state: 'up', services: [{ name: 'fixture', state: 'running', healthy: true }], seed: { current: true } });
    const logs = await studio(['sandbox', 'logs', PROJECT, '--lines', '8']);
    expect(logs.code).toBe(EXIT.ok);
    expect(logs.out).toContain('Northfield fixture is running');
    expect((await studio(['sandbox', 'logs', PROJECT, 'nope'])).code).toBe(EXIT.usage);
  });

  it('two takes with --sandbox show the same data though the sandbox changed between them; without --sandbox, the next take does not', async () => {
    const take1 = await studio(['run', PROJECT, 'sandbox-quote', '--sandbox']);
    expect(take1.code, take1.err).toBe(EXIT.ok);
    expect(take1.err).toMatch(/sandbox sandbox \(process\) · running · healthy 1\/1 · reset reseed \d+ ms/);
    expect(take1.err).toMatch(/sandbox {3}sandbox \(process\) · reset \(reseed\) \d+ ms before the take · seed [0-9a-f]{12}/);
    const one = await lastRun('sandbox-quote');
    expect(one.record.status).toBe('succeeded');
    expect(one.record.environment?.sandbox).toEqual({ name: 'sandbox', provider: 'process', strategy: 'reseed', restored: false, reset_ms: expect.any(Number), seed_hash: expect.stringMatching(/^[0-9a-f]{12}$/), at: expect.any(String) });
    const timeline = JSON.parse(await readFile(join(one.dir, 'timeline.json'), 'utf8'));
    expect(timeline.environment).toMatchObject({ name: 'sandbox', sandbox: { name: 'sandbox', strategy: 'reseed' }, display: [{ page: 'console' }, { page: 'shop', display: 'https://shop.northfield.example' }] });
    expect(one.texts['new-quote'].value).toMatch(/^Q-\d+ · requested Today, 10:24$/);
    // The buyer signed in off camera by the sandbox account; its plain password (only typed, off camera) is in none of
    // the run's files. That it is masked wherever it would appear: runner-web auth.test.ts 'a sandbox account (L1.8)…'.
    const log = await readFile(join(one.dir, 'log.jsonl'), 'utf8');
    expect(log).toMatch(/persona buyer[^"]*: signed in automatically, off camera \([^"]*a sandbox account\)/);
    for (const f of ['log.jsonl', 'run.json', 'timeline.json']) expect(await readFile(join(one.dir, f), 'utf8')).not.toContain('filter-bloom-2026');

    // Someone uses the sandbox between two takes: a quote request.
    const posted = await fetch(api('/api/quotes'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_slug: 'selowa-ridge', bags: 3, bag_size: '5 kg', grind: 'Whole bean', label_language: 'Swedish', window_start: '2027-01-10', window_end: '2027-01-24' }),
    });
    expect(posted.status).toBe(201);

    const take2 = await studio(['run', PROJECT, 'sandbox-quote', '--sandbox']);
    expect(take2.code, take2.err).toBe(EXIT.ok);
    const two = await lastRun('sandbox-quote');
    expect(two.record.id).not.toBe(one.record.id);
    expect(two.texts).toEqual(one.texts);

    // The control: filmed as it is (no reset) — the list and the new reference move on.
    const take3 = await studio(['run', PROJECT, 'sandbox-quote', '--env', 'sandbox']);
    expect(take3.code, take3.err).toBe(EXIT.ok);
    expect(take3.err).toContain('sandbox sandbox: filmed as it is, without a reset (--sandbox resets it to its seed first)');
    expect(take3.err).toContain('sandbox (process) · no reset before the take (run without --sandbox)');
    const three = await lastRun('sandbox-quote');
    expect(three.record.environment?.sandbox).toEqual({ name: 'sandbox', provider: 'process' });
    expect(three.texts['latest-quote'].value).not.toBe(one.texts['latest-quote'].value);
    expect(three.texts['new-quote'].value).not.toBe(one.texts['new-quote'].value);
    // Every take frame folder of these test runs goes with the workspace.
  });

  it('a busy sandbox: run --sandbox and sandbox reset fail fast naming the holder; a run without --sandbox warns', async () => {
    const project = await loadProject(dir);
    const lock = TakeLock.acquire(sandboxPaths(project.dir, 'sandbox').lock, 'run other', 'sandbox');
    lock.note('20261014-101500-other');
    try {
      const run = await studio(['run', PROJECT, 'sandbox-quote', '--sandbox', '--dry']);
      expect(run.code).toBe(EXIT.failure);
      expect(run.err).toMatch(/sandbox sandbox is in use: run 20261014-101500-other \(pid \d+\) since \d\d:\d\d:\d\d — wait for it/);
      const reset = await studio(['sandbox', 'reset', PROJECT]);
      expect(reset.code).toBe(EXIT.failure);
      expect(reset.err).toContain('sandbox sandbox is in use: run 20261014-101500-other');
      const status = await studio(['sandbox', 'status', PROJECT]);
      expect(status.err).toMatch(/lock +in use: run 20261014-101500-other/);
      const dry = await studio(['run', PROJECT, 'sandbox-quote', '--dry', '--until', 'quotes.0']);
      expect(dry.code, dry.err).toBe(EXIT.ok);
      expect(dry.err).toContain('sandbox sandbox is in use by run 20261014-101500-other');
      // A scenario without `env:` waiting for an email only the sandbox's mailbox receives: --sandbox picks the sandbox
      // before validating it (I2) — it gets as far as the lock; without --sandbox (env local, no mailbox) it is refused.
      await writeFile(
        join(dir, 'scenarios', 'mail-wait.yaml'),
        'video: mail-wait\nscenes:\n  - id: a\n    page: shop\n    steps:\n      - wait_for_email: {to: orders@demo-cafe.example, subject: Confirm, timeout: 2, as: m}\n',
      );
      const mail = await studio(['run', PROJECT, 'mail-wait', '--sandbox', '--dry']);
      expect(mail.code).toBe(EXIT.failure);
      expect(mail.err).toContain('sandbox sandbox is in use: run 20261014-101500-other');
      expect((await studio(['validate', PROJECT, 'mail-wait'])).code).not.toBe(EXIT.ok);
    } finally {
      lock.releaseSync();
    }
    const reset = await studio(['sandbox', 'reset', PROJECT]);
    expect(reset.code).toBe(EXIT.ok);
    expect(reset.err).toMatch(/northfield-sbx sandbox sandbox reset: reseed \d+ ms · seed 1 step \(\d+ ms\) · mailbox emptied/);
  });

  it('auth status: a sandbox account signs in automatically — never a "studio login" hint, never a failure (I9)', async () => {
    const st = await studio(['auth', 'status', '--project', PROJECT]);
    expect(st.code).toBe(EXIT.ok);
    expect(st.out).toMatch(/ {2}supplier {2}auto {6}sandbox account: a take signs it in automatically whenever its session is missing \(its login steps, off camera\)\n/);
    expect(st.out).not.toContain('studio login');
    const json = JSON.parse((await studio(['auth', 'status', '--project', PROJECT, '--json'])).out) as { personas: Array<{ persona: string; sandbox?: boolean; status: string }> };
    expect(json.personas.find((p) => p.persona === 'supplier')).toMatchObject({ status: 'never', sandbox: true });
  });

  it('--sandbox: an environment that is not a sandbox, or a project without one, is a usage error', async () => {
    const env = await studio(['run', PROJECT, 'sandbox-quote', '--sandbox', '--env', 'local']);
    expect(env.code).toBe(EXIT.usage);
    expect(env.err).toContain('--sandbox resets a sandbox before the take: environment local is not a sandbox (sandboxes: sandbox)');
    const none = join(ws, 'projects', 'plain');
    await mkdir(join(none, 'scenarios'), { recursive: true });
    await writeFile(join(none, 'project.yaml'), 'name: Plain\nenvironments:\n  local: {app: "http://localhost:9"}\n');
    await writeFile(join(none, 'scenarios', 'one.yaml'), 'video: one\nscenes:\n  - id: a\n    page: app\n    steps: [{hold: 0.1}]\n');
    const plain = await studio(['run', 'plain', 'one', '--sandbox']);
    expect(plain.code).toBe(EXIT.usage);
    expect(plain.err).toContain('--sandbox resets a sandbox before the take, and project plain has none');
    expect((await studio(['sandbox', 'status', 'plain'])).err).toContain('project plain has no sandbox');
    expect((await studio(['sandbox', 'up', PROJECT, '--env', 'local'])).code).toBe(EXIT.usage);
  });

  it('doctor: one line for the sandbox (no line for its accounts, nor for its pages)', async () => {
    const { doctorChecks, systemProbes } = await import('../src/commands/doctor.js');
    const { loadWorkspaceConfig } = await import('@demo-studio/core');
    const probes = { ...systemProbes(), head: async () => ({ status: 200, ms: 1 }) };
    const checks = (await doctorChecks(probes, await loadWorkspaceConfig(ws), { project: PROJECT })).filter((c) => /Sandbox|Persona|Host/.test(c.name));
    expect(checks).toEqual([
      { status: 'ok', name: 'Sandbox sandbox', detail: expect.stringMatching(/^process · up, its service is healthy · seed [0-9a-f]{12}$/) },
      { status: 'ok', name: 'Host local·console', detail: expect.any(String) },
      { status: 'ok', name: 'Host local·shop', detail: expect.any(String) },
    ]);
  });

  it('down stops it: its ports are free; doctor then says how to start it', async () => {
    const down = await studio(['sandbox', 'down', PROJECT]);
    expect(down.code).toBe(EXIT.ok);
    expect(down.err).toContain(`${PROJECT} sandbox sandbox stopped: fixture`);
    for (const p of ports) expect(await probePort(p)).toBe(false);
    expect((await studio(['sandbox', 'down', PROJECT])).err).toContain('was not running');
    const { doctorChecks, systemProbes } = await import('../src/commands/doctor.js');
    const { loadWorkspaceConfig } = await import('@demo-studio/core');
    const checks = await doctorChecks({ ...systemProbes(), head: async () => ({ status: 200, ms: 1 }) }, await loadWorkspaceConfig(ws), { project: PROJECT });
    expect(checks.find((c) => c.name === 'Sandbox sandbox')).toEqual({
      status: 'warn',
      name: 'Sandbox sandbox',
      detail: 'process · not running',
      hint: `studio sandbox up ${PROJECT} (studio run … --sandbox starts it too)`,
    });
  });
});

describe('studio sandbox init and the docker-compose flags (L1.8 part C, no Docker needed)', () => {
  let iws = '';

  async function cli(args: string[]) {
    const io = memoryIo();
    const code = await main(['node', 'studio', '--root', iws, ...args], io);
    return { code, out: io.stdout(), err: io.stderr() };
  }

  beforeAll(async () => {
    iws = await mkdtemp(join(tmpdir(), 'studio-sandbox-init-'));
    await writeFile(join(iws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    await mkdir(join(iws, 'projects', 'shop', 'scenarios'), { recursive: true });
    await writeFile(join(iws, 'projects', 'shop', 'project.yaml'), '# The shop.\nname: Shop\nenvironments:\n  local: {app: "http://localhost:9"}   # the dev server\ntemplate: default\n');
  });
  afterAll(async () => {
    await rm(iws, { recursive: true, force: true });
  });

  it('init writes a docker-compose sandbox that validates, adds it to project.yaml in place, and refuses to write over it', async () => {
    const r = await cli(['sandbox', 'init', 'shop', '--json']);
    expect(r.code, r.err).toBe(EXIT.ok);
    const res = JSON.parse(r.out) as { env: string; dir: string; ports: { app: number; db: number; mailpit: number }; projectYaml: string; warnings: unknown[] };
    expect(res).toMatchObject({ env: 'sandbox', projectYaml: 'added', warnings: [] });
    expect(res.ports.app).toBeGreaterThanOrEqual(4600);
    const yaml = await readFile(join(iws, 'projects', 'shop', 'project.yaml'), 'utf8');
    expect(yaml).toBe('# The shop.\nname: Shop\nenvironments:\n  local: {app: "http://localhost:9"}   # the dev server\ntemplate: default\nsandboxes:\n  sandbox: sandbox/sandbox.yaml\n');
    for (const f of ['sandbox.yaml', 'compose.yaml', 'README.md', 'app/index.html', 'seed/01-demo-data.sql']) expect(existsSync(join(res.dir, f))).toBe(true);
    const v = await cli(['validate', 'shop']);
    expect(v.code, v.err).toBe(EXIT.ok);
    expect(v.err).toMatch(/✓ sandbox sandbox .*sandbox\/sandbox\.yaml/);
    const again = await cli(['sandbox', 'init', 'shop']);
    expect(again.code).toBe(EXIT.usage);
    expect(again.err).toMatch(/sandbox sandbox already exists \(sandbox\/sandbox\.yaml\): --force writes the scaffold over its files/);
    const text = await cli(['sandbox', 'init', 'shop', '--env', 'demo']);
    expect(text.code, text.err).toBe(EXIT.ok);
    expect(text.err).toMatch(/sandbox demo scaffolded — try it: studio sandbox up shop --env demo/);
    expect(text.err).toMatch(/ports +app \d+ · Postgres \d+ · Mailpit \d+ \(127\.0\.0\.1\)/);
  });

  it('--build, --volumes and --follow are for docker-compose sandboxes: usage errors on a process one, before anything runs', async () => {
    const dir = join(iws, 'projects', 'proc');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), 'name: Proc\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {sandbox: sandbox/sandbox.yaml}\n');
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: process\nservices:\n  app: {command: [node, -e, "0"], url: "http://localhost:9", pages: {app: "http://localhost:9"}}\n');
    const build = await cli(['sandbox', 'up', 'proc', '--build']);
    expect(build.code).toBe(EXIT.usage);
    expect(build.err).toMatch(/--build is for docker-compose sandboxes: sandbox sandbox is provider process/);
    expect((await cli(['sandbox', 'down', 'proc', '--volumes'])).err).toMatch(/--volumes is for docker-compose sandboxes/);
    expect((await cli(['sandbox', 'logs', 'proc', '--follow'])).err).toMatch(/--follow is for docker-compose sandboxes: .*tail -f .*<service>\.log/);
    expect(existsSync(join(dir, '.demo-studio'))).toBe(false);
  });
});
