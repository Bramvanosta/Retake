/**
 * Sandbox mode (L1.8) in the hooks runner: the `seed` phase (stops at the first failure, nothing rolled back, no
 * destructive confirmation, no js), `ctx.baseDir` (sql files and shell working directories relative to a sandbox's
 * folder), journal replays that reach the databases of the environment each entry ran in, and the pending rollbacks a
 * sandbox reset supersedes.
 */
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Journal, SEED_NO_JS, findPendingJournals, rollbackPendingJournals, runHooks, standaloneJournalFile, supersedePendingJournals } from '@retake/hooks';
import type { HookStep, LoadedProject } from '@retake/core';
import { closedPort, makeContext, makeProject, startApi, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let api: Awaited<ReturnType<typeof startApi>>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  tmp = await tempProject('retake-seed-');
  api.requests.length = 0;
});
afterEach(async () => {
  await tmp.cleanup();
});

/** The project with a sandbox environment `sandbox` (its own databases) next to `local` and `staging`. */
function sandboxProject(sandboxDb: string, projectDb = 'postgres://staging@db.staging.example.com:5432/app'): LoadedProject {
  const p = makeProject(tmp.dir, { console: api.base }, { databases: { main: { url: projectDb } } });
  p.config.environments.sandbox = { console: api.base };
  p.config.environment_settings = {
    sandbox: { sandbox: { file: join(tmp.dir, 'sandbox', 'sandbox.yaml'), provider: 'process' }, databases: { main: { url: sandboxDb } } },
  };
  return p;
}

function seedContext(project: LoadedProject, over: Parameters<typeof makeContext>[1] = {}) {
  return makeContext(project, {
    env: { name: 'sandbox', pages: { ...project.config.environments.sandbox }, sandbox: { file: join(tmp.dir, 'sandbox', 'sandbox.yaml'), provider: 'process' } },
    runId: 'seed-1',
    baseDir: join(tmp.dir, 'sandbox'),
    ...over,
  });
}

const journalFile = () => join(tmp.dir, '.retake', 'sandbox', 'sandbox', 'seed-journal.json');

