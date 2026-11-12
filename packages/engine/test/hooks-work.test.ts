/**
 * The hooks use cases orchestrated once (L7.23, U8b; engine hooks-work.ts), shared by the CLI's `hooks run` / `hooks
 * rollback` / `env reset` and the `hooks` / `env_reset` jobs — on the in-memory hook runner and pages. What the two
 * callers differ in stays with the caller: the jobs' protection (project files only, the approved bytes, their checks)
 * is an option the CLI does not pass, so the CLI gains none of it; `agentWritten` goes to the runner under trust `mcp`
 * only; a replay lists what it will run before it runs it (and replays nothing when nothing is pending); a cancelled
 * reset skips the reset hooks; the shell's interrupt watch is installed once the context exists and disposed after its
 * sessions are closed; the callbacks run while the sessions are open. The byte-level proofs are the CLI's characterization
 * (operations-cli.json) and MCP's (environment-ops, job-ops).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AccessError, DEFAULT_CAPTURE, PERSON_POLICY } from '@retake/core';
import type { HookStep, LoadedProject } from '@retake/core';
import { HooksSourceError, envResetWork, hooksRunWork, rollbackWork, systemClock, callerOf, diskWorkspaceReads } from '../src/index.js';
import type { WorkspaceReads } from '../src/index.js';
import type { HookWorkOptions } from '../src/index.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { MemoryHookPages } from '../src/capture/memory-sessions.js';

const root = await mkdtemp(join(tmpdir(), 'retake-hooks-work-'));
afterAll(() => rm(root, { recursive: true, force: true }));

const SETUP: HookStep[] = [{ name: 'seed', shell: { run: 'echo seed', rollback: 'echo unseed' } } as HookStep];
const RESET: HookStep[] = [{ name: 'wipe', shell: 'echo wipe' } as HookStep];

let n = 0;
async function project(reset: HookStep[] = RESET): Promise<LoadedProject> {
  const dir = join(root, `p${++n}`);
  await mkdir(join(dir, 'hooks'), { recursive: true });
  await writeFile(join(dir, 'hooks', 'in.yaml'), '- name: seed\n  shell:\n    run: echo seed\n    rollback: echo unseed\n');
  return {
    slug: `p${n}`,
    dir,
    root,
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: {
      name: 'P',
      environments: { test: { app: 'http://127.0.0.1:4911' }, live: { app: 'http://127.0.0.1:4912' } },
      environment_settings: { live: { production: true } },
      capture: { ...DEFAULT_CAPTURE },
      frame: 'card',
      template: 'default',
      reset,
    },
  } as LoadedProject;
}

const outside = join(root, 'outside.yaml');
await writeFile(outside, '- name: seed\n  shell:\n    run: echo seed\n    rollback: echo unseed\n');

function base(hooks: MemoryHookRunner, pages = new MemoryHookPages(), more: Partial<Omit<HookWorkOptions, 'trust'>> = {}): HookWorkOptions & { trust: 'author'; reads: WorkspaceReads } {
  return {
    policy: PERSON_POLICY,
    reads: diskWorkspaceReads,
    hooks,
    pages,
    env: 'test',
    dry: false,
    trust: 'author',
    confirm: async () => true,
    log: () => undefined,
    loginCommand: (p) => `retake login ${p.project} --env ${p.env}`,
    recordAs: { caller: callerOf('cli'), clock: systemClock },
    ...more,
  };
}

describe('hooksRunWork: select → context → journal → run, for the CLI and the jobs', () => {
  it("the CLI passes no protection and gains none (a hooks file outside the project runs); a job's refuses it before its own check, and nothing opens", async () => {
    const p = await project();
    const cli = new MemoryHookRunner();
    const out = await hooksRunWork(p, outside, { ...base(cli), runId: (sel) => `hooks-${sel.label}` });
    expect(out).toMatchObject({ ok: true, runId: 'hooks-outside', pending: 1, interrupted: false });
    // Trust `author`: no agentWritten handed to the runner (the CLI never passed one).
    expect(cli.calls.find((c) => c.op === 'run')).not.toHaveProperty('agentWritten');

    const job = new MemoryHookRunner();
    const checked: string[] = [];
    const e = await hooksRunWork(p, outside, { ...base(job), trust: 'mcp', runId: 'hooks-x', protection: { check: async (sel) => void checked.push(sel.label) } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HooksSourceError);
    expect((e as Error).message).toBe(`"${outside}" is not a hooks file of the project: use hooks/<name>.yaml`);
    expect(checked).toEqual([]);
    expect(job.calls).toEqual([]);
  });

  it("a job's check sees the selection before anything opens; trust `mcp` hands agentWritten on (false: not a scenario's)", async () => {
    const p = await project();
    const job = new MemoryHookRunner();
    const pages = new MemoryHookPages();
    let seen: unknown[] | undefined;
    const out = await hooksRunWork(p, 'hooks/in.yaml', {
      ...base(job, pages),
      trust: 'mcp',
      runId: 'hooks-in-1',
      protection: { check: async (sel) => void (seen = [sel.label, [...job.calls]]) },
    });
    expect(seen).toEqual(['in', []]);
    expect(out.ok).toBe(true);
    expect(job.calls.find((c) => c.op === 'run')).toMatchObject({ agentWritten: false, journal: join(p.dir, '.retake', 'journals', 'hooks-in-1.json') });
  });

  it('L7.39: the files onSelected returns (a person’s check) hold the hooks’ context (HookContext.trustedFiles); none, none', async () => {
    const p = await project();
    const trustedFiles = { code: { 'tools/x.sh': 'abc' }, data: {} };
    const seen: unknown[] = [];
    await hooksRunWork(p, 'hooks/in.yaml', {
      ...base(new MemoryHookRunner()),
      runId: 'hooks-held',
      onSelected: async () => ({ trustedFiles }),
      onStart: ({ ctx }) => void seen.push(ctx.trustedFiles),
    });
    await hooksRunWork(p, 'hooks/in.yaml', { ...base(new MemoryHookRunner()), runId: 'hooks-free', onSelected: async () => undefined, onStart: ({ ctx }) => void seen.push(ctx.trustedFiles) });
    expect(seen).toEqual([trustedFiles, undefined]);
  });

  it('a selection error goes through selectError; a context error through contextError (an access error on a read-only environment)', async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    const mapped = new Error('mapped');
    await expect(hooksRunWork(p, 'nope', { ...base(h), runId: 'x', selectError: () => mapped })).rejects.toBe(mapped);
    const e = await hooksRunWork(p, 'hooks/in.yaml', { ...base(h), env: 'live', allowWrites: true, runId: 'x', contextError: (x) => new Error(`usage: ${(x as Error).message}`) }).catch(
      (x: unknown) => x,
    );
    expect((e as Error).message).toMatch(/^usage: environment live is read-only in project\.yaml \(production: true\)/);
    // Without the mapper the access error itself.
    await expect(hooksRunWork(p, 'hooks/in.yaml', { ...base(h), env: 'live', allowWrites: true, runId: 'x' })).rejects.toBeInstanceOf(AccessError);
    expect(h.calls.filter((c) => c.op === 'run')).toEqual([]);
  });

  it('the interrupt watch is installed once the context exists and disposed after the sessions close; the callbacks run while they are open', async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    const pages = new MemoryHookPages({ evaluate: () => 1 });
    const events: string[] = [];
    let watching = false;
    const out = await hooksRunWork(p, 'hooks/in.yaml', {
      ...base(h, pages),
      runId: 'hooks-in-2',
      onInterrupt: async (close) => {
        expect(typeof close).toBe('function');
        events.push('watch');
        watching = true;
        return {
          get interrupted() {
            return true;
          },
          dispose: () => {
            events.push(`dispose (browser closed: ${pages.opened[0]?.closed})`);
            watching = false;
          },
        };
      },
      onStart: ({ ctx, runId, journalFile }) => {
        events.push(`start ${runId} ${journalFile.endsWith('hooks-in-2.json')} ${watching}`);
        // A js hook's browser, opened while the sessions are open.
        void ctx.evalInPage!('app', 'return 1');
      },
      onResults: (r) => events.push(`results ${r.results.length} interrupted ${r.interrupted} open ${!pages.opened[0]?.closed}`),
    });
    expect(events).toEqual(['watch', 'start hooks-in-2 true true', 'results 1 interrupted true open true', 'dispose (browser closed: true)']);
    expect(out.interrupted).toBe(true);
  });

  it("a job's cancel (its signal) is the outcome's interrupted", async () => {
    const p = await project();
    const ac = new AbortController();
    const h = new MemoryHookRunner({ onExecute: () => ac.abort() });
    const out = await hooksRunWork(p, 'hooks/in.yaml', { ...base(h), trust: 'mcp', signal: ac.signal, runId: 'hooks-in-3', protection: { check: async () => undefined } });
    expect(out.interrupted).toBe(true);
  });
});

describe('trust `mcp` needs the protection of the jobs', () => {
  it('is refused without it, by type and at run time, before anything is read or opened (both works)', async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    const words = "with trust mcp needs the jobs' protection (project files only, the approved bytes, their checks)";
    // @ts-expect-error -- wrong on purpose: trust `mcp` without protection does not type-check
    const run = await hooksRunWork(p, outside, { ...base(h), trust: 'mcp', runId: 'x' }).catch((x: unknown) => x);
    expect(run).toMatchObject({ code: 'internal', message: `hooksRunWork ${words}` });
    // @ts-expect-error -- wrong on purpose: trust `mcp` without protection does not type-check
    const reset = await envResetWork(p, { ...base(h), trust: 'mcp', runId: 'x' }).catch((x: unknown) => x);
    expect(reset).toMatchObject({ code: 'internal', message: `envResetWork ${words}` });
    expect(h.calls).toEqual([]);
    // Trust `author` needs none; with protection it does not type-check either.
    // @ts-expect-error -- wrong on purpose: the CLI's trust takes no protection
    await hooksRunWork(p, 'hooks/in.yaml', { ...base(h), runId: 'y', protection: { check: async () => undefined } });
  });
});

describe('rollbackWork: one journal, or every pending one, listed before the replay', () => {
  it('lists what it will replay before replaying it, then replays nothing when nothing is pending', async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    await hooksRunWork(p, 'hooks/in.yaml', { ...base(h), runId: 'hooks-in-4' });
    h.calls.splice(0);
    const seen: string[] = [];
    const out = await rollbackWork(p, {
      ...base(h),
      listed: (list) => seen.push(`listed ${list.length} after ${h.calls.map((c) => c.op).join(',')}`),
      onResults: (r) => seen.push(`results ${r.kind}`),
    });
    expect(seen).toEqual(['listed 1 after journals.openPending', 'results pending']);
    expect(out).toMatchObject({ kind: 'pending', ok: true, interrupted: false });
    expect(h.calls.map((c) => c.op)).toEqual(['journals.openPending', 'journals.rollback']);
    expect(h.executed.map((e) => e.phase)).toEqual(['setup', 'rollback']);

    h.calls.splice(0);
    const again = await rollbackWork(p, { ...base(h), listed: (list) => seen.push(`listed ${list.length}`) });
    expect(again).toMatchObject({ kind: 'pending', outcomes: [], ok: true });
    expect(h.calls.map((c) => c.op)).toEqual(['journals.openPending']);
    expect(seen.at(-1)).toBe('listed 0');
  });

  it("one run's journal: missing (where it looked), nothing pending (listed empty), or replayed", async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    expect(await rollbackWork(p, { ...base(h), id: 'hooks-none' })).toMatchObject({
      kind: 'missing',
      id: 'hooks-none',
      looked: [join(p.dir, 'runs', 'hooks-none', 'hooks-journal.json'), join(p.dir, '.retake', 'journals', 'hooks-none.json')],
    });
    await hooksRunWork(p, 'hooks/in.yaml', { ...base(h), runId: 'hooks-in-5' });
    const lists: number[] = [];
    const one = await rollbackWork(p, { ...base(h), id: 'hooks-in-5', listed: (list) => lists.push(list.length) });
    expect(one).toMatchObject({ kind: 'run', id: 'hooks-in-5', pending: 1, ok: true });
    expect(one.kind === 'run' && one.results.map((r) => r.phase)).toEqual(['rollback']);
    const none = await rollbackWork(p, { ...base(h), id: 'hooks-in-5', listed: (list) => lists.push(list.length) });
    expect(none).toMatchObject({ kind: 'run', pending: 0, results: [], ok: true });
    expect(lists).toEqual([1, 0]);
  });
});

describe('envResetWork: the pending replay, then the reset hooks', () => {
  it('runs the protection check before anything opens; the reset hooks are announced (onReset) before they run, journaled under the run id', async () => {
    const p = await project();
    const h = new MemoryHookRunner();
    const refused = new Error('protected');
    await expect(envResetWork(p, { ...base(h), trust: 'mcp', runId: 'env-reset-1', protection: { check: async () => Promise.reject(refused) } })).rejects.toBe(refused);
    expect(h.calls).toEqual([]);
    const events: string[] = [];
    const out = await envResetWork(p, {
      ...base(h),
      runId: 'env-reset-2',
      listed: (list) => events.push(`listed ${list.length}`),
      onRollbacks: (o) => events.push(`rollbacks ${o.length}`),
      onReset: (hooks) => events.push(`reset ${hooks.length} ran ${h.calls.some((c) => c.op === 'run')}`),
      onResults: (r) => events.push(`results ${r.reset?.results.length}`),
    });
    expect(events).toEqual(['listed 0', 'rollbacks 0', 'reset 1 ran false', 'results 1']);
    expect(out).toMatchObject({ ok: true, rollbacks: [], reset: { hooks: RESET, ok: true } });
    expect(h.calls.find((c) => c.op === 'run')).toMatchObject({ phase: 'reset', journal: join(p.dir, '.retake', 'journals', 'env-reset-2.json') });
    expect(h.calls.find((c) => c.op === 'run')).not.toHaveProperty('agentWritten');
  });

  it('no reset hooks: onReset with none, reset null; a cancel before the reset skips it (no onReset, nothing run)', async () => {
    const empty = await project([]);
    const h = new MemoryHookRunner();
    const said: number[] = [];
    expect(await envResetWork(empty, { ...base(h), runId: 'env-reset-3', onReset: (hooks) => said.push(hooks.length) })).toMatchObject({ ok: true, reset: null });
    expect(said).toEqual([0]);

    const p = await project();
    const ac = new AbortController();
    ac.abort();
    const out = await envResetWork(p, { ...base(h), trust: 'mcp', protection: { check: async () => undefined }, signal: ac.signal, runId: 'env-reset-4', onReset: () => said.push(-1) });
    expect(out).toMatchObject({ reset: null, interrupted: true });
    expect(said).toEqual([0]);
    expect(h.calls.filter((c) => c.op === 'run')).toEqual([]);
  });
});
