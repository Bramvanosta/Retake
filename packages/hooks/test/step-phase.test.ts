/**
 * The `step` phase (L5.8, R-FLD-31): a named hook a `hook:` step runs during the take. It stops at its first failure
 * (the step fails) without rolling anything back itself, journals its rollbacks like a setup hook (undone with the
 * setup's after the teardown), tolerates an `optional` entry, refuses a malformed one before running any, and is
 * approved bound to its own phase and position (another fingerprint than the same hook in setup).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal, hookFingerprint, journalsRollback, runHooks } from '@demo-studio/hooks';
import type { HookStep } from '@demo-studio/core';
import { makeContext, makeProject, tempProject } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  await tmp.cleanup();
});

const lines = async () => (await readFile(join(tmp.dir, 'order.log'), 'utf8')).trim().split('\n');
const step = (name: string, extra: Partial<{ fail: boolean; optional: boolean }> = {}): HookStep => ({
  name,
  ...(extra.optional ? { optional: true } : {}),
  shell: {
    run: extra.fail ? `echo ${name} >> order.log; echo "${name} broke" >&2; exit 3` : `echo ${name} >> order.log`,
    rollback: `echo undo-${name} >> order.log`,
  },
});

function env() {
  const project = makeProject(tmp.dir, { console: 'http://localhost:9' });
  return makeContext(project, { runId: '20261026-120000-demo' });
}

describe('runHooks: step (L5.8)', () => {
  it('journals rollbacks like setup, stops at the first failure and rolls nothing back itself; the run\'s rollback undoes it', async () => {
    expect(journalsRollback('step')).toBe(true);
    expect(journalsRollback('teardown')).toBe(false);
    const { ctx } = env();
    const journal = await Journal.open(join(tmp.dir, 'runs/20261026-120000-demo/hooks-journal.json'));
    const res = await runHooks([step('a'), step('b', { fail: true }), step('c')], ctx, { phase: 'step', journal });
    expect(res.ok).toBe(false);
    expect(res.results.map((r) => [r.name, r.phase, r.status])).toEqual([
      ['a', 'step', 'ok'],
      ['b', 'step', 'failed'],
    ]);
    // Nothing rolled back yet: the take fails at this step, the teardown's rollbackAll undoes it.
    expect(await lines()).toEqual(['a', 'b']);
    expect(journal.pending().map((e) => [e.name, e.phase])).toEqual([['a', 'step']]);
    await journal.rollbackAll(ctx);
    expect(await lines()).toEqual(['a', 'b', 'undo-a']);
  });

  it('an optional entry that fails lets the next ones run; a malformed one stops them all before any runs', async () => {
    const { ctx } = env();
    const journal = await Journal.open(join(tmp.dir, 'j.json'));
    const res = await runHooks([step('a', { fail: true, optional: true }), step('b')], ctx, { phase: 'step', journal });
    expect(res.ok).toBe(true);
    expect(await lines()).toEqual(['a', 'b']);
    const bad = await runHooks([step('c'), { name: 'broken' } as HookStep], ctx, { phase: 'step', journal });
    expect(bad.ok).toBe(false);
    expect(await lines()).toEqual(['a', 'b']);
  });

  it('through MCP, a shell entry needs an approval bound to the step phase and its position', async () => {
    const { ctx } = env();
    ctx.trust = 'mcp';
    const asked: string[] = [];
    ctx.confirmDestructive = (_d, _r, req) => {
      asked.push(`${req.phase} ${req.index} ${req.fingerprint}`);
      return req.fingerprint === hookFingerprint(step('b'), { phase: 'step', index: 1, env: 'local' });
    };
    const journal = await Journal.open(join(tmp.dir, 'k.json'));
    const res = await runHooks([step('a'), step('b')], ctx, { phase: 'step', journal });
    // `a` (index 0) was not approved: refused, and the list stops there.
    expect(res.results.map((r) => [r.name, r.status])).toEqual([['a', 'refused']]);
    expect(asked).toEqual([`step 0 ${hookFingerprint(step('a'), { phase: 'step', index: 0, env: 'local' })}`]);
    expect(hookFingerprint(step('a'), { phase: 'step', index: 0, env: 'local' })).not.toBe(hookFingerprint(step('a'), { phase: 'setup', index: 0, env: 'local' }));
  });
});
