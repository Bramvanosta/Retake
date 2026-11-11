import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JOURNAL_FILE,
  JOURNALS_DIR,
  Journal,
  JournalError,
  findJournal,
  findPendingJournals,
  journalId,
  rollbackPendingJournals,
  runHooks,
  standaloneJournalFile,
} from '@retake/hooks';
import type { HookStep } from '@retake/core';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  await tmp.cleanup();
});

const runFile = (run: string) => join(tmp.dir, 'runs', run, JOURNAL_FILE);
const lines = async () => (await readFile(join(tmp.dir, 'order.log'), 'utf8')).trim().split('\n');
const hook = (name: string): HookStep => ({ name, shell: { run: `echo ${name} >> order.log`, rollback: `echo undo-${name} >> order.log` } });

describe('Journal', () => {
  it('starts empty without creating the file, then persists every record atomically', async () => {
    const file = runFile('20261011-100000-catalogue');
    const journal = await Journal.open(file);
    expect(journal.entries).toEqual([]);
    await expect(readFile(file)).rejects.toThrow(/ENOENT/);

    const e = await journal.record({
      kind: 'shell',
      phase: 'setup',
      description: 'shell "true"',
      started_at: '2026-10-11T10:00:00.000Z',
      finished_at: '2026-10-11T10:00:01.000Z',
      status: 'ok',
    });
    expect(e.seq).toBe(1);
    const second = await journal.record({ ...e, seq: 99 });
    expect(second.seq).toBe(2);

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk).toMatchObject({ version: 1, entries: [{ seq: 1 }, { seq: 2 }] });
    expect(typeof onDisk.created_at).toBe('string');
    const reopened = await Journal.open(file);
    expect(reopened.entries).toEqual(journal.entries);
  });

  it('rejects malformed files with the reason', async () => {
    await writeFiles(tmp.dir, {
      'runs/a/hooks-journal.json': '{"version": 1, "entries": [',
      'runs/b/hooks-journal.json': '{"version": 2, "entries": []}',
      'runs/c/hooks-journal.json': '{"version": 1, "entries": [{"seq": 1, "kind": "ftp", "phase": "setup", "status": "ok"}]}',
    });
    await expect(Journal.open(runFile('a'))).rejects.toThrow(JournalError);
    await expect(Journal.open(runFile('a'))).rejects.toThrow(/is not valid JSON/);
    await expect(Journal.open(runFile('b'))).rejects.toThrow(`hooks journal ${runFile('b')} is malformed: unsupported version 2 (expected 1)`);
    await expect(Journal.open(runFile('c'))).rejects.toThrow('entries[0].kind "ftp" is unknown');
  });

  // L7.8 (changed): a rollback is checked against its kind's shape when read; before, only its `kind` was, and the entry
  // below opened, then made a TypeError when it was listed for --replay-unsigned.
  it('refuses a rollback whose shape is not its kind, naming the entry, and replays nothing of that journal', async () => {
    const at = '2026-11-04T09:00:00.000Z';
    const entry = (seq: number, rollback: unknown) => ({ seq, kind: 'shell', phase: 'setup', description: 'x', started_at: at, finished_at: at, status: 'ok', rollback });
    const base = { description: 'undo', data: {} };
    const bad: Array<[unknown, string]> = [
      [{ kind: 'http', method: 'DELETE', url: 'http://localhost:1/x', ...base }, 'has a malformed http rollback: `request` must be an object'],
      [{ kind: 'http', request: 'DELETE http://localhost:1/x', ...base }, '`request` must be an object'],
      [{ kind: 'http', request: { method: 'DELETE' }, ...base }, '`request.url` must be a string'],
      [{ kind: 'http', request: { method: 'DELETE', url: 5 }, ...base }, '`request.url` must be a string'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', method: 7 }, ...base }, '`request.method` must be a string'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', headers: { a: 1 } }, ...base }, '`request.headers` must map names to strings'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', auth: { name: 'buyer' } }, ...base }, '`request.auth.persona` must be a string'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', body: {} }, ...base }, '`request.body` must be a string'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', expect: '200' }, ...base }, '`request.expect` must be a number or a list of numbers'],
      [{ kind: 'http', request: { url: 'http://localhost:1/x', expect: ['200'] }, ...base }, '`request.expect` must be a number or a list of numbers'],
      [{ kind: 'sql', query: 'DELETE FROM t', ...base }, 'has a malformed sql rollback: `db` must be a string'],
      [{ kind: 'sql', db: 'main', ...base }, '`query` must be a string'],
      [{ kind: 'sql', db: 'main', query: 'x', file: 3, ...base }, '`file` must be a string'],
      [{ kind: 'shell', ...base }, 'has a malformed shell rollback: `run` must be a string'],
      [{ kind: 'shell', run: 'true', cwd: [], ...base }, '`cwd` must be a string'],
      [{ kind: 'shell', run: 'true', env: { A: 1 }, ...base }, '`env` must map names to strings'],
      [{ kind: 'shell', run: 'true', timeout: '5', ...base }, '`timeout` must be a number'],
      [{ kind: 'shell', run: 'true', agent: 'yes', ...base }, '`agent` must be true'],
      [{ kind: 'js', page: 'app', ...base }, 'has a malformed js rollback: `code` must be a string'],
      [{ kind: 'js', code: 'x', page: 1, ...base }, '`page` must be a string'],
      [{ kind: 'shell', run: 'true', data: {} }, '`description` must be a string'],
      [{ kind: 'shell', run: 'true', description: 'undo' }, '`data` must be an object'],
    ];
    for (const [i, [rollback, why]] of bad.entries()) {
      const file = runFile(`bad-${i}`);
      await writeFiles(tmp.dir, { [`runs/bad-${i}/hooks-journal.json`]: JSON.stringify({ version: 1, entries: [entry(1, { kind: 'shell', run: 'true', ...base }), entry(2, rollback)] }) });
      const thrown = await Journal.open(file).then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown, why).toBeInstanceOf(JournalError);
      expect((thrown as Error).message).toBe(`hooks journal ${file} is malformed: entries[1] (#2) ${why.startsWith('has ') ? why : `has a malformed ${(rollback as { kind: string }).kind} rollback: ${why}`}`);
    }

    // A journal Retake signed, with a malformed entry added by hand: nothing of it is replayed, the error names it.
    const { ctx } = makeContext(makeProject(tmp.dir));
    const signed = await Journal.open(runFile('mixed'));
    await runHooks([hook('a')], ctx, { phase: 'setup', journal: signed });
    const onDisk = JSON.parse(await readFile(runFile('mixed'), 'utf8'));
    onDisk.entries.push(entry(2, { kind: 'http', method: 'DELETE', url: 'http://localhost:1/x', ...base }));
    await writeFiles(tmp.dir, { 'runs/mixed/hooks-journal.json': JSON.stringify(onDisk) });
    await rm(join(tmp.dir, 'order.log'));
    const replayed = (await rollbackPendingJournals(tmp.dir, ctx)).filter((r) => r.file === runFile('mixed'));
    expect(replayed).toEqual([{ file: runFile('mixed'), results: [], error: expect.stringContaining('entries[1] (#2) has a malformed http rollback') }]);
    expect(existsSync(join(tmp.dir, 'order.log'))).toBe(false);
  });

  it('still reads a journal of an older Retake whose rollbacks have their shape (unsigned, with members it no longer writes)', async () => {
    const at = '2026-11-04T09:00:00.000Z';
    const old = {
      version: 1,
      entries: [
        { seq: 1, kind: 'http', phase: 'setup', description: 'POST x', started_at: at, finished_at: at, status: 'ok', rolled_back: false, rollback: { kind: 'http', request: { method: 'DELETE', url: 'http://localhost:1/x', expect: [200, 204] }, description: 'DELETE x', data: { pages: { app: 'http://localhost:1' } }, note: 'kept' } },
        { seq: 2, kind: 'sql', phase: 'setup', description: 'sql', started_at: at, finished_at: at, status: 'ok', rollback: { kind: 'sql', db: 'main', query: 'DELETE FROM t', description: 'sql', data: {} } },
        { seq: 3, kind: 'shell', phase: 'step', description: 'sh', started_at: at, finished_at: at, status: 'ok', rollback: { kind: 'shell', run: 'true', timeout: 5, agent: true, env: { A: 'b' }, description: 'sh', data: {} } },
        { seq: 4, kind: 'js', phase: 'setup', description: 'js', started_at: at, finished_at: at, status: 'rolled_back', rollback: { kind: 'js', code: '1', page: 'app', description: 'js', data: {} } },
        { seq: 5, kind: 'shell', phase: 'teardown', description: 'no rollback', started_at: at, finished_at: at, status: 'ok' },
      ],
    };
    await writeFiles(tmp.dir, { 'runs/old/hooks-journal.json': JSON.stringify(old) });
    const journal = await Journal.open(runFile('old'));
    expect(journal.pending().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(journal.entries.every((e) => !journal.isSigned(e))).toBe(true);
  });

  it('rollbackAll runs pending rollbacks most recent first and is idempotent', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir));
    const journal = await Journal.open(runFile('r1'));
    await runHooks([hook('a'), hook('b'), { shell: 'echo no-rollback >> order.log' }, hook('c')], ctx, { phase: 'setup', journal });
    expect(journal.pending().map((e) => e.name)).toEqual(['a', 'b', 'c']);

    const first = await (await Journal.open(runFile('r1'))).rollbackAll(ctx);
    expect(first.map((r) => [r.name, r.phase, r.status, r.journal_seq])).toEqual([
      ['c', 'rollback', 'ok', 4],
      ['b', 'rollback', 'ok', 2],
      ['a', 'rollback', 'ok', 1],
    ]);
    const after = await Journal.open(runFile('r1'));
    expect(after.pending()).toEqual([]);
    expect(after.entries.map((e) => e.status)).toEqual(['rolled_back', 'rolled_back', 'ok', 'rolled_back']);
    expect(after.entries[0].rolled_back_at).toEqual(expect.any(String));

    expect(await after.rollbackAll(ctx)).toEqual([]);
    expect(await (await Journal.open(runFile('r1'))).rollbackAll(ctx)).toEqual([]);
    expect(await lines()).toEqual(['a', 'b', 'no-rollback', 'c', 'undo-c', 'undo-b', 'undo-a']);
  });

  it('a failed rollback stays pending with its error and is retried next time', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir));
    const journal = await Journal.open(runFile('r1'));
    await runHooks(
      [hook('a'), { name: 'flaky', shell: { run: 'true', rollback: 'test -f fixed || { echo "not yet" >&2; exit 1; }; echo undo-flaky >> order.log' } }],
      ctx,
      { phase: 'setup', journal },
    );
    const first = await journal.rollbackAll(ctx);
    expect(first.map((r) => [r.name, r.status])).toEqual([
      ['flaky', 'failed'],
      ['a', 'ok'],
    ]);
    expect(journal.pending()).toMatchObject([{ name: 'flaky', rollback_attempts: 1, rollback_error: expect.stringContaining('not yet') }]);

    await writeFiles(tmp.dir, { fixed: '' });
    const second = await (await Journal.open(runFile('r1'))).rollbackAll(ctx);
    expect(second.map((r) => [r.name, r.status])).toEqual([['flaky', 'ok']]);
    expect(await lines()).toEqual(['a', 'undo-a', 'undo-flaky']);
  });
});

