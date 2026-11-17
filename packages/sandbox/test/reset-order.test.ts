/**
 * R-SBX-10: the order of a snapshot reset's calls, in the default suite — a fake provider (no
 * Docker) and a fake Postgres (no database) handed to the Sandbox, a stand-in of the Firebase Auth emulator. The base is
 * taken after the database exists and before the seed; an outdated snapshot restores the base (else itself), restarts
 * the running services but the database's, empties the emulator, seeds and takes the snapshot; a refusal changes and
 * forgets nothing. The same rules against a real Postgres: snapshot-base.test.ts; the whole sandbox: compose.test.ts.
 */
import { resolveSecretRef } from '@retake/core/io';
import { packageHooks } from './hook-runner.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { LoadedProject } from '@retake/core';
import { Sandbox } from '../src/sandbox.js';
import { COMPOSE_CAPABILITIES } from '../src/provider.js';
import type { DataStorage, Provider, ProviderContext } from '../src/provider.js';
import type { SnapshotPort, SnapshotTarget } from '../src/snapshot-postgres.js';
import { firebaseAuthFile } from '../src/firebase-auth.js';

let root: string;
let calls: string[];
let emulator: Server;
let emulatorPort: number;

/** The cluster the fake Postgres answers about. */
interface Cluster {
  template: { present: boolean; comment: string | null };
  base: boolean;
  database: boolean;
  /** It holds no relation of its own (isEmpty). */
  empty: boolean;
}
const newCluster = (): Cluster => ({ template: { present: false, comment: null }, base: false, database: true, empty: true });
/** The cluster's databases by name: `cluster` is the first one's (app). */
let clusters: Record<string, Cluster>;
let cluster: Cluster;
let image: string;
let storage: DataStorage;
let servicesUp: boolean;
/** The Postgres server's system identifier (initdb's): a new one when its data folder is made again. */
let serverId: string;
/** The product loads its catalogue during its own start-up (an up), before Retake's seed: the database is not empty. */
let bootLoads: boolean;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-reset-order-'));
  emulator = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'DELETE') calls.push('fa.clear');
    else if (u.pathname.endsWith(':batchGet')) calls.push('fa.save');
    else if (u.pathname.endsWith(':batchCreate')) calls.push('fa.import');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(u.pathname.endsWith(':batchGet') ? { users: [{ localId: 'u1', email: 'owner@example.com' }] } : {}));
  });
  await new Promise<void>((r) => emulator.listen(0, '127.0.0.1', () => r()));
  emulatorPort = (emulator.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => emulator.close(() => r()));
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  calls = [];
  cluster = newCluster();
  clusters = { app: cluster };
  image = 'sha256:one';
  storage = { kind: 'volume', where: 'demo_pgdata' };
  servicesUp = true;
  serverId = 'cluster-1';
  bootLoads = false;
});

/** The data folder made again (a tmpfs or the container's own layer after a down, a volume removed): a new cluster. */
function newServer(): void {
  for (const k of Object.keys(clusters)) clusters[k] = newCluster();
  cluster = clusters.app;
  serverId = `cluster-${Number(serverId.split('-')[1]) + 1}`;
}

/** A docker-compose provider that runs nothing: app depends on db, db on a volume helper; mailpit stands alone. */
function fakeProvider(): Provider {
  const running = ['helper', 'db', 'app', 'mailpit'];
  const no = (what: string) => async (): Promise<never> => {
    throw new Error(`the fake provider has no ${what}`);
  };
  return {
    kind: 'docker-compose',
    capabilities: COMPOSE_CAPABILITIES,
    up: async () => {
      if (bootLoads) for (const c of Object.values(clusters)) c.empty = false;
      return { started: [], kept: running, changed: [], ms: 0 };
    },
    down: async (ctx: ProviderContext, o = {}) => {
      calls.push(`down${o.volumes ? ' --volumes' : ''}`);
      if (o.volumes) {
        const ps = { ...(ctx.state.provider_state ?? {}) };
        delete ps.snapshot;
        delete ps.base;
        ctx.state.provider_state = ps;
        // A volume goes with --volumes; a bind mount or an external volume keeps the database as it is.
        if (storage.kind === 'volume') newServer();
      }
      // A tmpfs, the container's own layer or an anonymous volume goes with every down.
      if (storage.kind === 'tmpfs' || storage.kind === 'container' || (storage.kind === 'volume' && !storage.where)) newServer();
      ctx.save();
      return { stopped: running, dataGone: o.volumes === true };
    },
    status: async () => running.map((name) => (servicesUp ? { name, state: 'running' as const, health: 'ok', healthy: true } : { name, state: 'stopped' as const })),
    restart: async (_ctx: ProviderContext, s: string) => void calls.push(`restart ${s}`),
    exec: async () => {
      calls.push('seed');
      for (const c of Object.values(clusters)) c.empty = false;
      return '';
    },
    stopStarted: async () => [],
    killStartedSync: () => undefined,
    logFiles: () => [],
    logs: no('logs'),
    followLogs: no('followLogs'),
    publishedBy: async () => 'db',
    servedBy: async () => 'mailpit',
    address: async () => undefined,
    hashInputs: async () => [`image app=${image}`],
    servicesAround: async () => ({ running, depends: { app: ['db'], db: ['helper'] }, storage }),
  };
}

