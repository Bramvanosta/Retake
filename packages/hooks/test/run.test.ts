import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JS_NEEDS_PAGE, Journal, runHooks } from '@demo-studio/hooks';
import type { HookStep } from '@demo-studio/core';
import { makeContext, makeProject, startApi, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let api: Awaited<ReturnType<typeof startApi>>;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  tmp = await tempProject();
  api.requests.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

const lines = async (file: string) => (await readFile(join(tmp.dir, file), 'utf8')).trim().split('\n');

function env() {
  const project = makeProject(tmp.dir, { console: api.base });
  return { project, ...makeContext(project, { runId: '20261011-142233-catalogue' }) };
}

const journalFile = () => join(tmp.dir, 'runs/20261011-142233-catalogue/hooks-journal.json');

/** A shell hook appending to order.log, undone by another line. */
const step = (name: string, extra: Partial<{ fail: boolean; optional: boolean }> = {}): HookStep => ({
  name,
  ...(extra.optional ? { optional: true } : {}),
  shell: {
    run: extra.fail ? `echo ${name} >> order.log; echo "${name} broke" >&2; exit 3` : `echo ${name} >> order.log`,
    rollback: `echo undo-${name} >> order.log`,
  },
});

describe('runHooks: setup', () => {
  it('runs hooks in order and journals their rollbacks', async () => {
    const { ctx, logText } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a'), step('b')], ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => [r.name, r.status, r.message])).toEqual([
      ['a', 'ok', 'exit 0'],
      ['b', 'ok', 'exit 0'],
    ]);
    expect(await lines('order.log')).toEqual(['a', 'b']);
    expect(journal.pending().map((e) => e.name)).toEqual(['a', 'b']);
    expect(journal.pending()[0]).toMatchObject({ phase: 'setup', run_id: '20261011-142233-catalogue', env: 'local' });
    expect(logText()).toContain('info setup hook 1/2: a: shell "echo a >> order.log"');
  });

  it('stops at the first failure and rolls back the completed hooks in reverse order', async () => {
    const { ctx, logText } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a'), step('b'), step('c', { fail: true }), step('d')], ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(false);
    expect(await lines('order.log')).toEqual(['a', 'b', 'c', 'undo-b', 'undo-a']);
    expect(res.results.map((r) => [r.phase, r.name, r.status])).toEqual([
      ['setup', 'a', 'ok'],
      ['setup', 'b', 'ok'],
      ['setup', 'c', 'failed'],
      ['rollback', 'b', 'ok'],
      ['rollback', 'a', 'ok'],
    ]);
    expect(res.results[2].error).toBe('shell "echo c >> order.log; echo "c broke" >&2; exit 3" exited with code 3: c broke');
    expect(journal.pending()).toEqual([]);
    expect(journal.entries.map((e) => e.status)).toEqual(['rolled_back', 'rolled_back', 'failed']);
    expect(logText()).toContain('warn setup stopped: 1 remaining hook(s) not run');
  });

  it('only rolls back the hooks of this call', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    await runHooks([step('earlier')], ctx, { phase: 'setup', journal });
    const res = await runHooks([step('a'), step('b', { fail: true })], ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(false);
    expect(await lines('order.log')).toEqual(['earlier', 'a', 'b', 'undo-a']);
    expect(journal.pending().map((e) => e.name)).toEqual(['earlier']);
  });

  it('optional hooks may fail without stopping setup', async () => {
    const { ctx, logText } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a'), step('b', { fail: true, optional: true }), step('c')], ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => [r.status, r.optional])).toEqual([
      ['ok', undefined],
      ['failed', true],
      ['ok', undefined],
    ]);
    expect(await lines('order.log')).toEqual(['a', 'b', 'c']);
    expect(logText()).toContain('warn setup hook 2/3 is optional: continuing');
  });

  it('refuses to start when a js hook has no page to run in', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a'), { js: 'window.localStorage.clear()' }], ctx, { phase: 'setup', journal });
    expect(res).toMatchObject({ ok: false, results: [{ index: 1, kind: 'js', status: 'failed', error: JS_NEEDS_PAGE }] });
    expect(existsSync(join(tmp.dir, 'order.log'))).toBe(false);
    expect(existsSync(journalFile())).toBe(false);
  });

  it('refuses malformed hooks', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ shell: 'true', sql: 'select 1' } as unknown as HookStep], ctx, { phase: 'setup', journal });
    expect(res.results[0].error).toBe('a hook has several types (sql, shell); split it into separate hooks');
  });
});

describe('runHooks: teardown and reset', () => {
  it('teardown runs every hook and collects the failures', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a', { fail: true }), step('b'), step('c', { fail: true }), step('d')], ctx, {
      phase: 'teardown',
      journal,
    });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'ok', 'failed', 'ok']);
    expect(await lines('order.log')).toEqual(['a', 'b', 'c', 'd']);
    // teardown hooks are journaled for the record, but never rolled back
    expect(journal.entries.map((e) => [e.phase, e.status])).toEqual([
      ['teardown', 'failed'],
      ['teardown', 'ok'],
      ['teardown', 'failed'],
      ['teardown', 'ok'],
    ]);
    expect(journal.pending()).toEqual([]);
  });

  it('reset behaves like teardown', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([step('a', { fail: true }), step('b')], ctx, { phase: 'reset', journal });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => [r.phase, r.status])).toEqual([
      ['reset', 'failed'],
      ['reset', 'ok'],
    ]);
  });
});