describe('findPendingJournals', () => {
  it('finds runs with pending rollbacks, most recent first, including unreadable journals', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir));
    for (const run of ['20261009-090000-catalogue', '20261010-090000-quote', '20261011-090000-catalogue']) {
      const journal = await Journal.open(runFile(run));
      await runHooks([hook(run.slice(0, 8))], ctx, { phase: 'setup', journal });
    }
    await (await Journal.open(runFile('20261010-090000-quote'))).rollbackAll(ctx);
    const teardownOnly = await Journal.open(runFile('20261011-120000-teardown'));
    await runHooks([hook('t')], ctx, { phase: 'teardown', journal: teardownOnly });
    await writeFiles(tmp.dir, { 'runs/20261008-090000-broken/hooks-journal.json': 'oops', 'runs/20261011-130000-nohooks/run.json': '{}' });

    expect(await findPendingJournals(tmp.dir)).toEqual([
      runFile('20261011-090000-catalogue'),
      runFile('20261009-090000-catalogue'),
      runFile('20261008-090000-broken'),
    ]);
    expect(await findPendingJournals(join(tmp.dir, 'missing'))).toEqual([]);

    const rolled = await rollbackPendingJournals(tmp.dir, ctx);
    const broken = runFile('20261008-090000-broken');
    expect(rolled.map((r) => [r.file, r.results.map((x) => x.status), r.error?.split(':')[0]])).toEqual([
      [runFile('20261011-090000-catalogue'), ['ok'], undefined],
      [runFile('20261009-090000-catalogue'), ['ok'], undefined],
      [broken, [], `hooks journal ${broken} is not valid JSON`],
    ]);
    expect(await findPendingJournals(tmp.dir)).toEqual([runFile('20261008-090000-broken')]);
  });

  it('reads standalone journals from .retake/journals as well, merged by id (R-ISS-06)', async () => {
    const { ctx } = makeContext(makeProject(tmp.dir));
    const standalone = standaloneJournalFile(tmp.dir, '20261010-120000-hooks-catalogue-setup');
    expect(standalone).toBe(join(tmp.dir, JOURNALS_DIR, '20261010-120000-hooks-catalogue-setup.json'));
    expect(standalone).toBe(join(tmp.dir, '.retake', 'journals', '20261010-120000-hooks-catalogue-setup.json'));
    await runHooks([hook('standalone')], ctx, { phase: 'setup', journal: await Journal.open(standalone) });
    for (const run of ['20261009-090000-catalogue', '20261011-090000-quote']) {
      await runHooks([hook(run.slice(0, 8))], ctx, { phase: 'setup', journal: await Journal.open(runFile(run)) });
    }
    // A reset journal without rollbacks is never pending.
    const reset = standaloneJournalFile(tmp.dir, '20261011-100000-env-reset');
    await runHooks([{ name: 'r', shell: 'echo reset >> order.log' }], ctx, { phase: 'reset', journal: await Journal.open(reset) });

    expect(await findPendingJournals(tmp.dir)).toEqual([runFile('20261011-090000-quote'), standalone, runFile('20261009-090000-catalogue')]);
    expect(journalId(standalone)).toBe('20261010-120000-hooks-catalogue-setup');
    expect(journalId(runFile('20261011-090000-quote'))).toBe('20261011-090000-quote');
    expect(findJournal(tmp.dir, '20261010-120000-hooks-catalogue-setup')).toBe(standalone);
    expect(findJournal(tmp.dir, '20261011-090000-quote')).toBe(runFile('20261011-090000-quote'));
    expect(findJournal(tmp.dir, 'nope')).toBeNull();

    const rolled = await rollbackPendingJournals(tmp.dir, ctx);
    expect(rolled.map((r) => [journalId(r.file), r.results.map((x) => x.status)])).toEqual([
      ['20261011-090000-quote', ['ok']],
      ['20261010-120000-hooks-catalogue-setup', ['ok']],
      ['20261009-090000-catalogue', ['ok']],
    ]);
    expect(await findPendingJournals(tmp.dir)).toEqual([]);
    expect(await lines()).toEqual(['standalone', '20261009', '20261011', 'reset', 'undo-20261011', 'undo-standalone', 'undo-20261009']);
  });
});
