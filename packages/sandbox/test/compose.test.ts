/**
 * docker-compose sandboxes for real, gated by RETAKE_TEST_DOCKER=1 (a running Docker with the
 * images busybox:1.38.0, postgres:17-alpine and axllent/mailpit present). Every compose project and container of a
 * run is named `retake-test-<run token>-*` and removed after (containers, networks, volumes, images it built):
 * another run at the same time (another worktree) and packages/cli/test/sandbox-docker.test.ts keep theirs; shared
 * base images are left alone.
 *
 * - the `retake sandbox init` scaffold (app placeholder, Postgres, Mailpit) with an `exec` seed step and `reset.restart:
 *   [app]`: up (seed + snapshot taken), status, a mutation, reset (snapshot restored, the rows back, the app restarted
 *   and healthy again), reset --reseed (taken again), a
 *   take prepared (prepareTake, snapshot strategy), a seed change making the snapshot stale, logs, down --volumes
 *   leaving nothing with the project's label (times logged, never asserted);
 * - a service whose health stays "starting": up fails with its state, whatever `--wait` exits with;
 * - a published port another program holds: refused before up (nothing created), and, when the platform lets a
 *   program bind the wildcard address next to Docker's 127.0.0.1, refused after up;
 * - another checkout sharing the compose project name is refused by every command, and another container publishing
 *   the sandbox's port on [::1] (OrbStack allows it next to 127.0.0.1) is refused by up;
 * - R-SBX-10: an outdated snapshot is seeded again from the base (the database before its first
 *   seed), never from a take's data; a sandbox snapshotted without a base seeds from its outdated snapshot and says how
 *   to get one; neither base nor snapshot is refused with nothing changed; down --volumes, then up, keeps a base. These
 *   use busybox and postgres:17-alpine only, `pull_policy: never` (no image pulled);
 * - R-SBX-09: the "monorepo without app images" recipe of docs/guide/sandbox.md — the app run from its source,
 *   mounted in a stock Node image that is already here (node:24.21.0-bookworm-slim, never pulled), beside its database
 *   in one compose project, so a snapshot reset works.
 */
import { resolveSecretRef } from '@retake/core/io';
import { packageHooks } from './hook-runner.js';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import type { LoadedProject, WorkPolicy } from '@retake/core';
import { SandboxError, dockerEnv, findDocker, initSandbox, openSandbox, probePort } from '@retake/sandbox';
import type { SandboxLog } from '../src/provider.js';
import { EARLIER_SNAPSHOT_SUFFIX } from '../src/snapshot-postgres.js';
import { PERSON_POLICY } from '@retake/core';

/** The policy the work below runs under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
const policy: WorkPolicy = PERSON_POLICY;

/** The scaffold's writer in these tests: plain files (the engine's project store in the CLI). */
const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

const ENABLED = process.env.RETAKE_TEST_DOCKER === '1';
const DOCKER = findDocker() ?? 'docker';
/** This run's names: a token of its own, so a run never removes another's (another worktree, sandbox-docker.test.ts). */
const PREFIX = `retake-test-${randomBytes(3).toString('hex')}-`;
const ours = (name: string) => name.startsWith(PREFIX);
const require = createRequire(import.meta.url);

