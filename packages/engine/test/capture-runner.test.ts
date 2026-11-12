/**
 * The CaptureRunner port's run: the contract suite on the runner package (a real headless Chromium on a local page;
 * skipped without Chromium) and on the in-memory runner; then what the engine hands the runner, on the in-memory one —
 * a run job through the worker (the request executeRun builds: its run id, trust, approvals, the journal's recorder,
 * the signal, and the hook runner of the worker's ports), a run in process (the CLI's: its history line), an inspect job
 * (the inspection's folder and id, the report read back, the hook runner handed). What a real run of the fixture product
 * gives through these paths stays with the real runner: inspect-jobs.test.ts, worker-process.test.ts,
 * run-live-pause.test.ts and the CLI's run tests.
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE, PERSON_POLICY } from '@retake/core';
import type { LoadedProject, RunRecord } from '@retake/core';
import { chromiumExecutable } from '@retake/runner-web';
import { createEngine, historyFile, openWorkspace, prepareRun, runInProcess, runWorker, runnerWebCapture, signalInterrupts, systemClock, diskWorkspaceReads } from '../src/index.js';
import type { InspectJobResult, RunPorts } from '../src/index.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import type { CaptureRequest } from '../src/capture/runner.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';
import { MemorySandboxes } from '../src/sandboxes/memory-sandboxes.js';
import { openProjectBySlug } from '../src/projects.js';
import { startServer } from '@retake/test-support/capture';
import type { TestServer } from '@retake/test-support/capture';
import { captureRunnerContract } from './capture-runner-contract.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { CONFINEMENTS } from '../src/caller.js';
import { scratchHome } from '@retake/test-support/home';

const hasChromium = chromiumExecutable().path !== null;
const root = await mkdtemp(join(tmpdir(), 'retake-capture-runner-'));
let server: TestServer;
const retakeHome = scratchHome();

beforeAll(async () => {
  retakeHome.use(join(root, '.home'));
  server = await startServer({ '/': '<!doctype html><html><body><h1>Home</h1><p>A page to run on.</p></body></html>' });
});

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
  retakeHome.restore();
});

let n = 0;
async function projectOf(name: string): Promise<LoadedProject> {
  const slug = `contract-${name}-${n++}`;
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  return {
    slug,
    dir,
    root,
    file: join(dir, 'project.yaml'),
    readme: null,
    scenarios: [],
    config: { name: 'Northfield', environments: { test: { app: server.url } }, capture: { ...DEFAULT_CAPTURE, width: 640, height: 360 }, frame: 'raw', template: 'editorial' },
  };
}

captureRunnerContract('runner package', async (name) => ({ runner: runnerWebCapture(), project: await projectOf(name) }), { skip: !hasChromium });
captureRunnerContract('memory', async (name) => ({ runner: new MemoryCaptureRunner(), project: await projectOf(name) }));

describe('the in-memory capture runner', () => {
  it('keeps every call, and fails the step its options script, the record saying where', async () => {
    const runner = new MemoryCaptureRunner({ fail: (ref) => (ref === 'one.1' ? 'no such button' : undefined) });
    const project = await projectOf('fail');
    const { makeScenario } = await import('@retake/test-support/capture');
    const rec = await runner.run({
      policy: PERSON_POLICY,
      project,
      scenario: makeScenario('fail', { scenes: [{ id: 'one', page: 'app', open: '/', steps: [{ hold: 0.05 }, { click: 'Go' }, { hold: 0.05 }] }] }),
      mode: 'dry',
      env: 'test',
      hookRunner: new MemoryHookRunner(),
    });
    expect(rec).toMatchObject({ status: 'failed', steps_done: 2, error: { message: 'no such button', scene: 'one', step: 1, action: 'click' } });
    expect(runner.calls.map((c) => c.member)).toEqual(['run']);
  });
});

describe('what the engine hands the capture runner (in memory)', () => {
  const ws = join(root, 'ws');
  const requests = (runner: MemoryCaptureRunner): CaptureRequest[] => runner.calls.flatMap((c) => (c.member === 'run' ? [c.req] : []));

  beforeAll(async () => {
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
  });

  it("a run job through the worker: the run id reserved at submit, trust mcp, the job's approvals and journal, its signal, and the worker's hook runner", async () => {
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry', until: 'discover.1' });
    // The SIGTERM listeners when the worker loads its runner, and when it runs: its own handler comes after the load.
    const listening: number[] = [];
    class Ordered extends MemoryCaptureRunner {
      override async load(): Promise<void> {
        listening.push(process.listenerCount('SIGTERM'));
        return super.load();
      }

      override async run(r: CaptureRequest): Promise<RunRecord> {
        listening.push(process.listenerCount('SIGTERM'));
        return super.run(r);
      }
    }
    const capture = new Ordered();
    const hooks = new MemoryHookRunner();
    const before = process.listenerCount('SIGTERM');
    await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, ports: { capture, hooks } });
    expect(listening).toEqual([before, before + 1]);
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.result).toMatchObject({ kind: 'run', run_id: sub.run_id, status: 'succeeded', mode: 'dry', steps_done: 2, steps_total: 2 });
    // The worker loaded its runner before it listened to signals, then ran the one request.
    expect(capture.calls.map((c) => c.member)).toEqual(['load', 'run']);
    const [req] = requests(capture);
    expect(req!.hookRunner).toBe(hooks);
    expect(req).toMatchObject({ mode: 'dry', runId: sub.run_id, until: 'discover.1', hookTrust: 'mcp', hookVia: CONFINEMENTS.mcp });
    expect(req!.policy.agentFolders).not.toBeNull();
    for (const k of ['signal', 'confirmHook', 'recordHookRun', 'loginCommand', 'onProgress'] as const) expect(req![k], k).toBeTypeOf(k === 'signal' ? 'object' : 'function');
    expect(req!.loginCommand!({ project: 'p', env: 'e', persona: 'x' })).toMatch(/ login p --env e --persona x$/);
    const history = (await readFile(historyFile(ws), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(history.at(-1)).toMatchObject({
      kind: 'run',
      job: sub.job.id,
      run: { id: sub.run_id, scenario: 'quote', mode: 'dry', status: 'succeeded' },
      counted: { captures: 0, dry_runs: 1, renders: 0 },
    });
    const onDisk = JSON.parse(await readFile(join(ws, 'projects', 'northfield-fixture', 'runs', sub.run_id, 'run.json'), 'utf8')) as RunRecord;
    expect(onDisk.status).toBe('succeeded');
  });

  it("a run in process (the CLI's): the hook runner handed, no run id, trust author, then its history line as the cli's", async () => {
    const w = await openWorkspace({ root: ws, agent: false, reads: diskWorkspaceReads });
    const project = await openProjectBySlug(w, 'northfield-fixture');
    const prepared = await prepareRun(w, project, 'quote', { dry: true, until: 'discover.0' });
    const capture = new MemoryCaptureRunner();
    const hooks = new MemoryHookRunner();
    const progress: string[] = [];
    const ports: RunPorts = { issues: () => undefined, note: () => undefined, sandboxLog: () => undefined, progress: (e) => void progress.push(e.type), interrupts: signalInterrupts() };
    const rec = await runInProcess(prepared, { dry: true, until: 'discover.0' }, { policy: w.policy, capture, hooks, sandboxes: new MemorySandboxes(), clock: systemClock }, ports);
    expect(rec.status).toBe('succeeded');
    const [req] = requests(capture);
    expect(req!.hookRunner).toBe(hooks);
    expect(req!.runId).toBeUndefined();
    expect(req!.hookTrust).toBeUndefined();
    expect(req!.policy.agentFolders).toBeNull();
    expect(progress[0]).toBe('run_start');
    expect(progress.at(-1)).toBe('run_end');
    const history = (await readFile(historyFile(ws), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(history.at(-1)).toMatchObject({ kind: 'run', submitted_by: 'cli', run: { id: rec.id, scenario: 'quote', mode: 'dry', status: 'succeeded' } });
  });

  it("an inspect job: the inspection's folder and id, a dry replay with the worker's hook runner, its report read back", async () => {
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.inspect.submit({ project: 'northfield-fixture', scenario: 'quote', until: 'discover.1', images: 'none' });
    const capture = new MemoryCaptureRunner();
    const hooks = new MemoryHookRunner();
    await runWorker({ root: ws, once: true, idleExitMs: 0, pollMs: 50, log: () => undefined, ports: { capture, hooks } });
    const job = await engine.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const r = job.result as InspectJobResult;
    expect(r).toMatchObject({ kind: 'inspect', inspect_id: sub.inspect_id, reported: true, status: 'ok', at: 'until', run_status: 'succeeded', marked: null });
    const [req] = requests(capture);
    expect(req).toMatchObject({ mode: 'dry', runId: sub.inspect_id, runsDir: join(ws, 'projects', 'northfield-fixture', '.retake', 'inspect'), until: 'discover.1', hookTrust: 'mcp' });
    expect(req!.hookRunner).toBe(hooks);
    expect(req!.inspect?.onResult).toBeTypeOf('function');
    // An inspection skips the scenario's hooks: nothing ran through the hook runner (the worker's start only pruned).
    expect(hooks.calls.filter((c) => c.op !== 'journals.pruneDone')).toEqual([]);
    const { report } = await engine.inspect.get('northfield-fixture', sub.inspect_id);
    expect(report?.replay).toMatchObject({ until: 'discover.1', steps_done: 2 });
  });
});
