/**
 * docker-compose sandboxes for real (L1.8 part C), gated by DEMO_STUDIO_TEST_DOCKER=1 (a running Docker with the
 * images busybox:1.38.0, postgres:17-alpine and axllent/mailpit present). Every compose project and container of a
 * run is named `demo-studio-test-<run token>-*` and removed after (containers, networks, volumes, images it built):
 * another run at the same time (another worktree) and packages/cli/test/sandbox-docker.test.ts keep theirs; shared
 * base images are left alone.
 *
 * - the `studio sandbox init` scaffold (app placeholder, Postgres, Mailpit) with an `exec` seed step and `reset.restart:
 *   [app]`: up (seed + snapshot taken), status, a mutation, reset (snapshot restored, the rows back, the app restarted
 *   and healthy again), reset --reseed (taken again), a
 *   take prepared (prepareTake, snapshot strategy), a seed change making the snapshot stale, logs, down --volumes
 *   leaving nothing with the project's label (times logged, never asserted);
 * - a service whose health stays "starting": up fails with its state, whatever `--wait` exits with;
 * - a published port another program holds: refused before up (nothing created), and, when the platform lets a
 *   program bind the wildcard address next to Docker's 127.0.0.1, refused after up;
 * - another checkout sharing the compose project name is refused by every command, and another container publishing
 *   the sandbox's port on [::1] (OrbStack allows it next to 127.0.0.1) is refused by up (K2, K3).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@demo-studio/core';
import type { LoadedProject } from '@demo-studio/core';
import { SandboxError, dockerEnv, findDocker, initSandbox, openSandbox, probePort } from '@demo-studio/sandbox';
import type { SandboxLog } from '@demo-studio/sandbox';

const ENABLED = process.env.DEMO_STUDIO_TEST_DOCKER === '1';
const DOCKER = findDocker() ?? 'docker';
/** This run's names: a token of its own, so a run never removes another's (another worktree, sandbox-docker.test.ts). */
const PREFIX = `demo-studio-test-${randomBytes(3).toString('hex')}-`;
const ours = (name: string) => name.startsWith(PREFIX);
const require = createRequire(import.meta.url);

function docker(args: string[]): string {
  return execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
}

