/**
 * The sandbox use cases (sandbox-work.ts, L7.28): what the CLI's `retake sandbox …` commands and the sandbox jobs share.
 * A lock-holding call (up, reset, down) runs under the caller's interrupt port — one scope opened with the sandbox's
 * message and a quit kill that is the handle's `killStartedSync`, disposed after an answer and after a refusal —; the
 * call's own options reach the handle key for key (a key given as `undefined` stays, no `seedTrust` the caller did not
 * give); the seed run is journalled as `recordAs`; a status comes with its environment's pages; the scaffold is read
 * back from what it wrote; following the logs holds its own scope. The handle and the port are recording stand-ins (the
 * contract suite holds the real adapter and the fake: sandboxes.test.ts).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, SandboxError } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { loadProject } from '@retake/core/io';
import type { InitSandboxResult } from '@retake/sandbox/types';
import { callerOf } from '../src/caller.js';
import { ManualClock } from '../src/clock.js';
import type { InterruptOptions, InterruptPort } from '../src/interrupts.js';
import { SANDBOX_INTERRUPT_MESSAGE, sandboxWork } from '../src/sandbox-work.js';
import { MemorySandboxes } from '../src/sandboxes/memory-sandboxes.js';
import type { SandboxHandle, Sandboxes } from '../src/sandboxes/sandboxes.js';
import { readJournal } from '../src/store/journal.js';
import { executeSandboxJob } from '../src/jobs/sandbox-job.js';
import { EngineError } from '../src/errors.js';
import { enginePorts } from '../src/ports.js';
import { openWorkspace } from '../src/workspace.js';

let root = '';
let project: LoadedProject;

const MANIFEST = ['version: 1', 'provider: process', 'services:', '  app:', '    command: [node, service.mjs]', '    url: http://localhost:4790', '    pages: {app: "http://localhost:4790"}', ''].join('\n');

async function writeProject(dir: string, sandboxes: string[]): Promise<void> {
  await mkdir(join(dir, 'sandbox'), { recursive: true });
  await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), MANIFEST);
  await writeFile(join(dir, 'project.yaml'), ['name: S', 'environments:', '  local: {app: "http://localhost:9"}', 'sandboxes:', ...sandboxes.map((n) => `  ${n}: sandbox/sandbox.yaml`), 'default_env: local', ''].join('\n'));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-sandbox-work-'));
  await writeProject(join(root, 's'), ['sandbox']);
  project = await loadProject(join(root, 's'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An interrupt port that records each scope it opens; `quit()` runs the last scope's quit kill. */
function recordingInterrupts() {
  const scopes: Array<{ opts: InterruptOptions | undefined; disposed: boolean; controller: AbortController }> = [];
  const port: InterruptPort = {
    open: async (opts) => {
      const scope = { opts, disposed: false, controller: new AbortController() };
      scopes.push(scope);
      return {
        signal: scope.controller.signal,
        get interrupted() {
          return scope.controller.signal.aborted;
        },
        dispose: () => {
          scope.disposed = true;
        },
      };
    },
  };
  return { port, scopes, quit: () => scopes.at(-1)?.opts?.onQuitSync?.() };
}

/** A handle that records the options of each call as given (keys and values), runs the seed recorder once, may refuse. */
function recordingHandle(o: { refuse?: boolean } = {}) {
  const calls: Array<{ op: string; keys: string[]; opts: Record<string, unknown> }> = [];
  let kills = 0;
  const seen = (op: string, opts: Record<string, unknown> = {}) => calls.push({ op, keys: Object.keys(opts).sort(), opts });
  const resetResult = { strategy: 'reseed', restored: false, ms: 1, hash: 'h', at: '2026-11-12T12:00:00.000Z', seed: { steps: 1, ms: 1 }, mailbox: 'none', restarted: [], superseded: 0, hooks: { steps: 0, ms: 0 } };
  const seeding = async (opts: Record<string, unknown>) => {
    await (opts.recordSeedRun as ((r: Record<string, unknown>) => Promise<void>) | undefined)?.({ index: 0, name: 'mark', kind: 'shell', phase: 'seed', status: 'ok', ms: 2 });
    if (o.refuse) throw new SandboxError('sandbox sandbox is in use: refused on purpose', 'busy');
  };
  const sb = {
    env: 'sandbox',
    kind: 'process',
    strategy: 'reseed',
    paths: { logs: '/nowhere/logs' },
    capabilities: {},
    async up(opts: Record<string, unknown> = {}) {
      seen('up', opts);
      await seeding(opts);
      return { started: ['app'], kept: [], changed: [], ms: 3 };
    },
    async reset(opts: Record<string, unknown> = {}) {
      seen('reset', opts);
      await seeding(opts);
      return resetResult;
    },
    async down(opts: Record<string, unknown> = {}) {
      seen('down', opts);
      if (o.refuse) throw new SandboxError('refused on purpose', 'busy');
      return { stopped: ['app'], dataGone: true };
    },
    async status(opts?: Record<string, unknown>) {
      seen('status', opts);
      return { env: 'sandbox', provider: 'process', file: '', state: 'up', services: [], logs: '', notes: [] };
    },
    async logs(opts: Record<string, unknown> = {}) {
      seen('logs', opts);
      return [];
    },
    async followLogs(opts: Record<string, unknown>) {
      seen('followLogs', opts);
      if (o.refuse) throw new SandboxError('unknown service "x" (services: app)');
    },
    killStartedSync() {
      kills++;
    },
  } as unknown as SandboxHandle;
  return { sb, calls, kills: () => kills };
}