describe('runHooks: seed (L1.8)', () => {
  it('stops at the first failure, rolls nothing back, journals phase seed (and the journal reopens)', async () => {
    await writeFiles(tmp.dir, { 'sandbox/.keep': '' });
    const { ctx, logText } = seedContext(sandboxProject('postgres://u@localhost:1/app'));
    const journal = await Journal.open(journalFile());
    const steps: HookStep[] = [
      { name: 'a', http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'seeded' }, rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}' } } },
      { name: 'b', http: { url: '{{console}}/status/500' } },
      { name: 'c', shell: 'echo c > c.txt' },
    ];
    const res = await runHooks(steps, ctx, { phase: 'seed', journal });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => [r.name, r.phase, r.status])).toEqual([
      ['a', 'seed', 'ok'],
      ['b', 'seed', 'failed'],
    ]);
    // Nothing rolled back: the reply created by step a is still there; step c never ran.
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/replies', 'GET /status/500']);
    expect(existsSync(join(tmp.dir, 'sandbox', 'c.txt'))).toBe(false);
    expect(logText()).toContain('warn seed stopped: 1 remaining hook(s) not run');
    expect(logText()).toContain('debug rollback of a seed hook is ignored (only setup and step hooks are rolled back)');
    const again = await Journal.open(journalFile());
    expect(again.entries.map((e) => [e.name, e.phase, e.status, e.env, e.rollback])).toEqual([
      ['a', 'seed', 'ok', 'sandbox', undefined],
      ['b', 'seed', 'failed', 'sandbox', undefined],
    ]);
    expect(again.pending()).toEqual([]);
  });

  it('runs a destructive step without asking (no confirm: true); a js step refuses the whole seed before anything runs', async () => {
    await writeFiles(tmp.dir, { 'sandbox/.keep': '' });
    const asked: string[] = [];
    const { ctx } = seedContext(sandboxProject('postgres://u@localhost:1/app'), { confirmDestructive: (d) => (asked.push(d), false) });
    const journal = await Journal.open(journalFile());
    api.replies.set(7, { id: 7, text: 'old' });
    const del = await runHooks([{ http: { method: 'DELETE', url: '{{console}}/api/replies/7' } }], ctx, { phase: 'seed', journal });
    expect(del.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(api.replies.has(7)).toBe(false);
    // The same step in a setup is refused without confirm.
    const setup = await runHooks([{ http: { method: 'DELETE', url: '{{console}}/api/replies/8' } }], { ...ctx, baseDir: undefined }, { phase: 'setup', journal });
    expect(setup.results[0].status).toBe('refused');
    api.requests.length = 0;
    const js = await runHooks([{ shell: 'echo x > x.txt' }, { js: 'return 1' }], ctx, { phase: 'seed', journal });
    expect(js.ok).toBe(false);
    expect(js.results).toEqual([expect.objectContaining({ index: 1, kind: 'js', status: 'failed', error: SEED_NO_JS })]);
    expect(existsSync(join(tmp.dir, 'sandbox', 'x.txt'))).toBe(false);
    // A dry seed reports it too (per step).
    const dry = await runHooks([{ js: 'return 1' }], { ...ctx, dryRun: true }, { phase: 'seed', journal });
    expect(dry.results[0]).toMatchObject({ status: 'failed', error: SEED_NO_JS });
  });

  it('baseDir: sql files and shell working directories are relative to the sandbox folder', async () => {
    await writeFiles(tmp.dir, { 'sandbox/seed/01.sql': 'INSERT INTO t VALUES (1);\n', 'sandbox/scripts/.keep': '', 'other/.keep': '' });
    const port = await closedPort();
    const { ctx } = seedContext(sandboxProject(`postgres://u@127.0.0.1:${port}/app`));
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ shell: { run: 'pwd > where.txt', cwd: 'scripts' } }, { shell: 'pwd > root.txt' }], ctx, { phase: 'seed', journal });
    expect(res.ok).toBe(true);
    expect((await readFile(join(tmp.dir, 'sandbox', 'scripts', 'where.txt'), 'utf8')).trim()).toMatch(/sandbox\/scripts$/);
    expect(existsSync(join(tmp.dir, 'sandbox', 'root.txt'))).toBe(true);
    // The SQL file is read from the sandbox folder; the connection then goes to the sandbox's own database.
    const sql = await runHooks([{ sql: 'seed/01.sql' }], ctx, { phase: 'seed', journal });
    expect(sql.results[0].error).toMatch(new RegExp(`^cannot connect to database main \\(127\\.0\\.0\\.1:${port}/app\\)`));
    const missing = await runHooks([{ sql: 'seed/02.sql' }], ctx, { phase: 'seed', journal });
    expect(missing.results[0].error).toBe(`SQL file seed/02.sql not found (looked for ${join(tmp.dir, 'sandbox', 'seed', '02.sql')})`);
    // Without baseDir (a scenario's hooks): the project dir, as before.
    const project = await runHooks([{ sql: 'seed/01.sql' }], { ...ctx, baseDir: undefined }, { phase: 'setup', journal });
    expect(project.results[0].error).toBe(`SQL file seed/01.sql not found (looked for ${join(tmp.dir, 'seed', '01.sql')})`);
  });

  it('a sql hook on a sandbox reaches its databases only: no plain-password warning, unknown keys name its sandbox.yaml', async () => {
    const port = await closedPort();
    const { ctx, logText } = seedContext(sandboxProject(`postgres://demo:sandbox-db-4632@127.0.0.1:${port}/app`));
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ sql: { query: 'SELECT 1', db: 'main' } }, { sql: { query: 'SELECT 1', db: 'analytics' } }], ctx, { phase: 'teardown', journal });
    expect(res.results[0].error).toMatch(new RegExp(`^cannot connect to database main \\(127\\.0\\.0\\.1:${port}/app\\)`));
    expect(res.results[1].error).toBe('unknown database "analytics" (the sandbox.yaml of sandbox sandbox declares: main)');
    expect(logText()).not.toContain('clear-text password');
    expect(logText()).not.toContain('sandbox-db-4632');
    const empty = sandboxProject('x');
    delete empty.config.environment_settings!.sandbox.databases;
    const none = await runHooks([{ sql: 'SELECT 1' }], seedContext(empty).ctx, { phase: 'teardown', journal });
    expect(none.results[0].error).toBe('sql hooks need a database: add `databases: {main: {url: "postgres://…"}}` to the sandbox.yaml of sandbox sandbox');
  });
});