/** A Postgres that only says what it would do. */
function fakeSnapshot(target: SnapshotTarget): SnapshotPort {
  const cluster = (clusters[target.database] ??= newCluster());
  return {
    target,
    close: async () => undefined,
    clusterId: async () => serverId,
    broken: async () => null,
    repair: async () => false,
    adoptEarlier: async () => null,
    templateState: async (hash) => ({ present: cluster.template.present, valid: cluster.template.present && cluster.template.comment === `retake snapshot ${hash}` }),
    hasBase: async () => cluster.base,
    isEmpty: async () => !cluster.database || cluster.empty,
    ensureDatabase: async () => {
      calls.push('ensureDatabase');
      const made = !cluster.database;
      cluster.database = true;
      return made;
    },
    takeBase: async () => {
      if (!cluster.database) throw new Error('takeBase on a missing database');
      calls.push('takeBase');
      cluster.base = true;
      return { owner: 'demo', ms: 1 };
    },
    take: async (hash) => {
      calls.push('take');
      cluster.template = { present: true, comment: `retake snapshot ${hash}` };
      return { owner: 'demo', ms: 1 };
    },
    restore: async (_owner, from = 'snapshot') => {
      calls.push(`restore ${from}`);
      return { ms: 1 };
    },
  };
}

async function project(withAuth: boolean, o: { restart?: string[]; database?: string } = {}): Promise<LoadedProject> {
  const dir = join(root, `p-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), ['name: Reset order', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', '  sandbox: sandbox/sandbox.yaml', ''].join('\n'));
  await writeFile(
    join(dir, 'sandbox', 'compose.yaml'),
    ['services:', '  helper: {image: busybox}', '  db: {image: postgres:17-alpine}', '  app: {image: busybox}', '  mailpit: {image: busybox}', ''].join('\n'),
  );
  await writeFile(
    join(dir, 'sandbox', 'sandbox.yaml'),
    [
      'version: 1',
      'provider: docker-compose',
      'services:',
      '  app: {url: "http://localhost:4529", health: /, pages: {app: "http://localhost:4529"}}',
      'seed:',
      '  - exec: {service: app, command: "seed"}',
      'reset:',
      '  strategy: snapshot',
      ...(withAuth ? [`  firebase_auth: {url: "http://127.0.0.1:${emulatorPort}", project: demo-shop}`] : []),
      ...(o.restart ? [`  restart: [${o.restart.join(', ')}]`] : []),
      ...(o.database ? [`  snapshot: {database: ${o.database}}`] : []),
      'databases:',
      '  main: {url: "postgres://demo:pg-sandbox-4528@localhost:4528/app"}',
      '  shop: {url: "postgres://demo:pg-sandbox-4528@localhost:4528/shop"}',
      '',
    ].join('\n'),
  );
  return loadProject(dir);
}

function sandboxOf(p: LoadedProject): Sandbox {
  return new Sandbox(p, p.sandboxes!.sandbox, PERSON_POLICY, resolveSecretRef, packageHooks).withDeps({ provider: fakeProvider, openSnapshot: async (t) => fakeSnapshot(t) });
}

const state = async (p: LoadedProject) => JSON.parse(await readFile(join(p.dir, '.retake', 'sandbox', 'sandbox', 'state.json'), 'utf8')) as Record<string, unknown>;

describe('the order of a snapshot reset', () => {
  it('a first seed: the database made sure of, the base, the seed, the snapshot — in that order, the base recorded', async () => {
    const p = await project(false);
    cluster.database = false; // the seed would create it: ensureDatabase first, then the base
    const r = await sandboxOf(p).up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r.reset).toMatchObject({ base: { action: 'taken' }, snapshot: { action: 'taken' }, seed: { steps: 1 } });
    expect(r.reset?.outdated).toBeUndefined();
    expect((await state(p)).provider_state).toMatchObject({ base: { database: 'app', owner: 'demo' }, snapshot: { database: 'app' } });
    // No reset.firebase_auth: no accounts put back, nothing recorded (R-SBX-11).
    expect(r.reset?.firebase_auth).toBeUndefined();
    expect((await state(p)).accounts_at).toBeUndefined();
  });

  it('an outdated snapshot (a rebuilt image): base restored, the running services but the database restarted, emulator emptied, seed, snapshot', async () => {
    const p = await project(true);
    const sb = sandboxOf(p);
    await sb.up();
    calls = [];
    // A take, then a rebuilt image: the hash moves.
    image = 'sha256:two';
    const r = await sb.reset();
    expect(calls).toEqual(['restore base', 'restart app', 'restart mailpit', 'fa.clear', 'seed', 'fa.save', 'take', 'fa.clear', 'fa.import']);
    expect(r).toMatchObject({ base: { action: 'restored' }, outdated: { why: 'seed', from: 'base', restarted: ['app', 'mailpit'] }, restarted: ['app', 'mailpit'], restored: false });
    expect(r.outdated?.hint).toBeUndefined();
    // when the accounts were put back is recorded — persona sessions saved before are signed out.
    expect(r.firebase_auth).toMatchObject({ accounts: 1, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), personas: { login: [], no_login: [] } });
    expect((await state(p)).accounts_at).toBe(r.firebase_auth?.at);
    calls = [];
    const again = await sb.reset();
    expect(calls).toEqual(['restore snapshot', 'fa.clear', 'fa.import']);
    expect(again).toMatchObject({ restored: true, restarted: [] });
    expect(again.outdated).toBeUndefined();
  });

  it('firebase_auth added to a sandbox snapshotted before this lot (no base): the old snapshot restored, then the seed, and how to get a base said once', async () => {
    const before = await project(false);
    await sandboxOf(before).up();
    // A sandbox made before the base existed: its snapshot and template, no base.
    cluster.base = false;
    const st = await state(before);
    delete (st.provider_state as Record<string, unknown>).base;
    await writeFile(join(before.dir, '.retake', 'sandbox', 'sandbox', 'state.json'), JSON.stringify(st));
    await writeFile(
      join(before.dir, 'sandbox', 'sandbox.yaml'),
      (await readFile(join(before.dir, 'sandbox', 'sandbox.yaml'), 'utf8')).replace(
        '  strategy: snapshot\n',
        `  strategy: snapshot\n  firebase_auth: {url: "http://127.0.0.1:${emulatorPort}", project: demo-shop}\n`,
      ),
    );
    const p = await loadProject(before.dir);
    calls = [];
    const r = await sandboxOf(p).reset();
    expect(calls).toEqual(['restore snapshot', 'restart app', 'restart mailpit', 'fa.clear', 'seed', 'fa.save', 'take', 'fa.clear', 'fa.import']);
    expect(r.outdated).toMatchObject({ why: 'firebase_auth', from: 'snapshot', restarted: ['app', 'mailpit'] });
    expect(r.outdated?.hint).toMatch(
      /no base to start from .*: retake sandbox down p-\w+ --env sandbox --volumes \(it deletes every volume of the sandbox: .*\), then retake sandbox up p-\w+ --env sandbox/,
    );
    expect(r.base).toBeUndefined();
  });

  it('neither base nor template on a database that is not fresh: refused before anything is changed or forgotten — the seed state and the saved accounts kept', async () => {
    const p = await project(true);
    const sb = sandboxOf(p);
    await sb.up();
    // The template and the base gone (dropped by hand, or kept on a bind mount that down --volumes left).
    Object.assign(cluster, { template: { present: false, comment: null }, base: false, database: true });
    storage = { kind: 'bind', where: '/data/pg' };
    const st = await state(p);
    calls = [];
    await expect(sb.reset()).rejects.toThrow(
      /^sandbox sandbox: the database already holds data and there is no base or snapshot to start from \(its snapshot is gone\): seeding on it would freeze that data into the snapshot\. Nothing was changed\. Start from a fresh database: retake sandbox down p-\w+ --env sandbox --volumes \(it deletes every volume of the sandbox.*\), then retake sandbox up .* Its database keeps its data in a folder of this machine \(\/data\/pg, a bind mount\): --volumes does not remove it/,
    );
    expect(calls).toEqual([]);
    expect(await state(p)).toEqual(st);
    expect(existsSync(firebaseAuthFile(sb.paths))).toBe(true);
  });

  it('down --volumes makes the database fresh again: the next up takes a base before its first seed', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    cluster.base = false; // say the base was lost: down --volumes, then up, gets one back
    cluster.template = { present: false, comment: null };
    await sb.down({ volumes: true });
    const st = await state(p);
    expect(st.seed).toBeUndefined();
    expect(st.last_reset).toBeUndefined();
    calls = [];
    const r = await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r.reset?.base).toEqual({ action: 'taken', ms: 1 });
  });

  it('status says what the next reset does, without renaming, repairing or locking anything; unknown when down', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    const vol = { storage: { kind: 'volume', where: 'demo_pgdata' } };
    expect((await sb.status()).snapshot).toEqual({ state: 'current', base: true, next: 'restore', ...vol });
    image = 'sha256:two';
    calls = [];
    expect((await sb.status()).snapshot).toEqual({ state: 'outdated', why: 'seed', reason: expect.stringMatching(/^the seed changed/), base: true, next: 'from-base', ...vol });
    cluster.base = false;
    cluster.template.present = false;
    expect((await sb.status()).snapshot).toEqual({ state: 'outdated', why: 'template', reason: 'its snapshot is gone', base: false, next: 'refuse', ...vol });
    servicesUp = false;
    expect((await sb.status()).snapshot).toEqual({ state: 'unknown', base: true, detail: 'sandbox down' });
    expect(calls).toEqual([]);
  });

  it('reset.restart services restart after the snapshot is taken, even when the outdated reset restarted them before the seed', async () => {
    const p = await project(false, { restart: ['app'] });
    const sb = sandboxOf(p);
    await sb.up();
    image = 'sha256:two';
    calls = [];
    const r = await sb.reset();
    expect(calls).toEqual(['restore base', 'restart app', 'restart mailpit', 'seed', 'take', 'restart app']);
    expect(r.restarted).toEqual(['app', 'mailpit', 'app']);
  });

  it('up --no-seed, then the product used, then a reset: the database holds data and nothing vouches for it — refused, no base taken from it', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up({ seed: 'never' });
    expect((await state(p)).unseeded_at).toEqual(expect.any(String));
    cluster.empty = false; // someone used the product
    calls = [];
    await expect(sb.reset()).rejects.toThrow(/^sandbox sandbox: the database already holds data and there is no base or snapshot to start from: seeding on it/);
    expect(calls).toEqual([]);
    expect(cluster.base).toBe(false);
  });

  it('a bind mount outlives down --volumes: the state keeps its seed, and the next reset refuses with the folder to empty', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    storage = { kind: 'bind', where: '/data/pg' };
    // As a sandbox that kept no base or snapshot in that folder: what the take left is there.
    Object.assign(cluster, { template: { present: false, comment: null }, base: false });
    await sb.down({ volumes: true });
    expect((await state(p)).seed).toBeDefined();
    calls = [];
    await expect(sb.reset()).rejects.toThrow(
      /Its database keeps its data in a folder of this machine \(\/data\/pg, a bind mount\): --volumes does not remove it — empty that folder between the two\./,
    );
    expect(calls).toEqual([]);
  });

  it('a volume removed outside Retake: the state still says seeded, the database is empty — a first seed with its base', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    clusters.app = newCluster(); // docker volume rm, by hand
    cluster = clusters.app;
    calls = [];
    const r = await sb.reset();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r.base).toEqual({ action: 'taken', ms: 1 });
  });

  it('reset.snapshot.database renamed to an empty database: a first seed with its base, never the refusal', async () => {
    const before = await project(false);
    await sandboxOf(before).up();
    await writeFile(
      join(before.dir, 'sandbox', 'sandbox.yaml'),
      (await readFile(join(before.dir, 'sandbox', 'sandbox.yaml'), 'utf8')).replace('  strategy: snapshot\n', '  strategy: snapshot\n  snapshot: {database: shop}\n'),
    );
    const p = await loadProject(before.dir);
    clusters.shop = newCluster();
    calls = [];
    const r = await sandboxOf(p).reset();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r).toMatchObject({ base: { action: 'taken' }, snapshot: { action: 'taken', database: 'shop' } });
  });

  it('a status whose Postgres cannot be read says so in fixed words; the error itself is kept apart', async () => {
    const p = await project(false);
    const sb = new Sandbox(p, p.sandboxes!.sandbox, PERSON_POLICY, resolveSecretRef, packageHooks).withDeps({
      provider: fakeProvider,
      openSnapshot: async () => {
        throw new Error('port 4528 is published by container other-shop-db-1 of another project');
      },
    });
    expect((await sb.status()).snapshot).toEqual({
      state: 'unknown',
      base: false,
      detail: 'its database could not be read',
      error: 'port 4528 is published by container other-shop-db-1 of another project',
    });
  });
  it('FB-31: a database in a tmpfs goes with every down — the seed, reset and snapshot forgotten, so the next up seeds it even though the product loaded data at boot', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    storage = { kind: 'tmpfs', where: '/var/lib/postgresql/data' };
    bootLoads = true;
    await sb.up();
    expect((await state(p)).provider_state).toMatchObject({ cluster: 'cluster-1', snapshot: { database: 'app' }, base: { database: 'app' } });
    const logs: string[] = [];
    const down = await sb.down({ log: (_l, m) => logs.push(m) });
    expect(down).toMatchObject({ dataGone: true, forgotten: 'tmpfs' });
    expect(logs.join('\n')).toMatch(/its database kept its data in memory \(a tmpfs\): gone with the container — its seed, reset and snapshot forgotten/);
    const st = await state(p);
    expect(st.seed).toBeUndefined();
    expect(st.last_reset).toBeUndefined();
    expect(st.provider_state).toEqual({});
    calls = [];
    const r = await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r.reset?.base).toEqual({ action: 'taken', ms: 1 });
    expect((await state(p)).provider_state).toMatchObject({ cluster: 'cluster-2' });
  });

  it("FB-31: the container's own layer or an anonymous volume, read from the container's settings — down leaves the records to the next reset's cluster check, which seeds the new database", async () => {
    for (const kind of [{ kind: 'container', where: '/var/lib/postgresql/data' }, { kind: 'volume' }] as DataStorage[]) {
      const p = await project(false);
      const sb = sandboxOf(p);
      storage = kind;
      bootLoads = true;
      await sb.up();
      const down = await sb.down();
      // A reading of settings, not a fact: with a recorded cluster nothing is forgotten at down…
      expect(down.forgotten).toBeUndefined();
      calls = [];
      const logs: string[] = [];
      const r = await sb.up({ log: (_l, m) => logs.push(m) });
      // …the next reset sees the new cluster where the data lives with the container: a first seed, never the refusal.
      expect(logs.join('\n')).toMatch(/its Postgres is a new cluster .*so the database is taken as fresh/);
      expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
      expect(r.reset?.base).toEqual({ action: 'taken', ms: 1 });
    }
  });

  it('FB-31: a new Postgres cluster where the data lives with the container (Docker restarted a tmpfs) — the records forgotten at the next reset, a first seed with its base although the product loaded data at boot', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    storage = { kind: 'tmpfs', where: '/var/lib/postgresql/data' };
    await sb.up();
    // The containers came back on their own with a new data folder: the product loaded its catalogue at its start-up.
    newServer();
    cluster.empty = false;
    expect((await sb.status()).snapshot).toEqual({ state: 'none', base: false, next: 'first-seed', new_cluster: true, storage });
    calls = [];
    const logs: string[] = [];
    // up starts nothing (everything runs): the new cluster alone is why it seeds.
    const r = await sb.up({ log: (_l, m) => logs.push(m) });
    expect(logs.join('\n')).toMatch(/seeding sandbox sandbox \(its Postgres is a new cluster: its data went with the old one\)/);
    expect(logs.join('\n')).toMatch(/its Postgres is a new cluster \(system identifier cluster-1 → cluster-2\)/);
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
    expect(r.reset?.base).toEqual({ action: 'taken', ms: 1 });
    expect((await state(p)).provider_state).toMatchObject({ cluster: 'cluster-2' });
  });

  it('FB-31: a new Postgres cluster in a named volume (a dump restored, say) — fresh only when empty; one holding data is refused, never frozen into a base', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    newServer();
    cluster.empty = false; // the app's data restored from a dump, a take's rows among it
    expect((await sb.status()).snapshot).toMatchObject({ state: 'outdated', next: 'refuse', base: false, new_cluster: true });
    calls = [];
    await expect(sb.reset()).rejects.toThrow(/the database already holds data and there is no base or snapshot to start from/);
    expect(calls).toEqual([]);
    expect(cluster.base).toBe(false);
    // The seed and snapshot of the old cluster are forgotten; the reset that used the database is kept.
    const st = await state(p);
    expect(st.seed).toBeUndefined();
    expect(st.last_reset).toBeDefined();
    // Emptied (the dump dropped): its first seed with a base.
    cluster.empty = true;
    calls = [];
    expect((await sb.reset()).base).toEqual({ action: 'taken', ms: 1 });
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
  });

  it('FB-31: a tmpfs database already stopped at down (where it lives not read) — the records kept, and the next up reads it and seeds the new cluster', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    storage = { kind: 'tmpfs', where: '/var/lib/postgresql/data' };
    bootLoads = true;
    await sb.up();
    // down cannot read where the data lives (the database's service stopped already): the fake then answers nothing.
    const fake = fakeProvider();
    const stopped = new Sandbox(p, p.sandboxes!.sandbox, PERSON_POLICY, resolveSecretRef, packageHooks).withDeps({
      provider: () => ({ ...fake, publishedBy: async () => Promise.reject(new Error('not published')) }),
      openSnapshot: async (t) => fakeSnapshot(t),
    });
    expect((await stopped.down()).forgotten).toBeUndefined();
    expect((await state(p)).seed).toBeDefined();
    calls = [];
    await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
  });

  it('FB-31: --forget with --volumes, and on a sandbox whose data the provider cannot place — the records go, the next up seeds', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    const down = await sb.down({ volumes: true, forget: true });
    expect(down).toMatchObject({ dataGone: true, forgotten: 'asked' });
    expect(calls.at(-1)).toBe('down --volumes');
    expect((await state(p)).provider_state).toEqual({});
    calls = [];
    await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
  });

  it('FB-31: a state written before the cluster was recorded, its tmpfs data gone — the refusal proposes down then up (never a command without effect), and down forgets', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    const st = await state(p);
    const ps = st.provider_state as Record<string, unknown>;
    delete ps.cluster;
    await writeFile(join(p.dir, '.retake', 'sandbox', 'sandbox', 'state.json'), JSON.stringify(st));
    storage = { kind: 'tmpfs', where: '/var/lib/postgresql/data' };
    newServer();
    cluster.empty = false;
    calls = [];
    await expect(sb.reset()).rejects.toThrow(
      /Start from a fresh database: retake sandbox down p-\w+ --env sandbox, then retake sandbox up p-\w+ --env sandbox — its database keeps its data in memory \(a tmpfs on \/var\/lib\/postgresql\/data\): every down removes it and forgets the seed/,
    );
    expect(calls).toEqual([]);
    await sb.down();
    calls = [];
    bootLoads = true;
    await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
  });

  it('FB-31: where the data lives is not known — the refusal proposes down --volumes --forget and says what --forget alone does; --forget forgets the records (nothing deleted) so the next up seeds', async () => {
    const p = await project(false);
    const sb = sandboxOf(p);
    await sb.up();
    const st = await state(p);
    delete (st.provider_state as Record<string, unknown>).cluster;
    await writeFile(join(p.dir, '.retake', 'sandbox', 'sandbox', 'state.json'), JSON.stringify(st));
    storage = { kind: 'unknown' };
    Object.assign(cluster, { template: { present: false, comment: null }, base: false, empty: false });
    const refusal = sb.reset();
    await expect(refusal).rejects.toThrow(
      /Start from a fresh database: retake sandbox down p-\w+ --env sandbox --volumes --forget \(it deletes every volume of the sandbox and forgets the seed, reset and snapshot records\), then retake sandbox up p-\w+ --env sandbox — where its database keeps its data could not be read\. --forget alone deletes nothing: the next up then takes whatever data is left as a fresh database/,
    );
    await expect(refusal).rejects.not.toThrow(/--volumes \(it deletes every volume/);
    calls = [];
    expect(await sb.down({ forget: true })).toMatchObject({ dataGone: true, forgotten: 'asked' });
    expect(calls).toEqual(['down']);
    const after = await state(p);
    expect(after.seed).toBeUndefined();
    expect(after.last_reset).toBeUndefined();
    expect(after.provider_state).toEqual({});
    calls = [];
    await sb.up();
    expect(calls).toEqual(['ensureDatabase', 'takeBase', 'seed', 'take']);
  });
});
