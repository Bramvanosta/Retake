/**
 * The hook runs a context reports (HookContext.recordRun, the workspace journal's hook lines): one report per hook
 * executed — a failed one included — and per rollback replayed, in the order they ran; none for a dry run; a recorder
 * that throws never fails the hooks.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Journal, runHooks } from '@retake/hooks';
import type { HookResult } from '@retake/hooks';
import type { HookStep } from '@retake/core';
import { makeContext, makeProject, tempProject } from './helpers.js';

let tmp: Awaited<ReturnType<typeof tempProject>>;
beforeEach(async () => {
  tmp = await tempProject();
});
afterEach(async () => {
  await tmp.cleanup();
});

const step = (name: string, fail = false): HookStep => ({
  name,
  shell: { run: fail ? `echo ${name} >> order.log; exit 3` : `echo ${name} >> order.log`, rollback: `echo undo-${name} >> order.log` },
});

function recorded() {
  const project = makeProject(tmp.dir, {});
  const { ctx } = makeContext(project, { runId: '20261011-142233-catalogue' });
  const seen: Array<Pick<HookResult, 'name' | 'phase' | 'status'>> = [];
  ctx.recordRun = async (r) => {
    seen.push({ name: r.name, phase: r.phase, status: r.status });
  };
  return { ctx, seen };
}

describe('HookContext.recordRun', () => {
  it('reports each hook run and each rollback: a failed setup, then its rollbacks', async () => {
    const { ctx, seen } = recorded();
    const journal = await Journal.open(join(tmp.dir, 'runs/20261011-142233-catalogue/hooks-journal.json'));
    const res = await runHooks([step('a'), step('b'), step('c', true), step('d')], ctx, { phase: 'setup', journal });
    expect(res.ok).toBe(false);
    expect(seen).toEqual([
      { name: 'a', phase: 'setup', status: 'ok' },
      { name: 'b', phase: 'setup', status: 'ok' },
      { name: 'c', phase: 'setup', status: 'failed' },
      { name: 'b', phase: 'rollback', status: 'ok' },
      { name: 'a', phase: 'rollback', status: 'ok' },
    ]);
  });

  it('reports a teardown and the replay of a journal; nothing for a dry run', async () => {
    const { ctx, seen } = recorded();
    const journal = await Journal.open(join(tmp.dir, 'runs/20261011-142233-catalogue/hooks-journal.json'));
    await runHooks([step('a')], ctx, { phase: 'setup', journal });
    await runHooks([step('t')], ctx, { phase: 'teardown', journal });
    await journal.rollbackAll(ctx);
    expect(seen.map((s) => `${s.phase} ${s.name} ${s.status}`)).toEqual(['setup a ok', 'teardown t ok', 'rollback a ok']);
    const dry = recorded();
    dry.ctx.dryRun = true;
    const dryJournal = await Journal.open(join(tmp.dir, 'runs/dry/hooks-journal.json'));
    await runHooks([step('x')], dry.ctx, { phase: 'teardown', journal: dryJournal });
    expect(dry.seen).toEqual([]);
  });

  it('a recorder that throws never fails the hooks', async () => {
    const { ctx } = recorded();
    ctx.recordRun = async () => {
      throw new Error('disk full');
    };
    const journal = await Journal.open(join(tmp.dir, 'runs/20261011-142233-catalogue/hooks-journal.json'));
    const res = await runHooks([step('a'), step('b')], ctx, { phase: 'teardown', journal });
    expect(res.ok).toBe(true);
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });
});