describe('shell commands on a sandbox and interrupts (L1.8 review)', () => {
  /** The sandbox project, with its manifest's process services (their `env`) loaded as core would. */
  function withServices(services: Record<string, Record<string, string>>): LoadedProject {
    const p = sandboxProject('postgres://u@localhost:1/app');
    p.sandboxes = {
      sandbox: {
        env: 'sandbox',
        file: join(tmp.dir, 'sandbox', 'sandbox.yaml'),
        dir: join(tmp.dir, 'sandbox'),
        manifest: { version: 1, provider: 'process', services: Object.fromEntries(Object.entries(services).map(([n, env]) => [n, { command: 'x', env }])) },
        issues: [],
        secrets: {},
      },
    };
    return p;
  }

  it("a shell step gets the env of the sandbox's process services and RETAKE_SANDBOX over the CLI's own; its own env wins (I3)", async () => {
    await writeFiles(tmp.dir, { 'sandbox/.keep': '' });
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://me@localhost:5432/my_own_dev_db';
    try {
      const project = withServices({
        web: { DATABASE_URL: 'postgres://demo:sandbox-db-4702@localhost:4702/app', API: '{{console}}/api' },
        worker: { DATABASE_URL: 'postgres://demo:sandbox-db-4702@localhost:4702/app' },
      });
      const { ctx } = seedContext(project);
      const journal = await Journal.open(journalFile());
      const res = await runHooks(
        [
          { shell: 'echo "$DATABASE_URL $RETAKE_SANDBOX $API" > env.txt' },
          { shell: { run: 'echo "$DATABASE_URL" > own.txt', env: { DATABASE_URL: 'postgres://demo:sandbox-db-4702@localhost:4702/other' } } },
        ],
        ctx,
        { phase: 'seed', journal },
      );
      expect(res.ok).toBe(true);
      expect((await readFile(join(tmp.dir, 'sandbox', 'env.txt'), 'utf8')).trim()).toBe(`postgres://demo:sandbox-db-4702@localhost:4702/app sandbox ${api.base}/api`);
      expect((await readFile(join(tmp.dir, 'sandbox', 'own.txt'), 'utf8')).trim()).toBe('postgres://demo:sandbox-db-4702@localhost:4702/other');
      // Two services setting it differently: the command must set it itself.
      const conflict = withServices({ web: { DATABASE_URL: 'postgres://a@localhost:4702/app' }, worker: { DATABASE_URL: 'postgres://a@localhost:4702/jobs' } });
      const bad = await runHooks([{ shell: 'echo x' }], seedContext(conflict).ctx, { phase: 'seed', journal });
      expect(bad.results[0]).toMatchObject({ status: 'failed', error: "services web and worker of sandbox sandbox set DATABASE_URL differently: set DATABASE_URL in the shell command's own `env`" });
      // Another environment: Retake's own environment, as before.
      const local = await runHooks([{ shell: 'echo "$DATABASE_URL" > local.txt' }], makeContext(project, { baseDir: join(tmp.dir, 'sandbox') }).ctx, { phase: 'setup', journal });
      expect(local.ok).toBe(true);
      expect((await readFile(join(tmp.dir, 'sandbox', 'local.txt'), 'utf8')).trim()).toBe('postgres://me@localhost:5432/my_own_dev_db');
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });

  it('an interrupt stops a running shell step and its whole process group; nothing after it runs; the group is listed while it runs (P4)', async () => {
    await writeFiles(tmp.dir, { 'sandbox/.keep': '' });
    const ac = new AbortController();
    const running = new Set<number>();
    const { ctx, logText } = seedContext(sandboxProject('postgres://u@localhost:1/app'), { signal: ac.signal, running });
    const journal = await Journal.open(journalFile());
    let seen: number[] = [];
    setTimeout(() => {
      seen = [...running];
      ac.abort();
    }, 400);
    const t0 = Date.now();
    const res = await runHooks([{ shell: 'sleep 30 & echo $! > child.pid; wait' }, { shell: 'echo never > after.txt' }], ctx, { phase: 'seed', journal });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.ok).toBe(false);
    expect(res.results).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringMatching(/was interrupted \(its process group stopped\)$/) })]);
    expect(seen.length).toBe(1);
    expect(logText()).toContain('warn seed stopped: 1 remaining hook(s) not run');
    expect(existsSync(join(tmp.dir, 'sandbox', 'after.txt'))).toBe(false);
    const child = Number((await readFile(join(tmp.dir, 'sandbox', 'child.pid'), 'utf8')).trim());
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(child, 0)).toThrow();
    // Nothing runs once interrupted.
    const after = await runHooks([{ shell: 'echo never > after.txt' }], ctx, { phase: 'seed', journal });
    expect(after.ok).toBe(false);
    expect(logText()).toContain('warn seed interrupted: 1 remaining hook(s) not run');
    expect(existsSync(join(tmp.dir, 'sandbox', 'after.txt'))).toBe(false);
  });

  it('a sandbox database whose URL would connect elsewhere (?port=, ?host=, a socket) is refused before connecting (K1)', async () => {
    const journal = await Journal.open(journalFile());
    for (const [url, why] of [
      ['postgres://demo:sandbox-db-4632@localhost:4632/app?port=5432', /would connect to localhost:5432\/app, not to the localhost:4632 its URL names/],
      ['postgres://demo:sandbox-db-4632@localhost:4632/app?host=/tmp', /through the unix socket \/tmp/],
      ['postgres://demo:sandbox-db-4632@localhost:4632/app?host=db.example.com', /would connect to db\.example\.com:4632\/app/],
    ] as const) {
      const { ctx } = seedContext(sandboxProject(url));
      const res = await runHooks([{ sql: 'SELECT 1' }], ctx, { phase: 'seed', journal });
      expect(res.results[0].status, url).toBe('refused');
      expect(res.results[0].error, url).toMatch(why);
    }
  });
});

