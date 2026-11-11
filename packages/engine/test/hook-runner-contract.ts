/**
 * The hook runner's contract (the HookRunner port, src/hook-run/runner.ts), one suite every adapter passes: the hooks
 * package (`packageHookRunner`, on shell hooks only: `sh`) and the in-memory runner (src/hook-run/memory-hooks.ts).
 * Results come back in order; a failing hook stops a setup unless it is `optional`, and the setup rolls back what it
 * completed; a teardown runs every hook; a dry run executes nothing and journals nothing; a confirmation refused is
 * `refused`, nothing run; a setup hook with a rollback is pending, then rolled back once — never twice; a signal stops
 * the hooks that remain; `recordRun` is called once per hook, never in a dry run.
 *
 * Not here, because it is not an adapter's: the engine's preflight and approvals (approvals.test.ts), templating,
 * secrets, the allow-list, read-only access and journal signing (the hooks package's own tests), and every approval's
 * fingerprint (hook-fingerprints.test.ts: HEAD's literals).
 */
import { describe, expect, it } from 'vitest';
import type { HookContext, HookResult, HookStep } from '@retake/core';
import type { HookRunner } from '../src/hook-run/runner.js';

export interface ContractHooks {
  runner: HookRunner;
  /** The project folder the hooks run in (a new one per case). */
  dir: string;
  /** A hook context on that project (trust `author` unless `over` says otherwise). */
  ctx(over?: Partial<HookContext>): HookContext;
  /** A hook that succeeds and is seen to run (`ran`), with a rollback seen as `rb-<name>` when asked. */
  ok(name: string, o?: { rollback?: boolean; destructive?: boolean; optional?: boolean }): HookStep;
  /** A hook that is seen to run, then fails. */
  failing(name: string, o?: { optional?: boolean }): HookStep;
  /** What ran, in order: hook names, `rb-<name>` for a rollback. */
  ran(): Promise<string[]>;
}

const statuses = (rs: readonly HookResult[]) => rs.map((r) => [r.phase, r.name, r.status]);

