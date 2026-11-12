/**
 * L1.7 (R-ENV-04): a read-only run refuses hooks that write — http by method (a GraphQL query sent as POST reads),
 * sql by its statements, shell unless `writes: false`, a rollback with its hook — and a journal replay judges each
 * entry by the environment it ran in.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookSecurityError, Journal, runHooks } from '@retake/hooks';
import { WriteRefusedError } from '@retake/core';
import type { HookAccess, HookStep } from '@retake/core';
import { makeContext, makeProject, startApi, tempProject } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let api: Awaited<ReturnType<typeof startApi>>;
beforeEach(async () => {
  tmp = await tempProject();
  api = await startApi();
});
afterEach(async () => {
  await api.close();
  await tmp.cleanup();
});

const READ_ONLY: HookAccess = { env: 'production', mode: 'read-only', production: true, configured: 'read-only' };
const NO_FLAG: HookAccess = { env: 'live', mode: 'read-only', production: true, configured: 'read-write' };
const journalAt = (id = 'r1') => Journal.open(join(tmp.dir, `runs/${id}/hooks-journal.json`));

function context(access: HookAccess | undefined, over: Parameters<typeof makeContext>[1] = {}) {
  const project = makeProject(tmp.dir, { console: api.base }, { databases: { main: { url: 'postgres://app@localhost:1/northfield' } } });
  return makeContext(project, { ...(access ? { access } : {}), ...over });
}

describe('hooks on a read-only run', () => {
  it('refuses an http write before sending it; reads run; optional does not tolerate the refusal', async () => {
    const { ctx } = context(READ_ONLY);
    const hooks: HookStep[] = [
      { name: 'list', http: { url: '{{console}}/api/replies' } },
      { name: 'reply', optional: true, http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'x' } } },
      { name: 'after', http: { url: '{{console}}/api/replies' } },
    ];
    const res = await runHooks(hooks, ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => [r.name, r.status])).toEqual([
      ['list', 'ok'],
      ['reply', 'refused'],
    ]);
    expect(res.results[1].error).toBe(
      'refusing a hook that writes (HTTP POST) on read-only environment production: hooks that write run on a read-write environment only (environment production is production, read-only in project.yaml); `optional: true` does not skip a refusal',
    );
    expect(api.requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a production environment that allows writes: refused without --allow-writes, run with it', async () => {
    const hook: HookStep = { http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'hello' } } };
    const refused = await runHooks([hook], context(NO_FLAG).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(refused.results[0].status).toBe('refused');
    expect(refused.results[0].error).toMatch(/on read-only environment live: pass --allow-writes to let it write to production;/);
    const allowed = await runHooks([hook], context({ ...NO_FLAG, mode: 'read-write' }).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(allowed.results[0]).toMatchObject({ status: 'ok', message: '201 Created' });
    expect(api.requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('a GraphQL query sent as POST reads; a mutation writes', async () => {
    const query: HookStep = { http: { method: 'POST', url: '{{console}}/graphql', json: { query: 'query Health { ok }' }, expect: 404 } };
    const mutation: HookStep = { http: { method: 'POST', url: '{{console}}/graphql', json: { query: 'mutation Reset { reset }' }, expect: 404 } };
    const res = await runHooks([query, mutation], context(READ_ONLY).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'refused']);
    expect(res.results[1].error).toMatch(/^refusing a hook that writes \(GraphQL mutation Reset\)/);
    expect(api.requests).toHaveLength(1);
  });

  it('a read hook whose rollback writes is refused with it (its rollback would run at teardown)', async () => {
    const hook: HookStep = { http: { url: '{{console}}/api/replies', rollback: { method: 'DELETE', url: '{{console}}/api/replies/1' } } };
    const res = await runHooks([hook], context(READ_ONLY).ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.results[0]).toMatchObject({ status: 'refused' });
    expect(res.results[0].error).toMatch(/^refusing a hook that writes \(its rollback: HTTP DELETE\)/);
    expect(api.requests).toEqual([]);
  });

  it('sql: statements that write are refused before any connection; reads run in a read-only transaction', async () => {
    const res = await runHooks([{ sql: 'UPDATE quotes SET seen = true' }], context(READ_ONLY).ctx, { phase: 'setup', journal: await journalAt() });
    // Refused, not failed: no connection was attempted (nothing listens on port 1).
    expect(res.results[0]).toMatchObject({ status: 'refused' });
    expect(res.results[0].error).toMatch(/^refusing a hook that writes \(SQL UPDATE\)/);
    const dry = await runHooks([{ sql: 'SELECT count(*) FROM quotes' }, { sql: 'SELECT * INTO copy FROM quotes' }], context(READ_ONLY, { dryRun: true }).ctx, {
      phase: 'teardown',
      journal: await journalAt(),
    });
    expect(dry.results.map((r) => r.status)).toEqual(['dry', 'refused']);
    expect(dry.results[1].error).toMatch(/\(SQL SELECT … INTO creates a table\)/);
  });

  it('shell: refused unless `writes: false`; a destructive command still is', async () => {
    const hooks: HookStep[] = [
      { name: 'read', shell: 'echo hello > /dev/null', writes: false },
      { name: 'write', shell: 'echo ran > ran.txt' },
    ];
    const res = await runHooks(hooks, context(READ_ONLY).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(res.results.map((r) => [r.name, r.status])).toEqual([
      ['read', 'ok'],
      ['write', 'refused'],
    ]);
    expect(res.results[1].error).toMatch(/\(a shell command — add `writes: false` to a shell hook that only reads\)/);
    expect(existsSync(join(tmp.dir, 'ran.txt'))).toBe(false);
    // A read-only refusal comes first: no destructive prompt for it.
    let asked = false;
    const rm = await runHooks([{ shell: 'rm -f ran.txt', writes: false }], context(READ_ONLY, { confirmDestructive: () => (asked = true) }).ctx, {
      phase: 'teardown',
      journal: await journalAt(),
    });
    expect(rm.results[0].error).toMatch(/\(shell rm, although it declares writes: false\)/);
    expect(asked).toBe(false);
  });

  it('js: runs (its tab guards its requests); a rollback is a write', async () => {
    const evals: string[] = [];
    const { ctx } = context(READ_ONLY, { evalInPage: async (_page, code) => (evals.push(code), 'ok') });
    const res = await runHooks([{ js: 'return document.title' }, { js: { code: 'return 1', rollback: 'localStorage.clear()' } }], ctx, {
      phase: 'setup',
      journal: await journalAt(),
    });
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'refused']);
    expect(res.results[1].error).toMatch(/\(its rollback: JavaScript run in the page\)/);
    expect(evals).toEqual(['return document.title']);
  });

  it('js: a write its tab stopped (core WriteRefusedError) refuses the hook — optional does not tolerate it', async () => {
    const { ctx } = context(READ_ONLY, {
      evalInPage: async () => {
        throw new WriteRefusedError(['POST console:/api/replies'], 'production', { detail: 'the hook threw: TypeError: Failed to fetch' });
      },
    });
    const res = await runHooks([{ optional: true, js: "await fetch('/api/replies', { method: 'POST' })" }], ctx, { phase: 'setup', journal: await journalAt() });
    expect(res.results[0].status).toBe('refused');
    expect(res.results[0].error).toBe(
      'refusing a hook that writes (POST console:/api/replies, stopped in its tab) on read-only environment production: hooks that write run on a read-write environment only (environment production is production, read-only in project.yaml); `optional: true` does not skip a refusal; the hook threw: TypeError: Failed to fetch',
    );
  });

  it('a dry run reports the refusal; read-write runs are unchanged', async () => {
    const hook: HookStep = { http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'x' } } };
    const { ctx, logText } = context(READ_ONLY, { dryRun: true });
    const dry = await runHooks([hook], ctx, { phase: 'setup', journal: await journalAt() });
    expect(dry.results[0].status).toBe('refused');
    expect(logText()).toContain('error setup hook 1/1 refused: http POST');
    const rw = await runHooks([hook], context(undefined).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(rw.results[0].status).toBe('ok');
  });

  it('HookSecurityError carries the read-only reason', () => {
    expect(new HookSecurityError('x', 'read-only').reason).toBe('read-only');
  });
});

describe('hosts of another, read-only environment: refused in any run (R-ENV-04)', () => {
  // A run on a read-write environment (local) of a project whose production environment is on 127.0.0.1.
  const PROD = { env: 'production', production: true, configured: 'read-only' as const };
  const CROSS: HookAccess = { env: 'local', mode: 'read-write', protected: [{ host: '127.0.0.1', ...PROD }], writable: ['localhost'] };

  it('http: a write to it is refused before it is sent, a read runs; a redirect hop that writes to it is refused', async () => {
    const res = await runHooks(
      [
        { name: 'list', http: { url: '{{console}}/api/replies' } },
        { name: 'reset', http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'x' } } },
      ],
      context(CROSS).ctx,
      { phase: 'teardown', journal: await journalAt() },
    );
    expect(res.results.map((r) => [r.name, r.status])).toEqual([
      ['list', 'ok'],
      ['reset', 'refused'],
    ]);
    expect(res.results[1].error).toBe(
      'refusing a hook that writes (HTTP POST) to 127.0.0.1, a host of environment production — this run is on environment local: environment production is production, read-only in project.yaml; `optional: true` does not skip a refusal',
    );
    // localhost is the run's own host; its redirect (302 keeps a PUT) to production's host is refused at that hop.
    const local = api.base.replace('127.0.0.1', 'localhost');
    const hop = await runHooks([{ http: { method: 'PUT', url: `${local}/redirect?to=${encodeURIComponent(`${api.base}/api/replies/1`)}`, json: {} } }], context(CROSS).ctx, {
      phase: 'teardown',
      journal: await journalAt(),
    });
    expect(hop.results[0].status).toBe('refused');
    expect(hop.results[0].error).toMatch(/^refusing a hook that writes \(HTTP PUT\) to 127\.0\.0\.1, a host of environment production/);
    expect(api.requests.map((r) => `${r.method} ${r.url.split('?')[0]}`)).toEqual(['GET /api/replies', 'PUT /redirect']);
  });

  it('shell and sql: refused when they write to it (nothing runs, no connection); a shell hook that only reads runs', async () => {
    const shell = await runHooks(
      [
        { name: 'read', shell: 'echo http://127.0.0.1:1/x > /dev/null', writes: false },
        { name: 'write', shell: 'echo http://127.0.0.1:1/x > ran.txt' },
      ],
      context(CROSS).ctx,
      { phase: 'teardown', journal: await journalAt() },
    );
    expect(shell.results.map((r) => [r.name, r.status])).toEqual([
      ['read', 'ok'],
      ['write', 'refused'],
    ]);
    expect(existsSync(join(tmp.dir, 'ran.txt'))).toBe(false);
    // The database host (localhost here) of a production environment.
    const db: HookAccess = { env: 'local', mode: 'read-write', protected: [{ host: 'localhost', ...PROD }], writable: [] };
    const sql = await runHooks([{ sql: 'UPDATE quotes SET seen = true' }], context(db).ctx, { phase: 'teardown', journal: await journalAt() });
    expect(sql.results[0]).toMatchObject({ status: 'refused' });
    expect(sql.results[0].error).toMatch(/^refusing a hook that writes \(SQL UPDATE\) to localhost, a host of environment production/);
  });

  it('--allow-writes where production allows writes: the host is not protected (crossEnvironmentHosts), the hook runs', async () => {
    const res = await runHooks(
      [{ http: { method: 'POST', url: '{{console}}/api/replies', json: { text: 'x' } } }],
      context({ env: 'local', mode: 'read-write', protected: [], writable: ['localhost'] }).ctx,
      {
        phase: 'teardown',
        journal: await journalAt(),
      },
    );
    expect(res.results[0].status).toBe('ok');
  });

  it("js: a write its tab stopped on another environment's host names that environment", async () => {
    const { ctx } = context(CROSS, {
      evalInPage: async () => {
        throw new WriteRefusedError(['POST 127.0.0.1/api/replies'], 'local', { protectedBy: 'production', detail: 'the hook threw: TypeError: Failed to fetch' });
      },
    });
    const res = await runHooks([{ js: "await fetch('http://127.0.0.1/api/replies', { method: 'POST' })" }], ctx, { phase: 'teardown', journal: await journalAt() });
    expect(res.results[0].status).toBe('refused');
    expect(res.results[0].error).toBe(
      'refusing a hook that writes (POST 127.0.0.1/api/replies, stopped in its tab) to a host of environment production — this run is on environment local: environment production is production, read-only in project.yaml; `optional: true` does not skip a refusal; the hook threw: TypeError: Failed to fetch',
    );
  });
});

describe('journal replays judge each entry by its own environment', () => {
  async function journalWithPending(env: string) {
    const journal = await journalAt('prod-run');
    await journal.record({
      kind: 'http',
      phase: 'setup',
      description: 'http POST {{console}}/api/replies',
      env,
      started_at: '2026-10-13T08:00:00.000Z',
      finished_at: '2026-10-13T08:00:01.000Z',
      status: 'ok',
      rollback: { kind: 'http', request: { method: 'DELETE', url: '{{console}}/api/replies/42' }, data: { pages: { console: api.base } }, description: 'http DELETE …/api/replies/42' },
    });
    return journal;
  }

  it('a production entry is not replayed by a command on a read-write environment without --allow-writes', async () => {
    const journal = await journalWithPending('live');
    // The command runs on `local` (read-write); `live` is production with access: read-write, no --allow-writes.
    const { ctx } = context({ env: 'local', mode: 'read-write' }, { accessOf: (name) => (name === 'live' ? NO_FLAG : undefined) });
    const results = await journal.rollbackAll(ctx);
    expect(results[0]).toMatchObject({ phase: 'rollback', status: 'refused', ok: false });
    expect(results[0].error).toMatch(/^refusing a hook that writes \(its rollback: HTTP DELETE\) on read-only environment live: pass --allow-writes/);
    expect(api.requests).toEqual([]);
    expect(journal.pending()).toHaveLength(1);
    expect(journal.pending()[0].rollback_attempts).toBeUndefined();

    // With --allow-writes the entry's environment is read-write: replayed.
    await fetch(`${api.base}/api/replies`, { method: 'POST', body: '{"text":"seeded"}' }); // reply 42
    const allowed = context({ env: 'local', mode: 'read-write' }, { accessOf: (name) => (name === 'live' ? { ...NO_FLAG, mode: 'read-write' as const } : undefined) });
    const again = await (await journalAt('prod-run')).rollbackAll(allowed.ctx);
    expect(again[0]).toMatchObject({ status: 'ok' });
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/replies', 'DELETE /api/replies/42']);
  });

  it('an entry of an environment no longer in project.yaml takes the command access', async () => {
    const journal = await journalWithPending('gone');
    const res = await journal.rollbackAll(context(READ_ONLY, { accessOf: () => undefined }).ctx);
    expect(res[0].status).toBe('refused');
    const dry = await (await journalAt('prod-run')).rollbackAll(context(READ_ONLY, { dryRun: true }).ctx);
    expect(dry[0].status).toBe('refused');
  });
});
