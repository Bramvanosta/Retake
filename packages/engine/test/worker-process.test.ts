/**
 * The jobs worker in a process of its own (`node --conditions=source --import tsx engine/src/worker-main.ts`), on a
 * workspace whose project films the fixture product on free ports: it claims, runs, cancels and reports jobs; one worker
 * per workspace; signals; a killed worker leaves `interrupted`; it exits once idle or when the workspace is gone, and
 * writes nothing on stdout. Skipped when Chromium or ffmpeg is not available.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecordSchema, loadProject, loadScenario, reserveRunId } from '@demo-studio/core';
import { hookFingerprint } from '@demo-studio/hooks';
import type { RunRecord } from '@demo-studio/core';
import { FileJobQueue, createEngine, sha256Hex } from '../src/index.js';
import type { Engine, JobRecord } from '../src/index.js';
import { REPO } from './helpers.js';

function chromiumAvailable(): boolean {
  if (process.env.DEMO_STUDIO_CHROMIUM) return existsSync(process.env.DEMO_STUDIO_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const AVAILABLE = chromiumAvailable() && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

const SHORT = `video: short
pacing: {scene_start_still: 0.2}
scenes:
  - id: imports
    page: console
    open: /imports
    steps:
      - hold: 0.2
      - hold: 0.2
`;

/** A setup that arms something with a rollback, a teardown, and a step that waits long enough to be cancelled. */
const LONG = `video: long
setup:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
  - name: arm-proposal
    http:
      method: POST
      url: "{{console}}/api/quotes/auto-proposal"
      json: {after_minutes: 30}
      rollback: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}
teardown:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
pacing: {scene_start_still: 0.2}
scenes:
  - id: wait
    page: console
    open: /imports
    steps:
      - wait: 30
`;

let fixture: Fixture;
let ws: string;
let home: string;
const savedHome = process.env.DEMO_STUDIO_HOME;
/** A human who approves (LONG's setup has a rollback DELETE: it needs an approval through MCP). */
const YES = { approve: async () => ({ approved: true as const }) };
let engine: Engine;
let queue: FileJobQueue;
const workers: ChildProcess[] = [];

interface Worker {
  child: ChildProcess;
  out(): string;
  err(): string;
  exited: Promise<number | null>;
}

