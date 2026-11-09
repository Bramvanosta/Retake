/**
 * L5.14: rollback journal entries are signed when written, with the Retake home's key, over their journal's id and the
 * whole entry; an entry without a valid signature is never replayed with trust `mcp` (refused, and said), elsewhere only
 * on request (`replayUnsigned`), and never with secrets. Saving a journal never signs an entry it read unsigned.
 */
import { cp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOURNAL_FILE, Journal, ROLLBACKS_DONE_DIR, openPendingJournals, pruneDoneRollbacks, rollbackActionLines, rollbackJournals, rollbackPendingJournals, runHooks, standaloneJournalFile } from '@retake/hooks';
import type { RollbackAction } from '@retake/hooks';
import { agentPolicy } from '@retake/core';
import type { HookStep } from '@retake/core';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
let keyFile: string;
beforeEach(async () => {
  tmp = await tempProject('retake-journal-sign-');
  keyFile = join(tmp.dir, '.home', 'approvals.key');
});
afterEach(async () => {
  await tmp.cleanup();
});

const runFile = (run: string) => join(tmp.dir, 'runs', run, JOURNAL_FILE);
const hook = (name: string): HookStep => ({ name, shell: { run: `echo ${name} >> order.log`, rollback: `echo undo-${name} >> order.log` } });
const order = async () => (existsSync(join(tmp.dir, 'order.log')) ? (await readFile(join(tmp.dir, 'order.log'), 'utf8')).trim().split('\n') : []);

/** A journal written by hand (not by Retake): one pending shell rollback. */
function forged(rollback: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    created_at: '2026-11-04T09:00:00.000Z',
    updated_at: '2026-11-04T09:00:00.000Z',
    entries: [
      {
        seq: 1,
        name: 'placed',
        kind: 'shell',
        phase: 'setup',
        description: 'shell "true"',
        env: 'local',
        started_at: '2026-11-04T09:00:00.000Z',
        finished_at: '2026-11-04T09:00:01.000Z',
        status: 'ok',
        rollback: { kind: 'shell', run: rollback, description: `shell "${rollback}"`, data: {} },
        ...extra,
      },
    ],
  });
}

/** Write a signed journal the way Retake does (author trust: the shell hooks run). */
async function written(file: string, names: string[]): Promise<Journal> {
  const { ctx } = makeContext(makeProject(tmp.dir));
  const journal = await Journal.open(file, { keyFile });
  await runHooks(names.map(hook), ctx, { phase: 'setup', journal });
  return journal;
}