describe("a docker-compose sandbox's database on the address Docker publishes it on (K3)", () => {
  it('a sql step connects to ctx.connectAddress (127.0.0.1), never where localhost resolves first (::1: another container may publish the same port there)', async () => {
    const hits: string[] = [];
    const listen = (host: string, port: number) =>
      new Promise<NetServer | null>((resolve) => {
        const s = createNetServer((sock) => {
          hits.push(host);
          sock.destroy();
        });
        s.once('error', () => resolve(null));
        s.listen(port, host, () => resolve(s));
      });
    const v4 = (await listen('127.0.0.1', 0))!;
    const port = (v4.address() as AddressInfo).port;
    const v6 = await listen('::1', port);
    try {
      const journal = await Journal.open(journalFile());
      const project = sandboxProject(`postgres://demo:sandbox-db-4632@localhost:${port}/app`);
      const seen: Array<[string, number]> = [];
      const pinned = seedContext(project, { connectAddress: (host, p) => (seen.push([host, p]), '127.0.0.1') });
      const res = await runHooks([{ sql: 'SELECT 1' }], pinned.ctx, { phase: 'seed', journal });
      expect(res.results[0].status).toBe('failed'); // not a Postgres server: what matters is where it connected
      expect(res.results[0].error).toMatch(new RegExp(`database main \\(localhost:${port}/app\\)`));
      expect(seen).toEqual([['localhost', port]]);
      expect(hits).toEqual(['127.0.0.1']);
      // Without it, localhost goes where the resolver says first (::1 on this machine when a listener is there).
      hits.length = 0;
      await runHooks([{ sql: 'SELECT 1' }], seedContext(project).ctx, { phase: 'seed', journal });
      const first = (await lookup('localhost', { all: true }))[0];
      if (v6 && first.family === 6) expect(hits).toEqual(['::1']);
    } finally {
      v4.close();
      v6?.close();
    }
  });
});