function startWorker(root: string, ...args: string[]): Worker {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', join(REPO, 'packages/engine/src/worker-main.ts'), '--root', root, ...args], {
    cwd: REPO,
    env: { ...process.env, DEMO_STUDIO_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  workers.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('exit', (code, sig) => r(code ?? (sig ? -1 : null))));
  return { child, out: () => out, err: () => err, exited };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const finished = (id: string) => async () => {
  const j = await queue.get(id);
  return j && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : undefined;
};
const waiting = (id: string) => async () => {
  const j = await queue.get(id);
  return j?.state === 'running' && j.progress?.current?.action === 'wait' ? j : undefined;
};

async function runRecord(runId: string): Promise<RunRecord> {
  return RunRecordSchema.parse(JSON.parse(await readFile(join(ws, 'projects', 'w', 'runs', runId, 'run.json'), 'utf8'))) as RunRecord;
}

/** Nothing of the setup is left pending: the rollback ran (status rolled_back), none is `ok` with a rollback. */
async function noPendingRollback(runId: string): Promise<void> {
  const journal = JSON.parse(await readFile(join(ws, 'projects', 'w', 'runs', runId, 'hooks-journal.json'), 'utf8')) as { entries: Array<{ status: string; rollback?: unknown }> };
  expect(journal.entries.filter((x) => x.status === 'ok' && x.rollback)).toEqual([]);
  expect(journal.entries.some((x) => x.status === 'rolled_back')).toBe(true);
}

describe.skipIf(!AVAILABLE)('jobs worker in its own process', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
      startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture>;
    };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'studio-worker-'));
    home = join(ws, '.home');
    // Approvals are signed at enqueue with the key of the studio home: the worker (same home) verifies them.
    process.env.DEMO_STUDIO_HOME = home;
    await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'w');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      ['name: W', 'environments:', '  local:', `    console: ${fixture.urls.console}`, `    shop: ${fixture.urls.shop}`, 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', ''].join('\n'),
    );
    await writeFile(join(project, 'scenarios', 'short.yaml'), SHORT);
    await writeFile(join(project, 'scenarios', 'long.yaml'), LONG);
    engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    queue = new FileJobQueue(ws);
  });

  afterAll(async () => {
    for (const w of workers) if (w.exitCode === null && w.signalCode === null) w.kill('SIGKILL');
    if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
    else process.env.DEMO_STUDIO_HOME = savedHome;
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('claims a dry run, runs it to succeeded, exits once idle; stdout stays empty', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    const w = startWorker(ws, '--idle-exit', '800');
    const job = await waitFor('the job', finished(sub.job.id));
    expect(job.state, JSON.stringify(job)).toBe('succeeded');
    expect(job.result).toMatchObject({ kind: 'run', run_id: sub.run_id, status: 'succeeded', steps_done: 2, steps_total: 2 });
    expect(job.worker?.pid).toBe(w.child.pid);
    const events = await queue.events(sub.job.id);
    const runEvents = events.filter((e): e is Extract<typeof e, { type: 'run' }> => e.type === 'run').map((e) => e.event.type);
    expect(runEvents[0]).toBe('run_start');
    expect(runEvents.at(-1)).toBe('run_end');
    expect(events.map((e) => e.type).slice(-2)).toEqual(['state', 'result']);
    const record = await runRecord(sub.run_id);
    expect(record.status).toBe('succeeded');
    for (const s of record.screenshots) expect(existsSync(s)).toBe(true);
    expect(await w.exited).toBe(0);
    expect(w.out()).toBe('');
    expect(w.err()).toContain(`job ${sub.job.id}: succeeded`);
  });

  it('two workers on one workspace: one serves, the other exits at once', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    const a = startWorker(ws, '--idle-exit', '800');
    const b = startWorker(ws, '--idle-exit', '800');
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    const serving = [a, b].filter((w) => w.err().includes('serving'));
    expect(serving).toHaveLength(1);
    expect([a, b].find((w) => w !== serving[0])!.err()).toContain('another worker serves this workspace');
    expect((await queue.get(sub.job.id))?.state).toBe('succeeded');
  });

  it('a cancel while queued: the job never starts; the next worker closes it and its reserved run', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    expect((await engine.runs.cancel('w', sub.run_id)).state).toBe('cancelled');
    expect((await queue.stored(sub.job.id))?.state).toBe('queued');
    const w = startWorker(ws, '--idle-exit', '500');
    expect(await w.exited).toBe(0);
    expect(await queue.stored(sub.job.id)).toMatchObject({ state: 'cancelled', error: { message: 'cancelled before it started' } });
    expect(await runRecord(sub.run_id)).toMatchObject({ status: 'cancelled', error: { message: 'cancelled before it started' } });
    expect(await queue.events(sub.job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'state', state: 'cancelled' })]));
  });

  it('a cancel while running: teardown and rollbacks run; job and run end cancelled', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'long', mode: 'capture' }, { approver: YES });
    const w = startWorker(ws, '--idle-exit', '800');
    await waitFor('the wait step', waiting(sub.job.id));
    await engine.jobs.cancel(sub.job.id);
    const job = await waitFor('the cancel', finished(sub.job.id), 30_000);
    expect(job).toMatchObject({ state: 'cancelled', error: { code: 'cancelled', message: 'run cancelled (cancel requested)' }, result: { status: 'cancelled' } });
    const record = await runRecord(sub.run_id);
    expect(record).toMatchObject({ status: 'cancelled', hooks: { setup: 'ok', teardown: 'ok' } });
    await noPendingRollback(sub.run_id);
    expect(await w.exited).toBe(0);
    expect(w.out()).toBe('');
  });

  it('SIGTERM to a busy worker: its job is cancelled (teardown ran) and it exits without claiming the next one', async () => {
    const busy = await engine.runs.submit({ project: 'w', scenario: 'long', mode: 'capture' }, { approver: YES });
    const next = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    const w = startWorker(ws, '--idle-exit', '5000');
    await waitFor('the wait step', waiting(busy.job.id));
    const t0 = Date.now();
    w.child.kill('SIGTERM');
    expect(await w.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(20_000);
    const job = (await queue.get(busy.job.id)) as JobRecord;
    expect(job).toMatchObject({ state: 'cancelled', result: { status: 'cancelled' } });
    expect(await runRecord(busy.run_id)).toMatchObject({ status: 'cancelled', hooks: { setup: 'ok', teardown: 'ok' }, error: { message: 'run cancelled (SIGTERM)' } });
    await noPendingRollback(busy.run_id);
    expect(await queue.get(next.job.id)).toMatchObject({ state: 'queued' });
    expect(await queue.claimOf(next.job.id)).toBeUndefined();
  });

  it('SIGKILL mid-run: `interrupted` with the env reset fix, run.json left as it was; the next worker records it and runs the queue', async () => {
    const killed = await engine.runs.submit({ project: 'w', scenario: 'long', mode: 'capture' }, { approver: YES });
    const queued = (await queue.list({ project: 'w', states: ['queued'] })).map((j) => j.id).filter((id) => id !== killed.job.id);
    expect(queued).toHaveLength(1);
    const w = startWorker(ws, '--idle-exit', '5000');
    // The queued dry run of the previous test runs first (oldest first), then this capture.
    await waitFor('the wait step', waiting(killed.job.id), 90_000);
    w.child.kill('SIGKILL');
    await w.exited;
    const job = await waitFor('interrupted', async () => {
      const j = await queue.get(killed.job.id);
      return j?.state === 'interrupted' ? j : undefined;
    }, 10_000);
    expect(job.error?.message).toContain('stopped while the job ran');
    expect((await engine.jobs.get(killed.job.id)).error?.fix).toBe(`studio -C ${ws} env reset w`);
    expect((await runRecord(killed.run_id)).status).toBe('running');
    expect(await engine.runs.status('w', killed.run_id)).toMatchObject({ status: 'interrupted', finished: true, job: { state: 'interrupted' } });
    for (const id of queued) expect((await queue.get(id))?.state).toBe('succeeded');
    // The next worker persists the derived state.
    const again = startWorker(ws, '--idle-exit', '300');
    expect(await again.exited).toBe(0);
    expect((await queue.stored(killed.job.id))?.state).toBe('interrupted');
  });

  it('a second signal quits at once (exit 130) and the runner still kills the shell hook it runs', async () => {
    // A teardown shell hook that takes long (its own duration, so that only its process is found). A shell hook needs a
    // human approval through MCP: this job is queued directly, with the approval of that hook's fingerprint.
    const tag = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
    const sleepCmd = `sleep 20.${tag}`;
    const yaml = LONG.replace('teardown:\n', `teardown:\n  - name: slow-cleanup\n    shell: {run: "${sleepCmd}"}\n    writes: false\n`).replace('video: long', 'video: slow-teardown');
    const file = join(ws, 'projects', 'w', 'scenarios', 'slow-teardown.yaml');
    await writeFile(file, yaml);
    const { id: runId } = await reserveRunId(join(ws, 'projects', 'w', 'runs'), 'slow-teardown');
    const loaded = await loadScenario(await loadProject('w', ws), 'slow-teardown');
    const fingerprint = hookFingerprint(loaded.scenario.teardown![0], { phase: 'teardown', index: 0, env: 'local' });
    // Its setup's rollback DELETE needs one too.
    const armed = hookFingerprint(loaded.scenario.setup![1], { phase: 'setup', index: 1, env: 'local' });
    const job = await queue.enqueue({
      version: 1,
      kind: 'run',
      project: 'w',
      scenario: 'slow-teardown',
      scenario_sha256: sha256Hex(await readFile(file)),
      mode: 'capture',
      run_id: runId,
      submitted_by: 'test',
      approvals: [fingerprint, armed].map((f) => ({ fingerprint: f, by: 'test' as const, at: new Date().toISOString() })),
    });
    const sleeping = () => spawnSync('pgrep', ['-f', sleepCmd]).status === 0;
    const w = startWorker(ws, '--idle-exit', '5000');
    await waitFor('the wait step', waiting(job.id));
    w.child.kill('SIGTERM');
    await waitFor('the teardown shell hook', async () => sleeping(), 15_000);
    const t0 = Date.now();
    w.child.kill('SIGTERM');
    expect(await w.exited).toBe(130);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await waitFor('the hook to be killed', async () => !sleeping(), 5_000);
    expect(w.err()).toContain('SIGTERM: stopping');
    // Its final state was never written: the pid is gone, readers derive `interrupted`.
    expect((await queue.get(job.id))?.state).toBe('interrupted');
  });

  it('trust mcp in the runner: `confirm: true` does not count without an approval of the hook', async () => {
    // Queued directly (bypassing the submit, which would ask a human): the worker runs it with no approval.
    const yaml = SHORT.replace('video: short', 'video: confirmed').replace(
      'scenes:',
      'setup:\n  - name: wipe\n    http: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}\n    confirm: true\nscenes:',
    );
    const file = join(ws, 'projects', 'w', 'scenarios', 'confirmed.yaml');
    await writeFile(file, yaml);
    const { id: runId } = await reserveRunId(join(ws, 'projects', 'w', 'runs'), 'confirmed');
    const job = await queue.enqueue({ version: 1, kind: 'run', project: 'w', scenario: 'confirmed', scenario_sha256: sha256Hex(await readFile(file)), mode: 'dry', hooks: 'run', run_id: runId, submitted_by: 'test' });
    const w = startWorker(ws, '--idle-exit', '500');
    const done = await waitFor('the job', finished(job.id));
    expect(done).toMatchObject({ state: 'succeeded', result: { status: 'failed' } });
    expect(done.result?.kind === 'run' && done.result.untrusted?.error_message).toContain('without a human approval');
    expect(await runRecord(runId)).toMatchObject({ status: 'failed', hooks: { setup: 'failed' } });
    expect(await w.exited).toBe(0);
  });

  it('approvals a submit did not sign are ignored: a job file written by hand runs no approved hook', async () => {
    const yaml = SHORT.replace('video: short', 'video: forged').replace('scenes:', 'setup:\n  - name: wipe\n    http: {method: DELETE, url: "{{console}}/api/quotes/auto-proposal"}\n    confirm: true\nscenes:');
    const file = join(ws, 'projects', 'w', 'scenarios', 'forged.yaml');
    await writeFile(file, yaml);
    const loaded = await loadScenario(await loadProject('w', ws), 'forged');
    const fingerprint = hookFingerprint(loaded.scenario.setup![0], { phase: 'setup', index: 0, env: 'local' });
    const { id: runId } = await reserveRunId(join(ws, 'projects', 'w', 'runs'), 'forged');
    const job = await queue.enqueue({
      version: 1, kind: 'run', project: 'w', scenario: 'forged', scenario_sha256: sha256Hex(await readFile(file)), mode: 'dry', hooks: 'run', run_id: runId, submitted_by: 'test',
      approvals: [{ fingerprint, by: 'test', at: new Date().toISOString() }],
    });
    // Signed by the enqueue; a forger without the key writes the same approval without (or with a wrong) signature.
    const jobFile = join(ws, '.demo-studio', 'jobs', job.id, 'job.json');
    const stored = JSON.parse(await readFile(jobFile, 'utf8')) as JobRecord;
    expect(stored.input.approvals?.[0].sig).toMatch(/^[0-9a-f]{64}$/);
    stored.input.approvals![0].sig = '0'.repeat(64);
    await writeFile(jobFile, JSON.stringify(stored));
    const w = startWorker(ws, '--idle-exit', '500');
    const done = await waitFor('the job', finished(job.id));
    expect(done).toMatchObject({ state: 'succeeded', result: { status: 'failed' } });
    expect(done.result?.kind === 'run' && done.result.untrusted?.error_message).toContain('without a human approval');
    expect((await queue.events(job.id)).some((e) => e.type === 'log' && /1 approval\(s\) of this job are not signed/.test(e.message))).toBe(true);
    expect(await w.exited).toBe(0);
  });

  it('a job of a kind or input version it does not know is refused without running (a newer client)', async () => {
    const ids = [] as string[];
    for (const input of [{ version: 1, kind: 'comments_sync', project: 'w', submitted_by: 'mcp' }, { version: 2, kind: 'run', project: 'w', submitted_by: 'mcp' }]) {
      const rec = await queue.enqueue({ version: 1, kind: 'hooks', project: 'w', source: 'reset', dry: true, journal_id: 'x', submitted_by: 'test' });
      const jobFile = join(ws, '.demo-studio', 'jobs', rec.id, 'job.json');
      await writeFile(jobFile, JSON.stringify({ ...rec, kind: input.kind, input }));
      ids.push(rec.id);
    }
    const w = startWorker(ws, '--idle-exit', '500');
    expect(await w.exited).toBe(0);
    const [unknown, v2] = await Promise.all(ids.map((id) => queue.get(id)));
    expect(unknown).toMatchObject({ state: 'failed', error: { code: 'invalid' } });
    expect(unknown?.error?.message).toContain('does not know job kind "comments_sync"');
    expect(v2?.error?.message).toContain('does not know job input version 2');
    expect(unknown?.started_at).toBeUndefined();
  });

  it('exits when its workspace disappears', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'studio-worker-gone-'));
    await writeFile(join(tmp, 'studio.yaml'), 'projects_dir: projects\n');
    await mkdir(join(tmp, '.demo-studio', 'jobs'), { recursive: true });
    const w = startWorker(tmp, '--idle-exit', '60000');
    await waitFor('the worker to serve', async () => w.err().includes('serving'), 15_000);
    await rm(tmp, { recursive: true, force: true });
    const t0 = Date.now();
    expect(await w.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(w.err()).toContain('the workspace is gone');
  });
});