const log = () => undefined;

describe('sandboxWork (L7.28)', () => {
  it('up, reset and down hold one interrupt scope each: the message, killStartedSync on quit, disposed after an answer and after a refusal', async () => {
    for (const refuse of [false, true]) {
      const h = recordingHandle({ refuse });
      const ir = recordingInterrupts();
      const recordAs = { caller: callerOf('cli'), clock: new ManualClock('2026-11-12T12:00:00.000Z') };
      const runs: Array<() => Promise<unknown>> = [
        () => sandboxWork.up(project, h.sb, { trust: 'author', interrupts: ir.port, log, recordAs }),
        () => sandboxWork.reset(project, h.sb, { trust: 'author', interrupts: ir.port, log, recordAs }),
        () => sandboxWork.down(h.sb, { interrupts: ir.port, log }),
      ];
      for (const [i, run] of runs.entries()) {
        if (refuse) await expect(run()).rejects.toBeInstanceOf(SandboxError);
        else await run();
        const scope = ir.scopes[i];
        expect(scope.opts?.message).toBe(SANDBOX_INTERRUPT_MESSAGE);
        expect(scope.disposed).toBe(true);
        expect(h.calls[i].opts.signal).toBe(scope.controller.signal);
        const before = h.kills();
        ir.quit();
        expect(h.kills()).toBe(before + 1);
      }
      expect(ir.scopes).toHaveLength(3);
    }
    expect(SANDBOX_INTERRUPT_MESSAGE).toBe('interrupted: stopping what this command started…');
  });

  it("hands each call's own options on key for key: the CLI's (progress, seed, build, reseed, volumes; undefined kept) and the job's (seedTrust); never a seedTrust not given", async () => {
    const h = recordingHandle();
    const ir = recordingInterrupts();
    const recordAs = { caller: callerOf('cli'), clock: new ManualClock() };
    const progress = { step: () => undefined, note: () => undefined };
    await sandboxWork.up(project, h.sb, { trust: 'author', interrupts: ir.port, log, progress, recordAs, seed: 'never', build: undefined });
    await sandboxWork.reset(project, h.sb, { trust: 'author', interrupts: ir.port, log, progress, reseed: undefined, recordAs });
    await sandboxWork.down(h.sb, { interrupts: ir.port, log, volumes: undefined });
    const seedTrust = { trust: 'mcp' as const, confirm: async () => true };
    await sandboxWork.up(project, h.sb, { trust: 'mcp', interrupts: ir.port, log, seedTrust, recordAs });
    await sandboxWork.reset(project, h.sb, { trust: 'mcp', interrupts: ir.port, log, seedTrust, recordAs, reseed: true });
    expect(h.calls.map((c) => [c.op, c.keys])).toEqual([
      ['up', ['build', 'log', 'progress', 'recordSeedRun', 'seed', 'signal']],
      ['reset', ['log', 'progress', 'recordSeedRun', 'reseed', 'signal']],
      ['down', ['log', 'signal', 'volumes']],
      ['up', ['log', 'recordSeedRun', 'seedTrust', 'signal']],
      ['reset', ['log', 'recordSeedRun', 'reseed', 'seedTrust', 'signal']],
    ]);
    expect(h.calls[0].opts).toMatchObject({ seed: 'never', progress, log });
    expect(h.calls[3].opts.seedTrust).toBe(seedTrust);
    expect(h.calls[4].opts.reseed).toBe(true);
  });

  it('the seed trust follows the trust: an mcp up / reset without the engine seed trust is refused before the sandbox is touched; the scope signal always wins', async () => {
    const h = recordingHandle();
    const ir = recordingInterrupts();
    const recordAs = { caller: callerOf('mcp'), clock: new ManualClock() };
    // @ts-expect-error: trust mcp without its seed trust (the type refuses it; the guard too, at run time)
    const up = await sandboxWork.up(project, h.sb, { trust: 'mcp', interrupts: ir.port, log, recordAs }).catch((e: unknown) => e);
    expect(up).toBeInstanceOf(EngineError);
    expect(up).toMatchObject({ code: 'internal', message: expect.stringContaining('sandboxWork.up with trust mcp needs the seed trust of the engine') });
    // @ts-expect-error: trust mcp with a seed trust of the person's trust (author)
    const reset = await sandboxWork.reset(project, h.sb, { trust: 'mcp', seedTrust: { trust: 'author' }, interrupts: ir.port, log, recordAs }).catch((e: unknown) => e);
    expect(reset).toMatchObject({ code: 'internal', message: expect.stringContaining('sandboxWork.reset with trust mcp') });
    expect(h.calls).toEqual([]);
    expect(ir.scopes).toEqual([]);
    // @ts-expect-error: trust author with a seed trust (the person's seed asks no approval: a caller giving one is wrong)
    await sandboxWork.up(project, h.sb, { trust: 'author', seedTrust: { trust: 'mcp' }, interrupts: ir.port, log, recordAs });
    // A signal handed on with the options never replaces the scope's (its abort is what stops the call on Ctrl-C).
    const stray = new AbortController().signal;
    h.calls.length = 0;
    ir.scopes.length = 0;
    await sandboxWork.up(project, h.sb, { trust: 'author', interrupts: ir.port, log, recordAs, signal: stray } as never);
    await sandboxWork.reset(project, h.sb, { trust: 'author', interrupts: ir.port, log, recordAs, signal: stray } as never);
    await sandboxWork.down(h.sb, { interrupts: ir.port, log, signal: stray } as never);
    expect(h.calls.map((c, i) => c.opts.signal === ir.scopes[i].controller.signal)).toEqual([true, true, true]);
    expect(h.calls.every((c) => !('trust' in c.opts))).toBe(true);
  });

  it('journals the seed run as recordAs (the caller, its clock, the project)', async () => {
    const h = recordingHandle();
    const ir = recordingInterrupts();
    await sandboxWork.up(project, h.sb, { trust: 'author', interrupts: ir.port, log, recordAs: { caller: callerOf('cli'), clock: new ManualClock('2026-11-12T10:00:00.000Z') } });
    await sandboxWork.reset(project, h.sb, { trust: 'mcp', seedTrust: { trust: 'mcp' }, interrupts: ir.port, log, recordAs: { caller: callerOf('mcp'), clock: new ManualClock('2026-11-12T11:00:00.000Z') } });
    const entries = (await readJournal(project.root, { project: project.slug })).slice(-2);
    expect(entries.map((e) => ({ at: e.at, client: e.by?.client, trust: e.by?.trust, project: e.project, hook: (e as { hook?: string }).hook }))).toEqual([
      { at: '2026-11-12T10:00:00.000Z', client: 'cli', trust: callerOf('cli').trust, project: project.slug, hook: 'mark' },
      { at: '2026-11-12T11:00:00.000Z', client: 'mcp', trust: callerOf('mcp').trust, project: project.slug, hook: 'mark' },
    ]);
  });

  it("status: the handle's answer with its environment's pages (the MCP view's and the CLI's)", async () => {
    const sandboxes = new MemorySandboxes();
    const sb = await sandboxWork.open(sandboxes, project, undefined, PERSON_POLICY);
    const { status, pages } = await sandboxWork.status(project, sb);
    expect(status.state).toBe('down');
    expect(pages).toEqual({ app: 'http://localhost:4790' });
    await expect(sandboxWork.open(sandboxes, project, 'nowhere', PERSON_POLICY)).rejects.toThrow(/nowhere is not a sandbox of project/);
  });

  it('logs and followLogs: options on, the follow under a scope of its own (no quit kill), disposed after a refusal', async () => {
    const h = recordingHandle({ refuse: true });
    const ir = recordingInterrupts();
    await sandboxWork.logs(h.sb, { service: 'app', lines: 5 });
    const write = () => undefined;
    await expect(sandboxWork.followLogs(h.sb, { service: 'x', lines: 7, interrupts: ir.port, write })).rejects.toThrow(/^unknown service/);
    expect(h.calls.map((c) => [c.op, c.keys])).toEqual([
      ['logs', ['lines', 'service']],
      ['followLogs', ['lines', 'service', 'signal', 'write']],
    ]);
    expect(ir.scopes).toHaveLength(1);
    expect(ir.scopes[0].opts).toEqual({ message: 'stopped following the logs' });
    expect(ir.scopes[0].disposed).toBe(true);
    expect(h.calls[1].opts.signal).toBe(ir.scopes[0].controller.signal);
  });

  it('init: the scaffold through the port, then the project read back from what it wrote (warnings, default or not)', async () => {
    const dir = join(root, 'i');
    await writeProject(dir, ['sandbox']);
    const before = await loadProject(dir);
    const result = (env: string) => ({ env, dir: join(dir, 'sandbox'), manifest: join(dir, 'sandbox', 'sandbox.yaml'), files: [], projectYaml: 'added', ports: { app: 1, db: 2, mailpit: 3 } }) as unknown as InitSandboxResult;
    const given: unknown[] = [];
    const sandboxes: Sandboxes = {
      open: () => Promise.reject(new Error('not opened')),
      // The scaffold declares its sandbox in project.yaml (`first`: before the others): only a read after it sees it.
      init: async (p, o) => {
        given.push({ project: p, ...o });
        const env = o.env ?? 'sandbox';
        await writeProject(dir, [...new Set(o.force ? [env, 'sandbox'] : ['sandbox', env])]);
        return result(env);
      },
    };
    const write = async () => undefined;
    const other = await sandboxWork.init(sandboxes, before, { env: 'other', force: true, write } as never);
    expect(other.result.env).toBe('other');
    expect(other.isDefault).toBe(true);
    expect(other.warnings).toEqual([]);
    expect(given).toEqual([{ project: before, env: 'other', force: true, write }]);
    const third = await sandboxWork.init(sandboxes, before, { env: 'third', write } as never);
    expect(third.isDefault).toBe(false);
    const first = await sandboxWork.init(sandboxes, before, { write } as never);
    expect(first.isDefault).toBe(true);
    // A SandboxError of the scaffold is the caller's to word (the CLI: a usage error).
    const refusing: Sandboxes = { ...sandboxes, init: () => Promise.reject(new SandboxError('sandbox folder exists: --force')) };
    await expect(sandboxWork.init(refusing, before, { write } as never)).rejects.toBeInstanceOf(SandboxError);
  });

  it("the sandbox jobs run through it: up and reset under the job's interrupt port (its quit kill is the handle's), the result unchanged", async () => {
    const wsRoot = join(root, 'w');
    await writeProject(join(wsRoot, 'projects', 's'), ['sandbox']);
    const ws = await openWorkspace({ root: wsRoot, agent: false });
    const sandboxes = new MemorySandboxes();
    for (const input of [
      { version: 1, kind: 'sandbox_up', project: 's', submitted_by: 'test' },
      { version: 1, kind: 'sandbox_reset', project: 's', reseed: true, submitted_by: 'test' },
    ] as const) {
      const ir = recordingInterrupts();
      const result = await executeSandboxJob({ ...enginePorts({ sandboxes }), ws, cli: 'retake', input, signal: new AbortController().signal, interrupts: ir.port, event: () => undefined });
      expect(result).toMatchObject({ kind: input.kind, env: 'sandbox', provider: 'process', pages: { app: 'http://localhost:4790' } });
      expect(ir.scopes).toHaveLength(1);
      expect(ir.scopes[0].opts?.message).toBe(SANDBOX_INTERRUPT_MESSAGE);
      expect(ir.scopes[0].disposed).toBe(true);
      ir.quit();
      expect(sandboxes.calls.at(-1)).toEqual({ op: 'killStartedSync', env: 'sandbox' });
    }
    expect(sandboxes.calls.filter((c) => c.op === 'up' || c.op === 'reset').map((c) => [c.op, c.opts])).toEqual([
      ['up', undefined],
      ['reset', { reseed: true }],
    ]);
  });
});
