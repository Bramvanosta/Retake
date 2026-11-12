/**
 * The HookRunner port: the contract suite on the hooks package (shell hooks run by `sh` in a temp project) and on the
 * in-memory runner, and what only the in-memory one has (the calls it keeps, its scripted outcomes and approvals, its
 * refusal of another runner's journal).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE, PERSON_POLICY } from '@retake/core';
import type { HookContext, HookStep, LoadedProject } from '@retake/core';
import { packageHookRunner, runWorker } from '../src/index.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { hookRunnerContract } from './hook-runner-contract.js';

const root = await mkdtemp(join(tmpdir(), 'retake-hook-runner-'));
afterAll(() => rm(root, { recursive: true, force: true }));

let n = 0;
async function projectDir(name: string): Promise<string> {
  const dir = join(root, `${name}-${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function project(dir: string): LoadedProject {
  return {
    slug: 'northfield',
    dir,
    root,
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: { name: 'Northfield', environments: { local: { console: 'http://127.0.0.1:9' } }, capture: { ...DEFAULT_CAPTURE }, frame: 'card', template: 'default' },
  };
}

function contextOf(p: LoadedProject): (over?: Partial<HookContext>) => HookContext {
  return (over = {}) => ({ project: p, policy: PERSON_POLICY, env: { name: 'local', pages: { ...p.config.environments.local } }, vars: {}, log: () => undefined, saved: {}, ...over });
}

const flags = (o: { destructive?: boolean; optional?: boolean } = {}) => ({ ...(o.destructive ? { destructive: true } : {}), ...(o.optional ? { optional: true } : {}) });

hookRunnerContract('hooks package, sh', async (name) => {
  const dir = await projectDir(name);
  const log = join(dir, 'ran.log');
  return {
    runner: packageHookRunner(),
    dir,
    ctx: contextOf(project(dir)),
    ok: (h, o = {}) => ({ name: h, shell: { run: `echo ${h} >> ran.log`, ...(o.rollback ? { rollback: `echo rb-${h} >> ran.log` } : {}) }, ...flags(o) }) as HookStep,
    failing: (h, o = {}) => ({ name: h, shell: `echo ${h} >> ran.log; exit 3`, ...flags(o) }) as HookStep,
    ran: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
  };
});

hookRunnerContract('memory', async (name) => {
  const dir = await projectDir(name);
  // A hook fails when its outcome says so: here, the one shell hook written `exit 3`.
  const runner = new MemoryHookRunner({ outcome: (h) => ('shell' in h && h.shell === 'exit 3' ? { status: 'failed', error: 'exit 3' } : undefined) });
  return {
    runner,
    dir,
    ctx: contextOf(project(dir)),
    ok: (h, o = {}) => ({ name: h, shell: { run: `echo ${h}`, ...(o.rollback ? { rollback: `echo rb-${h}` } : {}) }, ...flags(o) }) as HookStep,
    failing: (h, o = {}) => ({ name: h, shell: 'exit 3', ...flags(o) }) as HookStep,
    ran: async () => runner.executed.map((e) => (e.phase === 'rollback' ? `rb-${e.name}` : String(e.name))),
  };
});

describe('the memory hook runner', () => {
  it('keeps every call, answers its scripted outcomes and approvals, and asks nobody in a dry run through MCP', async () => {
    const dir = await projectDir('memory-own');
    const ctx = contextOf(project(dir));
    const runner = new MemoryHookRunner({
      outcome: (_h, place) => (place.index === 1 ? { status: 'failed', error: 'boom' } : undefined),
      needsHuman: (h) => (h.name === 'del' ? 'HTTP DELETE' : undefined),
      files: () => ({ files: { 'data/x.sql': 'f'.repeat(64) }, problems: [] }),
    });
    const journal = await runner.journals.open(join(dir, 'j.json'));
    const hooks: HookStep[] = [
      { name: 'del', http: { method: 'DELETE', url: '{{console}}/x' } },
      { name: 'sh', shell: 'echo hi' },
    ];
    let asked = 0;
    const dry = await runner.run(hooks, ctx({ dryRun: true, trust: 'mcp', confirmDestructive: () => (asked++, true) }), { phase: 'setup', journal, agentWritten: true });
    expect(asked).toBe(0);
    expect(dry.results.map((r) => [r.status, r.approval?.reason])).toEqual([
      ['dry', 'HTTP DELETE'],
      ['dry', 'a shell command (runs local code)'],
    ]);
    // Its fingerprint is the port's own, its files bound.
    expect(dry.results[0].approval?.fingerprint).toBe(await runner.approval.fingerprint(hooks[0], { phase: 'setup', index: 0, env: 'local', files: { 'data/x.sql': 'f'.repeat(64) } }));
    expect(dry.results[0].description).toBe('del: http DELETE {{console}}/x');
    const real = await runner.run(hooks, ctx({ trust: 'mcp', confirmDestructive: () => true }), { phase: 'setup', journal });
    expect(real.results.map((r) => [r.name, r.status, r.error])).toEqual([
      ['del', 'ok', undefined],
      ['sh', 'failed', 'boom'],
    ]);
    expect(runner.calls.filter((c) => c.op === 'run').map((c) => c.op === 'run' && [c.phase, c.dry, c.agentWritten])).toEqual([
      ['setup', true, true],
      ['setup', false, undefined],
    ]);
    // A seed asks about its shell steps only, and only through MCP.
    const seed = await runner.run(hooks, ctx({ confirmDestructive: () => false }), { phase: 'seed', journal });
    expect(seed.results.map((r) => r.status)).toEqual(['ok', 'failed']);
    await runner.journals.pruneDone();
    expect(runner.calls.at(-1)).toEqual({ op: 'journals.pruneDone' });
  });

  it("refuses a journal another runner opened, the package's as another memory runner's", async () => {
    const dir = await projectDir('memory-foreign');
    const ctx = contextOf(project(dir));
    const a = new MemoryHookRunner();
    const b = new MemoryHookRunner();
    const foreign = await b.journals.open(join(dir, 'j.json'));
    await expect(a.run([{ shell: 'echo' }], ctx(), { phase: 'setup', journal: foreign })).rejects.toMatchObject({ code: 'internal' });
    await expect(a.journals.rollback([{ file: 'x', journal: foreign }], ctx())).rejects.toMatchObject({ code: 'internal' });
    const pkg = await packageHookRunner().journals.open(join(dir, 'p.json'));
    await expect(a.run([{ shell: 'echo' }], ctx(), { phase: 'setup', journal: pkg })).rejects.toMatchObject({ code: 'internal' });
    await expect(packageHookRunner().run([{ shell: 'echo' }], ctx(), { phase: 'setup', journal: foreign })).rejects.toMatchObject({ code: 'internal' });
  });

  it('finds a journal where the package looks for one, once it holds an entry', async () => {
    const dir = await projectDir('memory-find');
    const runner = new MemoryHookRunner();
    const real = await packageHookRunner().journals.find(dir, '20261111-110000-hooks-x');
    const none = await runner.journals.find(dir, '20261111-110000-hooks-x');
    expect(none).toEqual(real);
    expect(none.file).toBeNull();
    expect(await runner.journals.standaloneFile(dir, 'id')).toBe(await packageHookRunner().journals.standaloneFile(dir, 'id'));
    const file = await runner.journals.standaloneFile(dir, '20261111-110000-hooks-x');
    const journal = await runner.journals.open(file);
    expect((await runner.journals.find(dir, '20261111-110000-hooks-x')).file).toBeNull();
    await runner.run([{ shell: 'echo' }], contextOf(project(dir))(), { phase: 'teardown', journal });
    expect((await runner.journals.find(dir, '20261111-110000-hooks-x')).file).toBe(file);
  });

  it("a worker's start forgets old rollback records through the hook runner it was handed", async () => {
    const ws = await projectDir('worker');
    await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
    const runner = new MemoryHookRunner();
    expect(await runWorker({ root: ws, idleExitMs: 200, pollMs: 50, log: () => undefined, ports: { hooks: runner } })).toBe(0);
    expect(runner.calls).toEqual([{ op: 'journals.pruneDone' }]);
  });
});