/** `make(name)`: an adapter and its material, new each call. */
export function hookRunnerContract(adapter: string, make: (name: string) => Promise<ContractHooks>): void {
  describe(`the hook runner contract (${adapter})`, () => {
    it('results come back in order, one per hook, each journaled', async () => {
      const c = await make('order');
      const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, '20261111-100000-hooks-order'));
      const res = await c.runner.run([c.ok('a'), c.ok('b'), c.ok('c')], c.ctx(), { phase: 'setup', journal });
      expect(res.ok).toBe(true);
      expect(res.results.map((r) => [r.index, r.name, r.status, r.ok])).toEqual([
        [0, 'a', 'ok', true],
        [1, 'b', 'ok', true],
        [2, 'c', 'ok', true],
      ]);
      expect(res.results.map((r) => r.journal_seq)).toEqual([1, 2, 3]);
      expect(await c.ran()).toEqual(['a', 'b', 'c']);
    });

    it('a failing setup hook stops the setup and rolls back what it completed; `optional` lets it go on; a teardown runs every hook', async () => {
      const c = await make('fail');
      const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, '20261111-100100-hooks-fail'));
      const stopped = await c.runner.run([c.ok('a', { rollback: true }), c.failing('f'), c.ok('c')], c.ctx(), { phase: 'setup', journal });
      expect(stopped.ok).toBe(false);
      expect(statuses(stopped.results)).toEqual([
        ['setup', 'a', 'ok'],
        ['setup', 'f', 'failed'],
        ['rollback', 'a', 'ok'],
      ]);
      expect(await c.ran()).toEqual(['a', 'f', 'rb-a']);
      expect(journal.pending()).toEqual([]);

      const tolerated = await c.runner.run([c.failing('g', { optional: true }), c.ok('d')], c.ctx(), { phase: 'setup', journal });
      expect(tolerated.ok).toBe(true);
      expect(statuses(tolerated.results)).toEqual([
        ['setup', 'g', 'failed'],
        ['setup', 'd', 'ok'],
      ]);
      expect(tolerated.results[0].optional).toBe(true);

      const teardown = await c.runner.run([c.failing('h'), c.ok('e')], c.ctx(), { phase: 'teardown', journal });
      expect(teardown.ok).toBe(false);
      expect(statuses(teardown.results)).toEqual([
        ['teardown', 'h', 'failed'],
        ['teardown', 'e', 'ok'],
      ]);
      expect(await c.ran()).toEqual(['a', 'f', 'rb-a', 'g', 'd', 'h', 'e']);
    });

    it('a dry run executes nothing and journals nothing', async () => {
      const c = await make('dry');
      const file = await c.runner.journals.standaloneFile(c.dir, '20261111-100200-hooks-dry');
      const journal = await c.runner.journals.open(file);
      const res = await c.runner.run([c.ok('a', { rollback: true }), c.failing('f'), c.ok('c')], c.ctx({ dryRun: true }), { phase: 'setup', journal });
      expect(res.ok).toBe(true);
      expect(statuses(res.results)).toEqual([
        ['setup', 'a', 'dry'],
        ['setup', 'f', 'dry'],
        ['setup', 'c', 'dry'],
      ]);
      expect(res.results.every((r) => r.journal_seq === undefined)).toBe(true);
      expect(await c.ran()).toEqual([]);
      expect(journal.pending()).toEqual([]);
      expect((await c.runner.journals.find(c.dir, '20261111-100200-hooks-dry')).file).toBeNull();
    });

    it('a confirmation refused is `refused` and runs nothing; a yes runs the hook; through MCP a shell hook asks too', async () => {
      const c = await make('confirm');
      const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, '20261111-100300-hooks-confirm'));
      const asked: string[] = [];
      const no = await c.runner.run([c.ok('d', { destructive: true }), c.ok('c')], c.ctx({ confirmDestructive: (_d, reason) => (asked.push(reason), false) }), { phase: 'setup', journal });
      expect(no.ok).toBe(false);
      expect(statuses(no.results)).toEqual([['setup', 'd', 'refused']]);
      expect(asked).toEqual(['declared destructive']);
      // `optional` never tolerates a refusal.
      const opt = await c.runner.run([c.ok('o', { destructive: true, optional: true }), c.ok('c')], c.ctx({ confirmDestructive: () => false }), { phase: 'setup', journal });
      expect(statuses(opt.results)).toEqual([['setup', 'o', 'refused']]);
      expect(await c.ran()).toEqual([]);

      const yes = await c.runner.run([c.ok('d', { destructive: true })], c.ctx({ confirmDestructive: () => true }), { phase: 'setup', journal });
      expect(statuses(yes.results)).toEqual([['setup', 'd', 'ok']]);
      expect(await c.ran()).toEqual(['d']);

      const requests: Array<{ reason: string; fingerprint: string; phase: string; index: number }> = [];
      const mcp = await c.runner.run([c.ok('m')], c.ctx({ trust: 'mcp', confirmDestructive: (_d, reason, r) => (requests.push({ reason, fingerprint: r.fingerprint, phase: r.phase, index: r.index }), false) }), { phase: 'teardown', journal });
      expect(statuses(mcp.results)).toEqual([['teardown', 'm', 'refused']]);
      expect(requests).toEqual([{ reason: 'a shell command (runs local code)', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), phase: 'teardown', index: 0 }]);
      expect(mcp.results[0].approval).toEqual({ reason: 'a shell command (runs local code)', fingerprint: requests[0].fingerprint });
      expect(await c.ran()).toEqual(['d']);
    });

    it('a setup hook with a rollback is pending, then rolled back once — not twice, also through a journal opened again', async () => {
      const c = await make('rollback');
      const id = '20261111-100400-hooks-rollback';
      const file = await c.runner.journals.standaloneFile(c.dir, id);
      const journal = await c.runner.journals.open(file);
      const res = await c.runner.run([c.ok('a', { rollback: true }), c.ok('b')], c.ctx(), { phase: 'setup', journal });
      expect(res.ok).toBe(true);
      expect(journal.pending().map((e) => [e.seq, e.name, e.status])).toEqual([[1, 'a', 'ok']]);
      expect(journal.isSigned(journal.pending()[0])).toBe(true);
      expect((await c.runner.journals.find(c.dir, id)).file).toBe(file);
      expect((await c.runner.journals.openPending(c.dir)).map((p) => p.file)).toEqual([file]);

      const first = await journal.rollbackAll(c.ctx());
      expect(statuses(first)).toEqual([['rollback', 'a', 'ok']]);
      expect(first[0].journal_seq).toBe(1);
      expect(journal.pending()).toEqual([]);
      expect(await journal.rollbackAll(c.ctx())).toEqual([]);
      const again = await c.runner.journals.open(file);
      expect(again.pending()).toEqual([]);
      expect(await again.rollbackAll(c.ctx())).toEqual([]);
      expect(await c.runner.journals.rollbackPending(c.dir, c.ctx())).toEqual([]);
      expect(await c.ran()).toEqual(['a', 'b', 'rb-a']);
    });

    it('rollbackPending replays every pending journal of the project, each once', async () => {
      const c = await make('pending');
      for (const id of ['20261111-100500-hooks-one', '20261111-100600-hooks-two']) {
        const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, id));
        await c.runner.run([c.ok(id.slice(-3), { rollback: true })], c.ctx(), { phase: 'setup', journal });
      }
      const out = await c.runner.journals.rollbackPending(c.dir, c.ctx());
      expect(out.map((o) => [o.file.endsWith('.json'), statuses(o.results), o.error])).toEqual([
        [true, [['rollback', 'two', 'ok']], undefined],
        [true, [['rollback', 'one', 'ok']], undefined],
      ]);
      expect(await c.runner.journals.rollbackPending(c.dir, c.ctx())).toEqual([]);
      expect(await c.ran()).toEqual(['one', 'two', 'rb-two', 'rb-one']);
    });

    it('a signal stops the hooks that remain (a setup rolls back what it did)', async () => {
      const c = await make('signal');
      const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, '20261111-100700-hooks-signal'));
      const abort = new AbortController();
      // Aborted once the first hook is reported: the next ones never start.
      const ctx = c.ctx({ signal: abort.signal, recordRun: async (r) => (r.phase !== 'rollback' ? abort.abort() : undefined) });
      const res = await c.runner.run([c.ok('a', { rollback: true }), c.ok('b'), c.ok('c')], ctx, { phase: 'setup', journal });
      expect(res.ok).toBe(false);
      expect(statuses(res.results)).toEqual([
        ['setup', 'a', 'ok'],
        ['rollback', 'a', 'ok'],
      ]);
      expect(ctx.signal).toBe(abort.signal);
      const teardown = await c.runner.run([c.ok('t'), c.ok('u')], c.ctx({ signal: abort.signal }), { phase: 'teardown', journal });
      expect(teardown.results).toEqual([]);
      expect(await c.ran()).toEqual(['a', 'rb-a']);
    });

    it('recordRun is called once per hook and per rollback, never in a dry run', async () => {
      const c = await make('record');
      const journal = await c.runner.journals.open(await c.runner.journals.standaloneFile(c.dir, '20261111-100800-hooks-record'));
      const seen: Array<[string, number, string, string | undefined]> = [];
      const recordRun = async (r: HookResult, run?: string) => void seen.push([r.phase, r.index, r.status, run]);
      await c.runner.run([c.ok('a', { rollback: true }), c.ok('b'), c.failing('f')], c.ctx({ recordRun, runId: 'r1' }), { phase: 'teardown', journal });
      expect(seen).toEqual([
        ['teardown', 0, 'ok', undefined],
        ['teardown', 1, 'ok', undefined],
        ['teardown', 2, 'failed', undefined],
      ]);
      seen.splice(0);
      await c.runner.run([c.ok('a'), c.ok('b')], c.ctx({ recordRun, dryRun: true }), { phase: 'setup', journal });
      expect(seen).toEqual([]);
      const setup = await c.runner.run([c.ok('s', { rollback: true })], c.ctx({ recordRun }), { phase: 'setup', journal });
      expect(seen).toEqual([['setup', 0, 'ok', undefined]]);
      seen.splice(0);
      await journal.rollbackAll(c.ctx({ recordRun }));
      // A rollback is reported under the journal's run.
      expect(seen).toEqual([['rollback', setup.results[0].journal_seq!, 'ok', '20261111-100800-hooks-record']]);
      // A failing report never fails the hook.
      const failingReport = await c.runner.run([c.ok('z')], c.ctx({ recordRun: () => Promise.reject(new Error('disk full')) }), { phase: 'teardown', journal });
      expect(statuses(failingReport.results)).toEqual([['teardown', 'z', 'ok']]);
    });
  });
}