describe('shell hooks', () => {
  it('run in the project dir with templated env merged over the process env', async () => {
    const { ctx } = env();
    ctx.vars = { greeting: 'Welcome to Northfield' };
    await writeFiles(tmp.dir, { 'scripts/.keep': '' });
    const journal = await Journal.open(journalFile());
    const res = await runHooks(
      [
        {
          shell: {
            run: 'echo "$GREETING|$DEMO_STUDIO_ENV|$DEMO_STUDIO_RUN_ID|$(basename "$PWD")|${HOME:+home}" > out.txt',
            env: { GREETING: '{{vars.greeting}} ({{console}})' },
          },
        },
        { shell: { run: 'pwd > where.txt', cwd: 'scripts' } },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.ok).toBe(true);
    expect(await lines('out.txt')).toEqual([
      `Welcome to Northfield (${api.base})|local|20261011-142233-catalogue|${tmp.dir.split('/').pop()}|home`,
    ]);
    expect((await lines('scripts/where.txt'))[0].endsWith('/scripts')).toBe(true);
  });

  it('captures stdout and stderr into the log', async () => {
    const { ctx, logs } = env();
    const journal = await Journal.open(journalFile());
    await runHooks([{ shell: 'echo seeded 3 roasters; echo careful >&2' }], ctx, { phase: 'setup', journal });
    expect(logs).toContainEqual({ level: 'info', msg: 'shell "echo seeded 3 roasters; echo careful >&2" stdout:\nseeded 3 roasters' });
    expect(logs).toContainEqual({ level: 'info', msg: 'shell "echo seeded 3 roasters; echo careful >&2" stderr:\ncareful' });
  });

  it('kill the process group on timeout', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const t0 = Date.now();
    const res = await runHooks([{ shell: { run: 'sleep 30 & sleep 30', timeout: 0.3 } }], ctx, { phase: 'teardown', journal });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(res.results[0].error).toBe('shell "sleep 30 & sleep 30" timed out after 0.3 s (process group killed)');
  });

  it('report a missing working directory before running', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ shell: { run: 'true', cwd: 'nope' } }], ctx, { phase: 'teardown', journal });
    expect(res.results[0].error).toBe(`shell hook: working directory nope does not exist (${join(tmp.dir, 'nope')})`);
  });
});

describe('js hooks', () => {
  it('run through ctx.evalInPage, with templating, file sources and rollback', async () => {
    const calls: Array<[string | undefined, string]> = [];
    const { ctx } = env();
    ctx.evalInPage = async (page, code) => {
      calls.push([page, code]);
      return code.includes('count') ? { count: 3 } : undefined;
    };
    ctx.vars = { banner: 'cookie-banner' };
    await writeFiles(tmp.dir, { 'hooks/count.js': 'return { count: document.querySelectorAll("{{vars.banner}}").length }' });
    const journal = await Journal.open(journalFile());
    const res = await runHooks(
      [
        { js: { code: 'localStorage.setItem("{{vars.banner}}", "dismissed")', page: 'console', rollback: 'localStorage.removeItem("{{vars.banner}}")' } },
        { js: { file: 'hooks/count.js' } },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.message)).toEqual(['done', 'returned {"count":3}']);
    expect(res.results[1].description).toBe('js hooks/count.js');
    await journal.rollbackAll(ctx);
    expect(calls).toEqual([
      ['console', 'localStorage.setItem("cookie-banner", "dismissed")'],
      [undefined, 'return { count: document.querySelectorAll("cookie-banner").length }'],
      ['console', 'localStorage.removeItem("cookie-banner")'],
    ]);
  });

  it('teardown js hooks without a page fail with a clear error', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ js: 'void 0' }, step('a')], ctx, { phase: 'teardown', journal });
    expect(res.results.map((r) => r.error)).toEqual([JS_NEEDS_PAGE, undefined]);
  });

  it('unknown pages are reported', async () => {
    const { ctx } = env();
    ctx.evalInPage = async () => undefined;
    const journal = await Journal.open(journalFile());
    const res = await runHooks([{ js: { code: 'void 0', page: 'admin' } }], ctx, { phase: 'teardown', journal });
    expect(res.results[0].error).toBe('js hook: unknown page "admin" (environment local has: console)');
  });
});

describe('dry runs', () => {
  it('describe and check hooks without running or journaling them', async () => {
    const { ctx, logText } = env();
    ctx.dryRun = true;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const journal = await Journal.open(journalFile());
    const res = await runHooks(
      [
        { http: { method: 'POST', url: '{{console}}/api/replies', save_as: 'reply', rollback: { method: 'DELETE', url: '{{console}}/api/replies/{{response.json.id}}' } } },
        { http: { method: 'PATCH', url: '{{console}}/api/replies/{{hooks.reply.json.id}}', json: { text: 'x' } } },
        { shell: 'touch should-not-exist' },
        { js: 'document.title = "x"' },
        { shell: 'rm -rf build' },
      ],
      ctx,
      { phase: 'setup', journal },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(tmp.dir, 'should-not-exist'))).toBe(false);
    expect(existsSync(journalFile())).toBe(false);
    expect(ctx.saved).toEqual({});
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => r.status)).toEqual(['dry', 'dry', 'dry', 'dry', 'refused']);
    expect(res.results[1].description).toBe(`http PATCH ${api.base}/api/replies/<hooks.reply.json.id>`);
    expect(logText()).toContain(`info setup hook 1/5 [dry]: would run http POST ${api.base}/api/replies → hooks.reply`);
  });

  it('describe pending rollbacks without running them', async () => {
    const { ctx } = env();
    const journal = await Journal.open(journalFile());
    await runHooks([step('a')], ctx, { phase: 'setup', journal });
    const dry = await journal.rollbackAll({ ...ctx, dryRun: true });
    expect(dry).toMatchObject([{ status: 'dry', description: 'shell "echo undo-a >> order.log"' }]);
    expect(journal.pending()).toHaveLength(1);
    expect(await lines('order.log')).toEqual(['a']);
  });
});