function docker(args: string[]): string {
  return execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv(policy), stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
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
  tmp = await mkdtemp(join(tmpdir(), 'retake-compose-'));
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

describe.skipIf(!ENABLED)('docker-compose sandboxes for real (RETAKE_TEST_DOCKER=1)', () => {
  it('the init scaffold: up seeds and takes a snapshot, reset restores it, --reseed retakes it, a take restores it, a seed change makes it stale, down --volumes leaves nothing', async () => {
    const name = `${PREFIX}scaffold-${rand()}`;
    const dir = await newProject('scaffold');
    const res = await initSandbox(await loadProject(dir), { write: plainWrite, basePort: await freeBase(3) });
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
    const sb = openSandbox(project, undefined, policy, resolveSecretRef, packageHooks);
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
    const changed = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
    expect((await changed.status()).seed?.current).toBe(false);
    const r3 = await changed.reset({ log });
    expect(r3).toMatchObject({ restored: false, snapshot: { action: 'taken' } });
    expect(await count()).toBe(7);
    const tpl = await query(
      url.replace(/\/app$/, '/postgres'),
      "SELECT shobj_description(oid, 'pg_database') AS c, datistemplate AS t, datallowconn AS a FROM pg_database WHERE datname = 'app__retake_snap'",
    );
    expect(tpl).toEqual([{ c: `retake snapshot ${r3.hash}`, t: true, a: false }]);

    // A sandbox whose snapshot was taken before the template's present name: its reset restores it, renamed.
    const admin = url.replace(/\/app$/, '/postgres');
    await query(admin, `ALTER DATABASE app__retake_snap RENAME TO app${EARLIER_SNAPSHOT_SUFFIX}`);
    await query(url, 'DELETE FROM demo_customers');
    expect(await changed.reset({ log })).toMatchObject({ restored: true, snapshot: { action: 'restored' }, seed: { steps: 0 } });
    expect(await count()).toBe(7);
    // Its base (the database before the first seed, R-SBX-10) beside it; no copy left under __retake_next.
    expect((await query(admin, "SELECT datname AS n FROM pg_database WHERE datname LIKE 'app\\_\\_%' ORDER BY 1")).map((r) => r.n)).toEqual(['app__retake_base', 'app__retake_snap']);

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

  it('an interrupted restore — the database dropped, or its connections blocked — is repaired by up and by a take', async () => {
    const name = `${PREFIX}repair-${rand()}`;
    const dir = await newProject('repair');
    const res = await initSandbox(await loadProject(dir), { write: plainWrite, basePort: await freeBase(3) });
    await writeFile(res.manifest, (await readFile(res.manifest, 'utf8')).replace('  files: [compose.yaml]', `  files: [compose.yaml]\n  project: ${name}`));
    const sb = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
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

  it('an exec seed step interrupted or past its timeout is stopped inside its container, not only the docker client', async () => {
    const name = `${PREFIX}exec-${rand()}`;
    const port = await freeBase(1);
    const web = await webSandbox('exec', name, port, ['test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]', 'interval: 1s', 'timeout: 2s', 'retries: 30'], 60);
    const file = web.sandboxes!.sandbox.file;
    const base = await readFile(file, 'utf8');
    const withSeed = async (step: string) => {
      await writeFile(file, `${base}seed:\n  - exec: {service: web, command: ${step}}\n`);
      return openSandbox(await loadProject(web.dir), undefined, policy, resolveSecretRef, packageHooks);
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
      await openSandbox(await loadProject(web.dir), undefined, policy, resolveSecretRef, packageHooks).down({ volumes: true });
    }
    expect(labelled('container', name)).toEqual([]);
  });

  it('a service whose health stays "starting" fails up with its state, whatever `up --wait` exits with; what up started is stopped', async () => {
    const name = `${PREFIX}starting-${rand()}`;
    const port = await freeBase(1);
    const project = await webSandbox('starting', name, port, ['test: ["CMD", "false"]', 'interval: 60s', 'timeout: 2s', 'retries: 3', 'start_period: 120s'], 5);
    const t0 = Date.now();
    const err = await openSandbox(project, undefined, policy, resolveSecretRef, packageHooks)
      .up({ log })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).code).toBe('unhealthy');
    expect((err as Error).message).toMatch(/web: running, health starting \(not healthy yet\)/);
    expect(Date.now() - t0).toBeLessThan(60_000);
    // Stopped (its logs kept), not removed.
    expect(docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${name}`, '--format', '{{.State}}']).trim()).toBe('exited');
    await openSandbox(project, undefined, policy, resolveSecretRef, packageHooks).down({ volumes: true });
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
    const err = await openSandbox(project, undefined, policy, resolveSecretRef, packageHooks)
      .up({ log })
      .catch((e: unknown) => e);
    local!.close();
    expect((err as SandboxError).code).toBe('port');
    expect((err as Error).message).toMatch(new RegExp(`port ${port} \\(service web, published\\) is in use by another program \\(node, pid ${process.pid}\\)`));
    expect(labelled('container', name)).toEqual([]);

    const sb = openSandbox(project, undefined, policy, resolveSecretRef, packageHooks);
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

  it('another checkout sharing the compose project name is refused by every command; another container publishing the port on [::1] is refused by up', async () => {
    const name = `${PREFIX}shared-${rand()}`;
    const port = await freeBase(1);
    const health = ['test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"]', 'interval: 1s', 'timeout: 2s', 'retries: 30'];
    const a = await webSandbox('checkout-a', name, port, health, 60);
    const b = await webSandbox('checkout-b', name, port, health, 60);
    const sb = openSandbox(a, undefined, policy, resolveSecretRef, packageHooks);
    const intruder = `${PREFIX}intruder-${rand()}`;
    try {
      await sb.up({ log });
      const other = new RegExp(`compose project ${name} belongs to another folder`);
      await expect(openSandbox(b, undefined, policy, resolveSecretRef, packageHooks).status()).rejects.toThrow(other);
      await expect(openSandbox(b, undefined, policy, resolveSecretRef, packageHooks).reset()).rejects.toThrow(other);
      await expect(openSandbox(b, undefined, policy, resolveSecretRef, packageHooks).logs()).rejects.toThrow(other);
      await expect(openSandbox(b, undefined, policy, resolveSecretRef, packageHooks).down()).rejects.toThrow(other);
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

  /**
   * A db (postgres:17-alpine) and an app (busybox) in one compose project, strategy snapshot, an additive seed
   * (no DROP, no TRUNCATE: the field case) that `seed` rewrites. Nothing is pulled.
   */
  async function ladderSandbox(slug: string): Promise<{ dir: string; url: string; seedFile: string; name: string }> {
    const name = `${PREFIX}${slug}-${rand()}`;
    const dir = await newProject(slug);
    const base = await freeBase(2);
    const pw = `pg-sandbox-${base + 1}`;
    await mkdir(join(dir, 'sandbox', 'seed'), { recursive: true });
    await writeFile(
      join(dir, 'sandbox', 'compose.yaml'),
      [
        'services:',
        '  app:',
        '    image: busybox:1.38.0',
        '    pull_policy: never',
        '    init: true',
        '    command: ["httpd", "-f", "-p", "8080", "-h", "/etc"]',
        `    ports: ["127.0.0.1:${base}:8080"]`,
        '    depends_on: {db: {condition: service_healthy}}',
        '    healthcheck: {test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/hostname"], interval: 1s, timeout: 2s, retries: 30}',
        '  db:',
        '    image: postgres:17-alpine',
        '    pull_policy: never',
        `    environment: {POSTGRES_USER: demo, POSTGRES_PASSWORD: ${pw}, POSTGRES_DB: app}`,
        `    ports: ["127.0.0.1:${base + 1}:5432"]`,
        '    volumes: ["db-data:/var/lib/postgresql/data"]',
        '    healthcheck: {test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U demo -d app"], interval: 1s, timeout: 3s, retries: 60}',
        'volumes:',
        '  db-data:',
        '',
      ].join('\n'),
    );
    const seedFile = join(dir, 'sandbox', 'seed', '01-demo.sql');
    await writeFile(seedFile, "CREATE TABLE IF NOT EXISTS demo (id serial PRIMARY KEY, name text NOT NULL);\nINSERT INTO demo (name) VALUES ('Willow Street Bakery'), ('Copper Kettle Cafe');\n");
    await writeFile(
      join(dir, 'sandbox', 'sandbox.yaml'),
      [
        'version: 1',
        'provider: docker-compose',
        `compose: {files: [compose.yaml], project: ${name}}`,
        'services:',
        `  app: {url: "http://localhost:${base}", health: /hostname, pages: {app: "http://localhost:${base}"}}`,
        'seed:',
        '  - sql: {file: seed/01-demo.sql, db: main}',
        'reset: {strategy: snapshot}',
        'databases:',
        `  main: {url: "postgres://demo:${pw}@localhost:${base + 1}/app"}`,
        '',
      ].join('\n'),
    );
    await writeFile(join(dir, 'project.yaml'), ['name: Ladder', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
    return { dir, url: `postgres://demo:${pw}@localhost:${base + 1}/app`, seedFile, name };
  }

  it('a changed seed restores the base before seeding: the last take\'s rows are not in the new snapshot', async () => {
    const { dir, url, seedFile, name } = await ladderSandbox('ladder');
    const rows = async () => (await query(url, 'SELECT name FROM demo ORDER BY id')).map((r) => r.name);
    const sb = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
    try {
      const up = await sb.up({ log });
      expect(up.reset).toMatchObject({ base: { action: 'taken' }, snapshot: { action: 'taken' } });
      expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
      await query(url, "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      // The seed changes (one comment line): the snapshot is outdated — the base, then the seed, then a new snapshot.
      await writeFile(seedFile, `-- a comment\n${await readFile(seedFile, 'utf8')}`);
      const changed = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
      expect((await changed.status()).snapshot).toMatchObject({ state: 'outdated', why: 'seed', base: true, next: 'from-base' });
      const r = await changed.reset({ log });
      expect(r).toMatchObject({ restored: false, base: { action: 'restored' }, outdated: { why: 'seed', from: 'base', restarted: ['app'] }, snapshot: { action: 'taken' } });
      expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
      // A take again: the next reset restores exactly the seed's rows.
      await query(url, "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      expect(await changed.reset({ log })).toMatchObject({ restored: true });
      expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
      expect((await changed.status()).snapshot).toEqual({ state: 'current', base: true, next: 'restore' });
      console.log(`[compose ladder] base restored in ${r.base!.ms} ms, reset ${r.ms} ms (app restarted before the seed)`);
    } finally {
      await sb.down({ volumes: true });
    }
    expect(labelled('volume', name)).toEqual([]);
  });

  it('a sandbox snapshotted without a base seeds from its outdated snapshot and says how to get one; neither base nor snapshot refuses, changing nothing; down --volumes then up keeps a base', async () => {
    const { dir, url, seedFile } = await ladderSandbox('nobase');
    const admin = url.replace(/\/app$/, '/postgres');
    const rows = async () => (await query(url, 'SELECT name FROM demo ORDER BY id')).map((r) => r.name);
    const sb = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
    try {
      await sb.up({ log });
      // As a sandbox snapshotted before the base existed: no base in the cluster nor in the state.
      await query(admin, 'ALTER DATABASE app__retake_base WITH IS_TEMPLATE false');
      await query(admin, 'DROP DATABASE app__retake_base');
      const stateFile = join(dir, '.retake', 'sandbox', 'sandbox', 'state.json');
      const st = JSON.parse(await readFile(stateFile, 'utf8')) as { provider_state: Record<string, unknown> };
      delete st.provider_state.base;
      await writeFile(stateFile, JSON.stringify(st));
      await query(url, "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      await writeFile(seedFile, `-- a comment\n${await readFile(seedFile, 'utf8')}`);
      const changed = openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks);
      const r = await changed.reset({ log });
      expect(r).toMatchObject({ outdated: { why: 'seed', from: 'snapshot' }, snapshot: { action: 'taken' } });
      expect(r.base).toBeUndefined();
      expect(r.outdated?.hint).toMatch(/--volumes \(it deletes every volume of the sandbox/);
      // The additive seed ran on the snapshot's data (its documented contract is to reset what it creates): never on the take's.
      expect(await rows()).not.toContain('TAKE ROW');
      // Neither base nor snapshot: refused, nothing changed.
      await query(url, "INSERT INTO demo (name) VALUES ('TAKE ROW')");
      await query(admin, 'ALTER DATABASE app__retake_snap WITH IS_TEMPLATE false');
      await query(admin, 'DROP DATABASE app__retake_snap');
      const before = await readFile(stateFile, 'utf8');
      await expect(changed.reset({ log })).rejects.toThrow(/the database already holds data and there is no base or snapshot to start from \(its snapshot is gone\): .*Nothing was changed\. Start from a fresh database: retake sandbox down \S+ --env sandbox --volumes/);
      expect(await rows()).toContain('TAKE ROW');
      expect(await readFile(stateFile, 'utf8')).toBe(before);
      // A fresh database: down --volumes, then up — its first seed keeps a base again.
      await changed.down({ log, volumes: true });
      const again = await openSandbox(await loadProject(dir), undefined, policy, resolveSecretRef, packageHooks).up({ log });
      expect(again.reset).toMatchObject({ base: { action: 'taken' }, snapshot: { action: 'taken' } });
      expect(await rows()).toEqual(['Willow Street Bakery', 'Copper Kettle Cafe']);
    } finally {
      await sb.down({ volumes: true });
    }
  });

  it('the monorepo recipe — the app run from its source in a stock Node image, beside its database: up, seed, snapshot, reset', async () => {
    const IMAGE = 'node:24.21.0-bookworm-slim';
    const present = (() => {
      try {
        docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
        return true;
      } catch {
        return false;
      }
    })();
    if (!present) {
      console.info(`[compose monorepo recipe] skipped: ${IMAGE} is not on this machine (never pulled by the test)`);
      return;
    }
    const name = `${PREFIX}monorepo-${rand()}`;
    const dir = await newProject('monorepo');
    const base = await freeBase(3);
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(
      join(dir, 'sandbox', 'compose.yaml'),
      [
        'services:',
        '  web:',
        `    image: ${IMAGE}`,
        '    pull_policy: never',
        '    init: true',
        `    volumes: ["${join(repo, 'fixtures', 'wholesale')}:/repo/fixtures/wholesale:ro"]`,
        '    working_dir: /repo/fixtures/wholesale',
        '    command: ["node", "server.mjs", "--no-build", "--no-auth"]',
        `    environment: {NORTHFIELD_HOST: 0.0.0.0, NORTHFIELD_CONSOLE_PORT: "${base}", NORTHFIELD_SHOP_PORT: "${base + 1}", DATABASE_URL: "postgres://demo:pg-sandbox-${base + 2}@db:5432/app"}`,
        `    ports: ["127.0.0.1:${base}:${base}", "127.0.0.1:${base + 1}:${base + 1}"]`,
        '    depends_on: {db: {condition: service_healthy}}',
        `    healthcheck: {test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:${base}/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"], interval: 1s, timeout: 3s, retries: 60}`,
        '  db:',
        '    image: postgres:17-alpine',
        '    pull_policy: never',
        `    environment: {POSTGRES_USER: demo, POSTGRES_PASSWORD: pg-sandbox-${base + 2}, POSTGRES_DB: app}`,
        `    ports: ["127.0.0.1:${base + 2}:5432"]`,
        '    volumes: ["db-data:/var/lib/postgresql/data"]',
        '    healthcheck: {test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U demo -d app"], interval: 1s, timeout: 3s, retries: 60}',
        'volumes:',
        '  db-data:',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(dir, 'sandbox', 'sandbox.yaml'),
      [
        'version: 1',
        'provider: docker-compose',
        `compose: {files: [compose.yaml], project: ${name}}`,
        'services:',
        `  web: {url: "http://localhost:${base}", health: {path: /api/health, timeout_s: 120}, pages: {console: "http://localhost:${base}", shop: "http://localhost:${base + 1}"}}`,
        'seed:',
        '  - http: {method: POST, url: "{{console}}/api/reset"}',
        '  - sql: {db: main, query: "DROP TABLE IF EXISTS demo; CREATE TABLE demo (n int); INSERT INTO demo VALUES (1)"}',
        'reset: {strategy: snapshot, restart: [web]}',
        'databases:',
        `  main: {url: "postgres://demo:pg-sandbox-${base + 2}@localhost:${base + 2}/app"}`,
        '',
      ].join('\n'),
    );
    await writeFile(join(dir, 'project.yaml'), ['name: Monorepo', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
    const project = await loadProject(dir);
    expect(project.sandboxes!.sandbox.issues).toEqual([]);
    const sb = openSandbox(project, undefined, policy, resolveSecretRef, packageHooks);
    const url = `postgres://demo:pg-sandbox-${base + 2}@localhost:${base + 2}/app`;
    try {
      const t0 = Date.now();
      const up = await sb.up({ log });
      expect(up.started.sort()).toEqual(['db', 'web']);
      expect(up.reset).toMatchObject({ seed: { steps: 2 }, base: { action: 'taken' }, snapshot: { action: 'taken' } });
      const health = (await (await fetch(`http://127.0.0.1:${base}/api/health`)).json()) as { name: string };
      expect(health.name).toBe('northfield-fixture');
      await query(url, 'INSERT INTO demo VALUES (2)');
      const r = await sb.reset({ log });
      expect(r).toMatchObject({ restored: true, restarted: ['web'] });
      expect((await query(url, 'SELECT count(*)::int AS n FROM demo'))[0].n).toBe(1);
      console.log(`[compose monorepo recipe] up ${up.ms} ms (seed ${up.reset!.seed.ms} ms) · reset ${r.ms} ms · total ${Date.now() - t0} ms`);
    } finally {
      await sb.down({ volumes: true });
    }
    expect(labelled('container', name)).toEqual([]);
  });
});