describe('journal replays after sandboxes (L1.8, critique 9)', () => {
  it("a sql rollback reaches the databases of the environment its entry ran in, not the command's", async () => {
    const sandboxPort = await closedPort();
    const project = sandboxProject(`postgres://u@127.0.0.1:${sandboxPort}/app`, 'postgres://u@127.0.0.1:1/staging');
    const file = standaloneJournalFile(tmp.dir, 'hooks-x');
    const journal = await Journal.open(file);
    await journal.record({
      kind: 'sql',
      phase: 'setup',
      description: 'sql (inline) on main',
      env: 'sandbox',
      started_at: '2026-10-13T10:00:00.000Z',
      finished_at: '2026-10-13T10:00:00.100Z',
      status: 'ok',
      rollback: { kind: 'sql', db: 'main', query: 'DELETE FROM t', description: 'inline rollback', data: {} },
    });
    // The command runs on `local` (project databases: main = staging): the replay still goes to the sandbox's main.
    const { ctx } = makeContext(project, { env: { name: 'local', pages: { console: api.base } } });
    const [out] = await rollbackPendingJournals(tmp.dir, ctx);
    expect(out.results[0].error).toMatch(new RegExp(`^cannot connect to database main \\(127\\.0\\.0\\.1:${sandboxPort}/app\\)`));
  });

  it('a sandbox reset supersedes the pending rollbacks recorded on it (both journal locations); others stay pending', async () => {
    const project = sandboxProject('postgres://u@localhost:1/app');
    const entry = (env: string, id: number) => ({
      kind: 'http' as const,
      phase: 'setup' as const,
      description: `POST reply ${id}`,
      env,
      started_at: '2026-10-13T10:00:00.000Z',
      finished_at: '2026-10-13T10:00:00.100Z',
      status: 'ok' as const,
      rollback: { kind: 'http' as const, request: { method: 'DELETE' as const, url: `${api.base}/api/replies/${id}` }, description: `DELETE reply ${id}`, data: {} },
    });
    const run = await Journal.open(join(tmp.dir, 'runs', '20261013-100000-quote', 'hooks-journal.json'));
    await run.record(entry('sandbox', 7));
    await run.record(entry('local', 8));
    const standalone = await Journal.open(standaloneJournalFile(tmp.dir, 'hooks-y'));
    await standalone.record(entry('sandbox', 9));
    expect(await supersedePendingJournals(tmp.dir, 'sandbox', 'sandbox-reset-1', {})).toEqual([
      { file: standaloneJournalFile(tmp.dir, 'hooks-y'), count: 1 },
      { file: join(tmp.dir, 'runs', '20261013-100000-quote', 'hooks-journal.json'), count: 1 },
    ]);
    const reread = await Journal.open(join(tmp.dir, 'runs', '20261013-100000-quote', 'hooks-journal.json'));
    expect(reread.entries.map((e) => [e.env, e.superseded?.by])).toEqual([
      ['sandbox', 'sandbox-reset-1'],
      ['local', undefined],
    ]);
    expect(reread.pending().map((e) => e.env)).toEqual(['local']);
    expect(await findPendingJournals(tmp.dir)).toEqual([join(tmp.dir, 'runs', '20261013-100000-quote', 'hooks-journal.json')]);
    // `retake env reset` replays only the local one: reply 7 (reseeded data) is never deleted.
    const { ctx } = makeContext(project);
    const outcomes = await rollbackPendingJournals(tmp.dir, ctx);
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['DELETE /api/replies/8']);
    expect(outcomes.flatMap((o) => o.results.map((r) => r.journal_seq))).toEqual([2]);
    expect(await supersedePendingJournals(tmp.dir, 'sandbox', 'sandbox-reset-2')).toEqual([]);
  });
});