describe('rollback journal entries are signed (L5.14)', () => {
  it('each entry is signed when written and again when it changes; read back, it is signed and replayed with trust mcp', async () => {
    await written(runFile('20261104-090000-a'), ['a', 'b']);
    const onDisk = JSON.parse(await readFile(runFile('20261104-090000-a'), 'utf8')) as { entries: Array<{ sig?: string }> };
    expect(onDisk.entries.map((e) => e.sig)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const back = await Journal.open(runFile('20261104-090000-a'), { keyFile });
    expect(back.entries.map((e) => back.isSigned(e))).toEqual([true, true]);
    const { ctx } = makeContext(makeProject(tmp.dir), { trust: 'mcp' });
    expect((await back.rollbackAll(ctx)).map((r) => [r.name, r.status])).toEqual([
      ['b', 'ok'],
      ['a', 'ok'],
    ]);
    // Their new status is signed too: read back once more, still signed, nothing pending.
    const again = await Journal.open(runFile('20261104-090000-a'), { keyFile });
    expect(again.entries.map((e) => [again.isSigned(e), e.status])).toEqual([
      [true, 'rolled_back'],
      [true, 'rolled_back'],
    ]);
    expect(await order()).toEqual(['a', 'b', 'undo-b', 'undo-a']);
  });

  it('a hand-placed journal (runs/<id>/ and .retake/journals/) is never replayed with trust mcp: refused, and said', async () => {
    await writeFiles(tmp.dir, {
      'runs/20261104-091000-placed/hooks-journal.json': forged('echo placed-run >> order.log'),
      '.retake/journals/hooks-placed.json': forged('echo placed-standalone >> order.log'),
    });
    const { ctx, logText } = makeContext(makeProject(tmp.dir), { trust: 'mcp', replayUnsigned: true });
    const out = await rollbackPendingJournals(tmp.dir, ctx, { keyFile });
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(o.results).toEqual([expect.objectContaining({ ok: false, status: 'refused', error: expect.stringMatching(/not replayed: its journal entry \(.+ #1\) is not signed by this Retake home/) })]);
      // Said to the person (a person can review it in a terminal): no flag handed to the agent.
      expect(o.results[0]!.error).toContain('a person can review it and replay it from a terminal');
      expect(o.results[0]!.error).not.toContain('--replay-unsigned');
    }
    expect(logText()).toMatch(/rollback of #1 \(shell "true"\) refused/);
    expect(await order()).toEqual([]);
    // Still pending: nothing was marked done.
    expect((await openPendingJournals(tmp.dir, { keyFile })).map((p) => p.journal?.pending().length)).toEqual([1, 1]);
  });

  it('elsewhere (a terminal) only on request, and never with secrets', async () => {
    await writeFiles(tmp.dir, {
      'runs/20261104-092000-placed/hooks-journal.json': forged('echo placed >> order.log'),
      'runs/20261104-093000-secret/hooks-journal.json': forged('curl -H "Authorization: {{env:API_TOKEN}}" http://127.0.0.1:9/ >> order.log'),
    });
    const list = await openPendingJournals(tmp.dir, { keyFile });
    const plain = makeContext(makeProject(tmp.dir));
    const refused = await rollbackJournals(list, plain.ctx);
    expect(refused.flatMap((o) => o.results.map((r) => [r.status, r.error]))).toEqual([
      ['refused', expect.stringMatching(/references secrets/)],
      ['refused', expect.stringMatching(/not signed by this Retake home .* look at it, then replay it with --replay-unsigned in a terminal$/)],
    ]);
    expect(await order()).toEqual([]);
    const asked: number[] = [];
    const yes = makeContext(makeProject(tmp.dir), { replayUnsigned: (e, file) => (asked.push(`${e.seq} ${file}`), true) });
    const replayed = await rollbackJournals(list, yes.ctx);
    // Most recent first: the one with a secret is refused (never asked about), the other replayed.
    expect(replayed.map((o) => o.results.map((r) => r.status))).toEqual([['refused'], ['ok']]);
    expect(replayed[0]!.results[0]!.error).toMatch(/it references secrets — an unsigned entry is never given secrets/);
    expect(asked).toEqual([`1 ${list[1]!.file}`]);
    expect(await order()).toEqual(['placed']);
  });

  it('an entry copied into another journal, edited, or read with another home\'s key is not signed; saving never signs it', async () => {
    await written(runFile('20261104-094000-src'), ['a']);
    // Copied whole under another run id: its entries name their own journal.
    await cp(runFile('20261104-094000-src'), runFile('20261104-094500-copy'));
    const copy = await Journal.open(runFile('20261104-094500-copy'), { keyFile });
    expect(copy.isSigned(copy.entries[0]!)).toBe(false);
    // Edited in place (another rollback command): its signature no longer matches.
    const text = await readFile(runFile('20261104-094000-src'), 'utf8');
    await writeFiles(tmp.dir, { 'runs/20261104-094000-src/hooks-journal.json': text.replace('echo undo-a', 'echo edited') });
    const edited = await Journal.open(runFile('20261104-094000-src'), { keyFile });
    expect(edited.isSigned(edited.entries[0]!)).toBe(false);
    // Another home's key.
    await written(runFile('20261104-095000-mine'), ['m']);
    const other = await Journal.open(runFile('20261104-095000-mine'), { keyFile: join(tmp.dir, '.other', 'approvals.key') });
    expect(other.isSigned(other.entries[0]!)).toBe(false);
    // An unsigned entry stays unsigned through a save of its journal (a new entry is signed beside it).
    await edited.record({ kind: 'shell', phase: 'setup', description: 'shell "true"', started_at: '2026-11-04T09:00:00.000Z', finished_at: '2026-11-04T09:00:01.000Z', status: 'ok' });
    const saved = await Journal.open(runFile('20261104-094000-src'), { keyFile });
    expect(saved.entries.map((e) => saved.isSigned(e))).toEqual([false, true]);
    // A standalone journal (`retake hooks run`) is signed like a run's.
    const standalone = standaloneJournalFile(tmp.dir, '20261104-096000-hooks-x');
    await written(standalone, ['s']);
    const s = await Journal.open(standalone, { keyFile });
    expect(s.isSigned(s.entries[0]!)).toBe(true);
  });
  it('a signed entry replays only in its own journal: copied to another project, moved between runs/ and .retake/journals/, or duplicated, it is refused under mcp', async () => {
    await written(runFile('20261104-100000-own'), ['a']);
    const text = await readFile(runFile('20261104-100000-own'), 'utf8');
    // Another project (same run id, same home key).
    const other = await tempProject('retake-journal-other-');
    try {
      await writeFiles(other.dir, { 'runs/20261104-100000-own/hooks-journal.json': text });
      const there = await Journal.open(join(other.dir, 'runs', '20261104-100000-own', JOURNAL_FILE), { keyFile });
      expect(there.isSigned(there.entries[0]!)).toBe(false);
    } finally {
      await other.cleanup();
    }
    // Moved to the other location of this project, same id.
    await writeFiles(tmp.dir, { '.retake/journals/20261104-100000-own.json': text });
    const moved = await Journal.open(standaloneJournalFile(tmp.dir, '20261104-100000-own'), { keyFile });
    expect(moved.isSigned(moved.entries[0]!)).toBe(false);
    // A signed standalone journal moved into runs/ (same id).
    const standalone = standaloneJournalFile(tmp.dir, '20261104-101000-hooks-x');
    await written(standalone, ['s']);
    await writeFiles(tmp.dir, { 'runs/20261104-101000-hooks-x/hooks-journal.json': await readFile(standalone, 'utf8') });
    const intoRuns = await Journal.open(runFile('20261104-101000-hooks-x'), { keyFile });
    expect(intoRuns.isSigned(intoRuns.entries[0]!)).toBe(false);
    // Duplicated in its own journal: neither copy of the seq is trusted.
    const data = JSON.parse(text) as { entries: unknown[] };
    data.entries.push(data.entries[0]);
    await writeFiles(tmp.dir, { 'runs/20261104-100000-own/hooks-journal.json': JSON.stringify(data) });
    const dup = await Journal.open(runFile('20261104-100000-own'), { keyFile });
    expect(dup.entries.map((e) => dup.isSigned(e))).toEqual([false, false]);
    await rm(standalone);
    await rm(join(tmp.dir, 'runs', '20261104-101000-hooks-x'), { recursive: true });
    const { ctx } = makeContext(makeProject(tmp.dir), { trust: 'mcp' });
    const out = await rollbackPendingJournals(tmp.dir, ctx, { keyFile });
    expect(out.flatMap((o) => o.results.map((r) => r.status))).toEqual(['refused', 'refused', 'refused']);
    expect(await order()).toEqual(['a', 's']);
  });

  it('a signed entry is replayed once: a stale pending copy written back after its rollback is refused; a failed rollback may be tried again', async () => {
    await written(runFile('20261104-102000-once'), ['a']);
    const stale = await readFile(runFile('20261104-102000-once'), 'utf8');
    const { ctx } = makeContext(makeProject(tmp.dir), { trust: 'mcp' });
    expect((await (await Journal.open(runFile('20261104-102000-once'), { keyFile })).rollbackAll(ctx)).map((r) => r.status)).toEqual(['ok']);
    expect(await readdir(join(tmp.dir, '.home', ROLLBACKS_DONE_DIR))).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    await writeFiles(tmp.dir, { 'runs/20261104-102000-once/hooks-journal.json': stale });
    const back = await Journal.open(runFile('20261104-102000-once'), { keyFile });
    // Signed (Retake wrote it there) but replayed before: refused, in a dry run too, whoever asks.
    expect(back.isSigned(back.entries[0]!)).toBe(true);
    const dry = makeContext(makeProject(tmp.dir), { dryRun: true });
    expect((await back.rollbackAll(dry.ctx)).map((r) => [r.status, r.error])).toEqual([['refused', expect.stringMatching(/Retake replayed this rollback before .* not replayed twice/)]]);
    const again = await back.rollbackAll(makeContext(makeProject(tmp.dir), { replayUnsigned: () => true }).ctx);
    expect(again.map((r) => [r.status, r.error])).toEqual([['refused', expect.stringMatching(/not replayed: Retake replayed this rollback before/)]]);
    expect(await order()).toEqual(['a', 'undo-a']);
    // A rollback that fails is not recorded as replayed: it is tried again (and its new state signed).
    const failing = await Journal.open(runFile('20261104-103000-fail'), { keyFile });
    await runHooks([{ name: 'f', shell: { run: 'true', rollback: 'test -f go && echo undo-f >> order.log' } }], makeContext(makeProject(tmp.dir)).ctx, { phase: 'setup', journal: failing });
    const beforeFail = await readFile(runFile('20261104-103000-fail'), 'utf8');
    expect((await failing.rollbackAll(ctx)).map((r) => r.status)).toEqual(['failed']);
    await writeFile(join(tmp.dir, 'go'), '');
    const retry = await Journal.open(runFile('20261104-103000-fail'), { keyFile });
    expect((await retry.rollbackAll(ctx)).map((r) => r.status)).toEqual(['ok']);
    expect(await order()).toEqual(['a', 'undo-a', 'undo-f']);
    // A copy taken before the failed attempt (another state of the same entry) is not replayed after the success.
    await writeFiles(tmp.dir, { 'runs/20261104-103000-fail/hooks-journal.json': beforeFail });
    const older = await Journal.open(runFile('20261104-103000-fail'), { keyFile });
    expect((await older.rollbackAll(ctx)).map((r) => r.status)).toEqual(['refused']);
    expect(await order()).toEqual(['a', 'undo-a', 'undo-f']);
  });

  it('the record of replays is pruned after a year; a signed entry older than that is not trusted', async () => {
    await written(runFile('20261104-104000-old'), ['a']);
    const { ctx } = makeContext(makeProject(tmp.dir));
    await (await Journal.open(runFile('20261104-104000-old'), { keyFile })).rollbackAll(ctx);
    const dir = join(tmp.dir, '.home', ROLLBACKS_DONE_DIR);
    const [name] = await readdir(dir);
    await writeFile(join(dir, 'not-a-record'), '');
    await pruneDoneRollbacks(keyFile);
    expect((await readdir(dir)).sort()).toEqual([name, 'not-a-record'].sort());
    const old = new Date(Date.now() - 366 * 24 * 3600_000);
    await utimes(join(dir, name!), old, old);
    await pruneDoneRollbacks(keyFile);
    expect(await readdir(dir)).toEqual(['not-a-record']);
    // An entry signed with a start older than the record kept: untrusted (a person decides).
    const j = await Journal.open(runFile('20261104-105000-aged'), { keyFile });
    await j.record({ kind: 'shell', phase: 'setup', description: 'shell "true"', started_at: old.toISOString(), finished_at: old.toISOString(), status: 'ok', rollback: { kind: 'shell', run: 'true', description: 'shell "true"', data: {} } });
    const aged = await Journal.open(runFile('20261104-105000-aged'), { keyFile });
    expect(aged.isSigned(aged.entries[0]!)).toBe(false);
  });

  it('an unsigned sql or js entry, or a shell one on a sandbox, is never replayed even on a yes; a dry run lists an unsigned entry (ok); a yes runs a shell one with a bare environment', async () => {
    const entry = (rollback: RollbackAction, env = 'local') => JSON.stringify({ version: 1, created_at: '2026-11-04T09:00:00.000Z', updated_at: '2026-11-04T09:00:00.000Z', entries: [{ seq: 1, kind: rollback.kind, phase: 'setup', description: 'x', env, started_at: '2026-11-04T09:00:00.000Z', finished_at: '2026-11-04T09:00:01.000Z', status: 'ok', rollback }] });
    await writeFiles(tmp.dir, {
      'runs/20261104-110000-sql/hooks-journal.json': entry({ kind: 'sql', db: 'main', query: 'delete from orders', description: 'sql', data: {} }),
      'runs/20261104-110100-js/hooks-journal.json': entry({ kind: 'js', code: 'document.title', description: 'js', data: {} }),
      'runs/20261104-110200-box/hooks-journal.json': entry({ kind: 'shell', run: 'echo box >> order.log', description: 'shell', data: {} }, 'demo'),
      'runs/20261104-110300-bare/hooks-journal.json': entry({ kind: 'shell', run: 'echo "bare:${RETAKE_TEST_TERMINAL_ONLY:-unset}" >> order.log', description: 'shell', data: {} }),
    });
    const project = makeProject(tmp.dir, {}, { environments: { local: {}, demo: {} }, environment_settings: { demo: { sandbox: { name: 'demo' } as never } } });
    const list = await openPendingJournals(tmp.dir, { keyFile });
    const dry = await rollbackJournals(list, makeContext(project, { dryRun: true }).ctx);
    expect(dry.flatMap((o) => o.results.map((r) => [r.ok, r.status]))).toEqual([
      [true, 'dry'],
      [true, 'dry'],
      [true, 'dry'],
      [true, 'dry'],
    ]);
    expect(dry[0]!.results[0]!.message).toMatch(/not signed by this Retake home: not replayed without --replay-unsigned/);
    expect(dry[3]!.results[0]!.message).toMatch(/an unsigned sql rollback is never replayed/);
    const asked: string[] = [];
    process.env.RETAKE_TEST_TERMINAL_ONLY = 'from-the-terminal';
    let yes: Awaited<ReturnType<typeof rollbackJournals>>;
    try {
      yes = await rollbackJournals(list, makeContext(project, { replayUnsigned: (e, file) => (asked.push(file), true) }).ctx);
    } finally {
      delete process.env.RETAKE_TEST_TERMINAL_ONLY;
    }
    expect(yes.flatMap((o) => o.results.map((r) => [r.status, r.error ?? '']))).toEqual([
      ['ok', ''],
      ['refused', expect.stringMatching(/would run with the variables of sandbox demo .* run it by hand/)],
      ['refused', expect.stringMatching(/an unsigned js rollback is never replayed \(it would run in the environment's signed-in page\): if it is right, run it by hand/)],
      ['refused', expect.stringMatching(/an unsigned sql rollback is never replayed \(it would connect with the environment's database\): if it is right, run it by hand/)],
    ]);
    // Asked about the one that may run only; it ran without the rest of the terminal's environment.
    expect(asked).toEqual([list[0]!.file]);
    expect(await order()).toEqual(['bare:unset']);
  });

  it('an unsigned shell rollback replayed under the agent policy gets no PATH entry inside the workspace (the policy of its context)', async () => {
    const entry = JSON.stringify({ version: 1, created_at: '2026-11-04T09:00:00.000Z', updated_at: '2026-11-04T09:00:00.000Z', entries: [{ seq: 1, kind: 'shell', phase: 'setup', description: 'x', started_at: '2026-11-04T09:00:00.000Z', finished_at: '2026-11-04T09:00:00.000Z', status: 'ok', rollback: { kind: 'shell', run: 'echo "path:$PATH" >> order.log', description: 'shell', data: {} }, rolled_back: false }] });
    await writeFiles(tmp.dir, { 'runs/20261104-130000-path/hooks-journal.json': entry });
    const project = makeProject(tmp.dir);
    const inside = join(tmp.dir, 'bin');
    const saved = process.env.PATH;
    process.env.PATH = [inside, '/usr/bin', '/bin'].join(':');
    try {
      const list = await openPendingJournals(tmp.dir, { keyFile });
      await rollbackJournals(list, makeContext(project, { replayUnsigned: () => true, policy: agentPolicy([tmp.dir]) }).ctx);
    } finally {
      process.env.PATH = saved;
    }
    expect(await order()).toEqual(['path:/usr/bin:/bin']);
  });

  it('an unsigned shell rollback that fails says which variables it saw and never advises pass_env (it gets none), with or without the agent policy', async () => {
    const entry = JSON.stringify({ version: 1, created_at: '2026-11-04T09:00:00.000Z', updated_at: '2026-11-04T09:00:00.000Z', entries: [{ seq: 1, kind: 'shell', phase: 'setup', description: 'x', env: 'local', started_at: '2026-11-04T09:00:00.000Z', finished_at: '2026-11-04T09:00:01.000Z', status: 'ok', rollback: { kind: 'shell', run: 'exit 4', description: 'shell', data: {} } }] });
    await writeFiles(tmp.dir, { 'runs/20261104-120000-fail/hooks-journal.json': entry });
    const project = makeProject(tmp.dir, {}, { pass_env: ['T_BARE_PASSED'] });
    const list = await openPendingJournals(tmp.dir, { keyFile });
    const out = await rollbackJournals(list, makeContext(project, { replayUnsigned: () => true }).ctx);
    const error = out[0]!.results[0]!.error ?? '';
    expect(error).toMatch(/^shell "exit 4" exited with code 4 \(a rollback Retake did not sign gets only the shell's own variables of this environment, never project\.yaml `pass_env:` — this one saw (?:[A-Z_]+, )*HOME, (?:[A-Z_]+, )*PATH(?:, [A-Z_]+)*; if it needs another, run it by hand\)$/);
    expect(error).not.toContain('e.g. `pass_env:');
    expect(error).not.toContain('a job the Studio');
  });

  it('rollbackActionLines shows an action in full, templates filled from its data, every hidden character written out', () => {
    const long = `echo ${'x'.repeat(200)} {{vars.id}}`;
    expect(rollbackActionLines({ kind: 'shell', run: long, cwd: 'sub', env: { A: 'b\u001b[2Jc' }, description: 'short', data: { vars: { id: '42' } } })).toEqual([
      'kind: shell',
      `run: echo ${'x'.repeat(200)} 42`,
      'cwd: sub',
      'env A: b\\u{1b}[2Jc',
    ]);
    expect(rollbackActionLines({ kind: 'http', request: { method: 'delete', url: '{{console}}/api/quotes/{{vars.id}}\u202e', headers: { 'x-a': 'b' } }, description: 'd', data: { pages: { console: 'http://127.0.0.1:9' }, vars: { id: 7 } } })).toEqual([
      'kind: http',
      'method: DELETE',
      'url: http://127.0.0.1:9/api/quotes/7\\u{202e}',
      'header x-a: b',
    ]);
    // A secret is never resolved: shown as written.
    expect(rollbackActionLines({ kind: 'sql', db: 'main', query: "delete from t where k = '{{env:HOME}}'", description: 'd', data: {} })).toEqual(['kind: sql', 'db: main', "query: delete from t where k = '{{env:HOME}}'"]);
  });
});