/** Names of this test's resources (by the compose project label) of one kind. */
function labelled(kind: 'container' | 'volume' | 'network', project: string): string[] {
  const args = kind === 'container' ? ['ps', '-a'] : [kind, 'ls'];
  return docker([...args, '--filter', `label=com.docker.compose.project=${project}`, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Remove this run's compose projects (containers, networks, volumes, the images they built) and its other containers. */
function sweep(): void {
  const projects = new Set<string>();
  for (const p of JSON.parse(docker(['compose', 'ls', '-a', '--format', 'json']) || '[]') as Array<{ Name: string }>) if (ours(p.Name)) projects.add(p.Name);
  for (const kind of ['volume', 'network'] as const) {
    for (const line of docker([kind, 'ls', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}']).split('\n')) {
      if (ours(line.trim())) projects.add(line.trim());
    }
  }
  for (const p of projects) {
    docker(['compose', '-p', p, 'down', '--volumes', '--rmi', 'local', '--remove-orphans']);
    for (const v of labelled('volume', p)) docker(['volume', 'rm', '-f', v]);
    for (const n of labelled('network', p)) docker(['network', 'rm', n]);
  }
  // Containers started outside compose (the K3 intruder).
  for (const c of docker(['ps', '-a', '--filter', `name=^${PREFIX}`, '--format', '{{.Names}}']).split('\n')) if (ours(c.trim())) docker(['rm', '-f', c.trim()]);
}

let tmp = '';
const logs: string[] = [];
const log: SandboxLog = (level, message) => logs.push(`${level}: ${message}`);

beforeAll(async () => {
  if (!ENABLED) return;
  tmp = await mkdtemp(join(tmpdir(), 'demo-studio-compose-'));
});
afterAll(async () => {
  if (!ENABLED) return;
  sweep();
  await rm(tmp, { recursive: true, force: true });
});

/** A base port with `n` free ports after it, away from the usual ones (46xx, 45xx stay a developer's). */
async function freeBase(n: number): Promise<number> {
  for (;;) {
    const base = 47_000 + Math.floor(Math.random() * 1800);
    let free = true;
    for (let p = base; p < base + n; p++) if (await probePort(p)) free = false;
    if (free) return base;
  }
}

const rand = () => randomBytes(3).toString('hex');

async function newProject(slug: string): Promise<string> {
  const dir = join(tmp, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Compose sandbox test', 'environments:', '  local: {app: "http://localhost:9"}', ''].join('\n'));
  return dir;
}

/** A pg query on a database URL. */
async function query(url: string, sql: string): Promise<Array<Record<string, unknown>>> {
  const pg = require('pg') as typeof import('pg');
  const c = new pg.Client({ connectionString: url });
  c.on('error', () => undefined);
  await c.connect();
  try {
    return (await c.query(sql)).rows as Array<Record<string, unknown>>;
  } finally {
    await c.end();
  }
}

/** A one-service compose sandbox (busybox httpd on `port`), its healthcheck given. */
async function webSandbox(slug: string, project: string, port: number, healthcheck: string[], timeoutS: number): Promise<LoadedProject> {
  const dir = await newProject(slug);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(
    join(dir, 'sandbox', 'compose.yaml'),
    [
      'services:',
      '  web:',
      '    image: busybox:1.38.0',
      '    init: true',
      '    command: ["httpd", "-f", "-p", "8080", "-h", "/etc"]',
      `    ports: ["127.0.0.1:${port}:8080"]`,
      '    healthcheck:',
      ...healthcheck.map((l) => `      ${l}`),
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: docker-compose',
      `compose: {project: ${project}}`,
      'services:',
      `  web: {url: "http://localhost:${port}", health: {path: /hostname, timeout_s: ${timeoutS}}, pages: {web: "http://localhost:${port}"}}`,
      '',
    ].join('\n'),
  );
  await writeFile(join(dir, 'project.yaml'), ['name: Compose sandbox test', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
  return loadProject(dir);
}

describe.skipIf(!ENABLED)('docker-compose sandboxes for real (DEMO_STUDIO_TEST_DOCKER=1)', () => {
  it('the init scaffold: up seeds and takes a snapshot, reset restores it, --reseed retakes it, a take restores it, a seed change makes it stale, down --volumes leaves nothing', async () => {
    const name = `${PREFIX}scaffold-${rand()}`;
    const dir = await newProject('scaffold');
    const res = await initSandbox(await loadProject(dir), { basePort: await freeBase(3) });
    const manifest = (await readFile(res.manifest, 'utf8'))
      .replace('  files: [compose.yaml]', `  files: [compose.yaml]\n  project: ${name}`)
      .replace('  # restart: [app]', '  restart: [app]')
      .replace(
        '  # Your application',
        `  - exec: {service: db, command: [psql, -U, demo, -d, app, -v, ON_ERROR_STOP=1, -c, "INSERT INTO demo_customers (name, city) VALUES ('Exec Seeded Shop', 'Testville')"]}\n  # Your application`,
      );
    await writeFile(res.manifest, manifest);
    const project = await loadProject(dir);
    expect(project.sandboxes!.sandbox.issues).toEqual([]);
    const sb = openSandbox(project);
    const url = `postgres://demo:pg-sandbox-${res.ports.db}@localhost:${res.ports.db}/app`;
    const count = async () => Number((await query(url, 'SELECT count(*) AS n FROM demo_customers'))[0].n);
    const times: string[] = [];

    const up = await sb.up({ log });
    expect(up.started.sort()).toEqual(['app', 'db', 'mailpit']);
    expect(up.reset).toMatchObject({ strategy: 'snapshot', restored: false, seed: { steps: 2 }, snapshot: { action: 'taken', database: 'app' }, mailbox: 'cleared' });
    times.push(`up ${up.ms} ms, seed ${up.reset!.seed.ms} ms, snapshot taken ${up.reset!.snapshot!.ms} ms`);
    expect(await count()).toBe(6);
    const st = await sb.status();
    expect(st.state).toBe('up');
    expect(st.services.map((s) => [s.name, s.state, s.healthy])).toEqual([
      ['app', 'running', true],
      ['db', 'running', true],
      ['mailpit', 'running', true],
    ]);
    expect(st.seed?.current).toBe(true);

    await query(url, "INSERT INTO demo_customers (name, city) VALUES ('Mutation Market', 'Elsewhere')");
    expect(await count()).toBe(7);
    const r1 = await sb.reset({ log });
    expect(r1).toMatchObject({ strategy: 'snapshot', restored: true, snapshot: { action: 'restored' }, seed: { steps: 0 }, restarted: ['app'] });
    times.push(`reset (restore) ${r1.ms} ms, restore ${r1.snapshot!.ms} ms`);
    expect(await count()).toBe(6);
    expect((await query(url, "SELECT nextval('demo_customers_id_seq') AS v"))[0].v).toBe('7');

    const r2 = await sb.reset({ log, reseed: true });
    expect(r2).toMatchObject({ restored: false, seed: { steps: 2 }, snapshot: { action: 'taken' } });
    times.push(`reset --reseed ${r2.ms} ms (seed ${r2.seed.ms} ms, snapshot taken ${r2.snapshot!.ms} ms)`);

    await query(url, 'DELETE FROM demo_customers');
    const take = await sb.prepareTake({ log, command: 'run compose-test' });
    try {
      expect(take.info).toMatchObject({ name: 'sandbox', provider: 'docker-compose', strategy: 'snapshot', restored: true });
      expect(take.up.started).toEqual([]);
      times.push(`prepareTake ${take.reset.ms} ms (restore ${take.reset.snapshot!.ms} ms)`);
      expect(await count()).toBe(6);
    } finally {
      await take.release();
    }

    // A seed change (a file of seed/) makes the snapshot stale: the seed runs and the snapshot is taken again.
    const seedFile = join(res.dir, 'seed', '01-demo-data.sql');
    await writeFile(seedFile, `${await readFile(seedFile, 'utf8')}INSERT INTO demo_customers (name, city) VALUES ('Late Addition', 'Riverton');\n`);
    const changed = openSandbox(await loadProject(dir));
    expect((await changed.status()).seed?.current).toBe(false);
    const r3 = await changed.reset({ log });
    expect(r3).toMatchObject({ restored: false, snapshot: { action: 'taken' } });
    expect(await count()).toBe(7);
    const tpl = await query(url.replace(/\/app$/, '/postgres'), "SELECT shobj_description(oid, 'pg_database') AS c, datistemplate AS t, datallowconn AS a FROM pg_database WHERE datname = 'app__ds_snapshot'");
    expect(tpl).toEqual([{ c: `demo-studio snapshot ${r3.hash}`, t: true, a: false }]);

    const dbLogs = await changed.logs({ service: 'db', lines: 5 });
    expect(dbLogs[0].source).toBe(`docker compose -p ${name} logs db`);
    expect(dbLogs[0].text.length).toBeGreaterThan(0);

    const down = await changed.down({ log, volumes: true });
    expect(down.dataGone).toBe(true);
    expect(down.stopped.sort()).toEqual(['app', 'db', 'mailpit']);
    expect(labelled('container', name)).toEqual([]);
    expect(labelled('volume', name)).toEqual([]);
    expect(labelled('network', name)).toEqual([]);
    expect((await changed.status()).state).toBe('down');
    console.log(`[compose scaffold] ${times.join(' · ')}`);
  });

  it('an interrupted restore — the database dropped, or its connections blocked — is repaired by up and by a take (K4)', async () => {
    const name = `${PREFIX}repair-${rand()}`;
    const dir = await newProject('repair');
    const res = await initSandbox(await loadProject(dir), { basePort: await freeBase(3) });
    await writeFile(res.manifest, (await readFile(res.manifest, 'utf8')).replace('  files: [compose.yaml]', `  files: [compose.yaml]\n  project: ${name}`));
    const sb = openSandbox(await loadProject(dir));
    const url = `postgres://demo:pg-sandbox-${res.ports.db}@localhost:${res.ports.db}/app`;
    const admin = url.replace(/\/app$/, '/postgres');
    const count = async () => Number((await query(url, 'SELECT count(*) AS n FROM demo_customers'))[0].n);
    try {
      expect((await sb.up({ log })).reset).toMatchObject({ snapshot: { action: 'taken' } });
      expect(await count()).toBe(5);
      // DROP done, CREATE not: the server answers, the database is missing — up waits for the server, then restores it.
      await query(admin, 'DROP DATABASE app WITH (FORCE)');
      logs.length = 0;
      const t0 = Date.now();
      const up = await sb.up({ log });
      expect(Date.now() - t0).toBeLessThan(60_000);
      expect(up.reset).toMatchObject({ restored: true, snapshot: { action: 'restored' } });
      expect(logs).toContain('info: seeding sandbox sandbox (database app is missing (an interrupted restore))');
      expect(await count()).toBe(5);
      // Connections blocked (ALLOW_CONNECTIONS false): up repairs and restores, and so does a take.
      await query(admin, 'ALTER DATABASE app WITH ALLOW_CONNECTIONS false');
      expect((await sb.up({ log })).reset).toMatchObject({ restored: true });
      expect(await count()).toBe(5);
      await query(admin, 'ALTER DATABASE app WITH ALLOW_CONNECTIONS false');
      const take = await sb.prepareTake({ log, command: 'run repair-test' });
      await take.release();
      expect(take.reset).toMatchObject({ restored: true });
      expect(logs).toContain('info: sandbox sandbox: database app accepted no connections (an interrupted reset): repaired');
      expect(await count()).toBe(5);
    } finally {
      await sb.down({ volumes: true });
    }
    expect(labelled('container', name)).toEqual([]);
  });

  it('an exec seed step interrupted or past its timeout is stopped inside its container, not only the docker client (K6)', async () => {
    const name = `${PREFIX}exec-${rand()}`;
    const port = await freeBase(1);
    const web = await webSandbox('exec', name, port, ['test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]', 'interval: 1s', 'timeout: 2s', 'retries: 30'], 60);
    const file = web.sandboxes!.sandbox.file;
    const base = await readFile(file, 'utf8');
    const withSeed = async (step: string) => {
      await writeFile(file, `${base}seed:\n  - exec: {service: web, command: ${step}}\n`);
      return openSandbox(await loadProject(web.dir));
    };
    const sleeping = () =>
      docker(['compose', '-p', name, 'exec', '-T', 'web', 'ps'])
        .split('\n')
        .filter((l) => /sleep 30[0-9]/.test(l));
    try {
      const sb = await withSeed('"sleep 300 & sleep 301"');
      await sb.up({ log, seed: 'never' });
      const ac = new AbortController();
      const reset = sb.reset({ log, signal: ac.signal }).catch((e: unknown) => e);
      for (let i = 0; i < 50 && sleeping().length < 2; i++) await new Promise((r) => setTimeout(r, 200));
      expect(sleeping().length).toBe(2);
      ac.abort();
      expect(await reset).toMatchObject({ code: 'interrupted' });
      expect(sleeping()).toEqual([]);
      const timed = await withSeed('"sleep 302", timeout_s: 2');
      const t0 = Date.now();
      const e = await timed.reset({ log }).catch((x: unknown) => x);
      expect((e as SandboxError).code).toBe('seed');
      expect((e as Error).message).toMatch(/\(exec in web\) failed: did not finish within 2 s \(timeout_s\): stopped$/);
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(sleeping()).toEqual([]);
    } finally {
      await openSandbox(await loadProject(web.dir)).down({ volumes: true });
    }
    expect(labelled('container', name)).toEqual([]);
  });

  it('a service whose health stays "starting" fails up with its state, whatever `up --wait` exits with; what up started is stopped', async () => {
    const name = `${PREFIX}starting-${rand()}`;
    const port = await freeBase(1);
    const project = await webSandbox('starting', name, port, ['test: ["CMD", "false"]', 'interval: 60s', 'timeout: 2s', 'retries: 3', 'start_period: 120s'], 5);
    const t0 = Date.now();
    const err = await openSandbox(project)
      .up({ log })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('unhealthy');
    expect((err as Error).message).toMatch(/web: running, health starting \(not healthy yet\)/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    // Stopped (its logs kept), not removed.
    expect(docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.State}}']).trim()).toBe('exited');
    await openSandbox(project).down({ volumes: true });
    expect(labelled('container', name)).toEqual([]);
  });

  it('a published port another program holds is refused before up (nothing created) and, next to a running sandbox, after up', async () => {
    const name = `${PREFIX}ports-${rand()}`;
    const port = await freeBase(1);
    const project = await webSandbox('ports', name, port, ['test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]', 'interval: 1s', 'timeout: 2s', 'retries: 30'], 60);
    const listen = (host: string) =>
      new Promise<Server | null>((resolve) => {
        const s = createServer();
        s.once('error', () => resolve(null));
        s.listen(port, host, () => resolve(s));
      });
    const local = await listen('127.0.0.1');
    expect(local).not.toBeNull();
    const err = await openSandbox(project)
      .up({ log })
      .catch((e: unknown) => e);
    local!.close();
    expect((err as SandboxError).code).toBe('port');
    expect((err as Error).message).toMatch(new RegExp(`port ${port} \\(service web, published\\) is in use by another program \\(node, pid ${process.pid}\\)`));
    expect(labelled('container', name)).toEqual([]);

    const sb = openSandbox(project);
    await sb.up({ log });
    const wildcard = await listen('0.0.0.0');
    if (wildcard) {
      try {
        const again = await sb.up({ log }).catch((e: unknown) => e);
        expect((again as SandboxError).code).toBe('port');
        expect((again as Error).message).toMatch(new RegExp(`port ${port} \\(service web, published\\) is also used by another program \\(node, pid ${process.pid}\\)`));
      } finally {
        wildcard.close();
      }
    } else {
      console.log('[compose ports] this platform refuses a wildcard bind next to the published 127.0.0.1 port: the after-up check is covered by the unit tests');
    }
    await sb.down({ volumes: true });
    expect(labelled('container', name)).toEqual([]);
  });

  it('another checkout sharing the compose project name is refused by every command; another container publishing the port on [::1] is refused by up (K2, K3)', async () => {
    const name = `${PREFIX}shared-${rand()}`;
    const port = await freeBase(1);
    const health = ['test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]', 'interval: 1s', 'timeout: 2s', 'retries: 30'];
    const a = await webSandbox('checkout-a', name, port, health, 60);
    const b = await webSandbox('checkout-b', name, port, health, 60);
    const sb = openSandbox(a);
    const intruder = `${PREFIX}intruder-${rand()}`;
    try {
      await sb.up({ log });
      const other = new RegExp(`compose project ${name} belongs to another folder`);
      await expect(openSandbox(b).status()).rejects.toThrow(other);
      await expect(openSandbox(b).reset()).rejects.toThrow(other);
      await expect(openSandbox(b).logs()).rejects.toThrow(other);
      await expect(openSandbox(b).down()).rejects.toThrow(other);
      expect(labelled('container', name).length).toBe(1);
      // Another container on the same port, on [::1] (localhost resolves there first).
      let started = true;
      try {
        docker(['run', '-d', '--name', intruder, '-p', `[::1]:${port}:8080`, 'busybox:1.38.0', 'httpd', '-f', '-p', '8080', '-h', '/etc']);
      } catch (e) {
        started = false;
        console.log(`[compose intruder] docker refused a second container on [::1]:${port}: ${(e as Error).message.split('\n')[0]} — covered by the unit tests`);
      }
      if (started) {
        const err = await sb.up({ log }).catch((e: unknown) => e);
        expect((err as SandboxError).code).toBe('port');
        expect((err as Error).message).toContain(`port ${port} (service web, published) is also published by container ${intruder} (on [::1])`);
        expect((await sb.status()).state).toBe('up'); // status reads it as it is; the health checks reach 127.0.0.1
      }
    } finally {
      try {
        docker(['rm', '-f', intruder]);
      } catch {
        /* never started */
      }
      await sb.down({ volumes: true });
    }
    expect(labelled('container', name)).toEqual([]);
  });
});
