/**
 * L4.4: a `run` job watched and paused through the worker (in-process, real Chromium, the fixture product on free ports).
 * The worker opens the job's live channel (live.json) and polls its `pause` marker with the cancel marker: engine
 * runs.pause asks, the dry run pauses before its next step (run.json and the job's progress say so), resumes, records
 * the pause; a cancel while paused still runs the teardown; RETAKE_PAUSE_MAX_MIN stops a long pause. Live frames
 * reach a reader of the channel and are never written anywhere (B6: every file of the run, the workspace state, the
 * Retake home and the worker's temporary folder scanned for the frames' bytes). runs.pause refuses a run of the CLI, a
 * queued or a finished run, writing no marker — a capture is no exception since part D (it does not film the pause).
 * Skipped without Chromium.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunRecord } from '@retake/core';
import { FileJobQueue, createEngine, openLiveFeed, readLiveChannel, runWorker } from '../src/index.js';
import type { Engine, EngineError, JobRecord, LiveFeedFrame } from '../src/index.js';
import { REPO } from './helpers.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { MemoryHookRunner } from '../src/hook-run/memory-hooks.js';

function chromiumAvailable(): boolean {
  if (process.env.RETAKE_CHROMIUM) return existsSync(process.env.RETAKE_CHROMIUM);
  try {
    const require = createRequire(join(REPO, 'packages/runner-web/package.json'));
    const { chromium } = require('playwright-core') as { chromium: { executablePath(): string } };
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

/** Four short steps on the console's imports page. */
const STEPS = `video: steps
pacing: {scene_start_still: 0.2}
scenes:
  - id: imports
    page: console
    open: /imports
    steps:
      - hold: 0.3
      - hold: 0.3
      - hold: 0.3
      - hold: 0.3
`;

/** The same with a teardown (it must still run after a cancel while paused). */
const TORN = `video: torn
teardown:
  - name: reset
    http: {method: POST, url: "{{console}}/api/reset"}
pacing: {scene_start_still: 0.2}
scenes:
  - id: imports
    page: console
    open: /imports
    steps:
      - hold: 0.3
      - hold: 0.3
`;

const YES = { approve: async () => ({ approved: true as const }) };
const saved = { home: process.env.RETAKE_HOME, tmp: process.env.TMPDIR, max: process.env.RETAKE_PAUSE_MAX_MIN };
let fixture: Fixture;
let ws: string;
let scratch: string;
let engine: Engine;
let queue: FileJobQueue;

const work = () => runWorker({ root: ws, idleExitMs: 300, pollMs: 50, log: () => undefined });

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  expect(e, 'expected a refusal').not.toBeNull();
  return e!;
}

const runJson = async (runId: string) => JSON.parse(await readFile(join(ws, 'projects', 'w', 'runs', runId, 'run.json'), 'utf8')) as RunRecord;
const running = (id: string) => async () => ((await queue.get(id))?.state === 'running' ? true : undefined);
const finished = (id: string) => async () => {
  const j = await queue.get(id);
  return j && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : undefined;
};

/** Every regular file under `dir` (links not followed). */
async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

describe.skipIf(!chromiumAvailable())('a run job watched and paused through the worker', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    ws = await mkdtemp(join(tmpdir(), 'ds-live-pause-'));
    process.env.RETAKE_HOME = join(ws, '.home');
    // The worker's temporary folder (Chromium's profiles, the runner's copies): scanned for frames afterwards.
    scratch = join(ws, '.tmp');
    await mkdir(scratch, { recursive: true });
    process.env.TMPDIR = scratch;
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'w');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(
      join(project, 'project.yaml'),
      ['name: W', 'environments:', '  local:', `    console: ${fixture.urls.console}`, `    shop: ${fixture.urls.shop}`, 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', ''].join('\n'),
    );
    await writeFile(join(project, 'scenarios', 'steps.yaml'), STEPS);
    await writeFile(join(project, 'scenarios', 'torn.yaml'), TORN);
    engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    queue = new FileJobQueue(ws);
  });

  afterAll(async () => {
    for (const [k, v] of [['RETAKE_HOME', saved.home], ['TMPDIR', saved.tmp], ['RETAKE_PAUSE_MAX_MIN', saved.max]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fixture?.close();
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('pause → paused before the next step (run.json, job progress), resume → every step ran; live frames reach a reader and are written nowhere (B6)', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'steps', mode: 'dry' });
    const worker = work();
    await waitFor('running', running(sub.job.id));
    const asked = await engine.runs.pause('w', sub.run_id, true);
    expect(asked.job?.pause_requested_at).toEqual(expect.any(String));
    // The live channel: a reader of live.json connects and collects frames until the run ends.
    const info = await waitFor('live.json', () => readLiveChannel(queue, queue.files, sub.job.id).then((i) => i ?? undefined));
    const frames: LiveFeedFrame[] = [];
    const feed = openLiveFeed(info, { onFrame: (f) => frames.push(f) });
    const paused = await waitFor('paused', async () => {
      const s = await engine.runs.status('w', sub.run_id);
      return s.paused ? s : undefined;
    });
    expect(paused.paused).toMatchObject({ scene: 'imports', step: 0 });
    const job = await waitFor('job progress paused', async () => {
      const j = await queue.get(sub.job.id);
      return j?.progress?.paused ? j : undefined;
    });
    expect(job.progress?.paused).toMatchObject({ scene: 'imports', step: 0 });
    await new Promise((r) => setTimeout(r, 1000));
    // Nothing moved meanwhile.
    expect((await runJson(sub.run_id)).steps_done).toBe(0);
    const resumed = await engine.runs.pause('w', sub.run_id, false);
    expect(resumed.job?.pause_requested_at).toBeUndefined();
    const done = (await waitFor('the job', finished(sub.job.id))) as JobRecord;
    await worker;
    await feed;
    expect(done.state, JSON.stringify(done.error)).toBe('succeeded');
    expect(done.result).toMatchObject({ kind: 'run', status: 'succeeded', steps_done: 4 });
    expect(done.progress?.paused).toBeUndefined();
    const rec = await runJson(sub.run_id);
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses).toHaveLength(1);
    expect(rec.pauses![0]).toMatchObject({ scene: 'imports', step: 0 });
    expect(rec.pauses![0].ms).toBeGreaterThanOrEqual(900);
    const status = await engine.runs.status('w', sub.run_id);
    expect(status.paused).toBeUndefined();
    expect(status.pauses).toEqual(rec.pauses);
    expect(existsSync(queue.files.live(sub.job.id))).toBe(false);
    const events = (await queue.events(sub.job.id)).flatMap((e) => (e.type === 'run' ? [e.event] : []));
    expect(events.filter((e) => e.type === 'pause').map((e) => (e as { state: string }).state)).toEqual(['paused', 'resumed']);
    // The outline comes once the run's secrets are known, before any step (review A).
    const outlineAt = events.findIndex((e) => e.type === 'outline');
    expect(outlineAt).toBeGreaterThan(0);
    expect(events.findIndex((e) => e.type === 'step_start')).toBeGreaterThan(outlineAt);
    expect((events.find((e) => e.type === 'pause' && e.state === 'paused') as { max_ms?: number } | undefined)?.max_ms).toBe(30 * 60_000);

    // B6: frames came, and not one of them is in any file the run, the workspace, the Retake home or the worker's
    // temporary folder holds — as a file, inside a file, or in base64.
    expect(frames.length).toBeGreaterThan(0);
    const hashes = new Set(frames.map((f) => createHash('sha256').update(f.data).digest('hex')));
    const probes = frames.map((f) => f.data.subarray(16, 16 + 1024));
    const probes64 = frames.map((f) => f.data.subarray(15, 15 + 768).toString('base64'));
    const all = [...(await files(join(ws, 'projects', 'w', 'runs', sub.run_id))), ...(await files(join(ws, '.retake'))), ...(await files(join(ws, '.home'))), ...(await files(scratch))];
    expect(all.length).toBeGreaterThan(3);
    const found: string[] = [];
    for (const file of all) {
      const st = await lstat(file).catch(() => null);
      if (!st || st.size > 64 * 1024 * 1024) continue;
      const bytes = await readFile(file).catch(() => null);
      if (!bytes) continue;
      if (hashes.has(createHash('sha256').update(bytes).digest('hex'))) found.push(`${file} (a frame)`);
      else if (probes.some((p) => bytes.includes(p))) found.push(`${file} (frame bytes)`);
      else if (probes64.some((p) => bytes.includes(p))) found.push(`${file} (frame base64)`);
    }
    expect(found).toEqual([]);
  });

});

/**
 * L7.34 (U9): the same engine without a browser — the worker drives its run through the in-memory capture runner (its
 * pause gate is the runner's: a pause asked is seen before the next step, RETAKE_PAUSE_MAX_MIN reaches it as the
 * request's limit) and the in-memory hook runner, whose setup hook holds the first step back a moment (as a real
 * browser's start does) so that the pause lands before step 0. What the engine does around it — the pause marker, the
 * job's progress, the cancel, the refusals — is the product's. The real run (Chromium, the live frames) is the case
 * above.
 */
describe('a run job paused through the worker, on the in-memory runner', () => {
  const warm = 'setup:\n  - name: warm\n    http: {url: "{{console}}/health"}\n';
  const work = () =>
    runWorker({ root: ws, idleExitMs: 300, pollMs: 50, log: () => undefined, ports: { capture: new MemoryCaptureRunner(), hooks: new MemoryHookRunner({ onExecute: async (e) => void (e.phase === 'setup' && (await new Promise((r) => setTimeout(r, 1000)))) }) } });

  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ds-live-pause-memory-'));
    process.env.RETAKE_HOME = join(ws, '.home');
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(ws, 'projects', 'w');
    await mkdir(join(project, 'scenarios'), { recursive: true });
    await writeFile(join(project, 'project.yaml'), ['name: W', 'environments:', '  local:', '    console: http://console.test', '    shop: http://shop.test', 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', ''].join('\n'));
    await writeFile(join(project, 'scenarios', 'steps.yaml'), warm + STEPS);
    await writeFile(join(project, 'scenarios', 'torn.yaml'), warm + TORN);
    engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    queue = new FileJobQueue(ws);
  });

  afterAll(async () => {
    if (saved.home === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = saved.home;
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it('a cancel while paused: the run stops at once, its teardown runs; job and run cancelled, no `paused` left', async () => {
    const sub = await engine.runs.submit({ project: 'w', scenario: 'torn', mode: 'dry', hooks: 'run' }, { approver: YES });
    const worker = work();
    await waitFor('running', running(sub.job.id));
    await engine.runs.pause('w', sub.run_id, true);
    await waitFor('paused', async () => ((await engine.runs.status('w', sub.run_id)).paused ? true : undefined));
    // Stopping: a pause is not asked of a run being stopped.
    await engine.runs.cancel('w', sub.run_id);
    expect((await refusal(engine.runs.pause('w', sub.run_id, true))).code).toMatch(/conflict/);
    const done = (await waitFor('the cancel', finished(sub.job.id), 20_000)) as JobRecord;
    await worker;
    expect(done).toMatchObject({ state: 'cancelled', result: { status: 'cancelled' } });
    const rec = await runJson(sub.run_id);
    expect(rec).toMatchObject({ status: 'cancelled', hooks: { teardown: 'ok' } });
    expect(rec.paused).toBeUndefined();
    expect(rec.pauses).toHaveLength(1);
  });

  it('RETAKE_PAUSE_MAX_MIN: a pause longer than it stops the run with the reason', async () => {
    process.env.RETAKE_PAUSE_MAX_MIN = '0.02';
    try {
      const sub = await engine.runs.submit({ project: 'w', scenario: 'steps', mode: 'dry', hooks: 'run' }, { approver: YES });
      const worker = work();
      await waitFor('running', running(sub.job.id));
      await engine.runs.pause('w', sub.run_id, true);
      const done = (await waitFor('the stop', finished(sub.job.id), 30_000)) as JobRecord;
      await worker;
      expect(done.state).toBe('cancelled');
      expect(done.error?.message).toMatch(/^paused longer than 1\.2 s before step imports\.0/);
      expect((await runJson(sub.run_id)).status).toBe('cancelled');
    } finally {
      delete process.env.RETAKE_PAUSE_MAX_MIN;
    }
  });

  it('runs.pause refuses a terminal run, a queued or a finished run — and writes no marker; a capture is no exception (part D)', async () => {
    // A run of the CLI (no job).
    const cli = join(ws, 'projects', 'w', 'runs', '20261026-100000-steps');
    await mkdir(cli, { recursive: true });
    await writeFile(
      join(cli, 'run.json'),
      JSON.stringify({ id: '20261026-100000-steps', project: 'w', scenario: 'steps', mode: 'dry', status: 'running', started_at: new Date().toISOString(), dir: cli, env: 'local', options: { hooks: 'skip', headed: false }, steps_total: 4, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] }),
    );
    const e1 = await refusal(engine.runs.pause('w', '20261026-100000-steps', true));
    expect(e1.code).toBe('refused');
    expect(e1.message).toContain('retake run');
    expect((await refusal(engine.runs.pause('w', 'nope', true))).code).toBe('not_found');
    // A queued dry run: not yet.
    const queued = await engine.runs.submit({ project: 'w', scenario: 'steps', mode: 'dry' });
    const e2 = await refusal(engine.runs.pause('w', queued.run_id, true));
    expect(e2.code).toBe('conflict');
    expect(e2.message).toContain('has not started yet');
    expect(await queue.pauseOf(queued.job.id)).toBeUndefined();
    // A capture pauses like a dry run (it does not film the pause): queued, it is not refused for being a capture.
    const capture = await engine.runs.submit({ project: 'w', scenario: 'steps', mode: 'capture' });
    const e3 = await refusal(engine.runs.pause('w', capture.run_id, true));
    expect(e3.code).toBe('conflict');
    expect(e3.message).toContain('has not started yet');
    expect(await queue.pauseOf(capture.job.id)).toBeUndefined();
    // A finished run: nothing to pause; resuming it is harmless.
    await engine.runs.cancel('w', queued.run_id);
    await engine.runs.cancel('w', capture.run_id);
    const e4 = await refusal(engine.runs.pause('w', queued.run_id, true));
    expect(e4.code).toBe('conflict');
    expect(await queue.pauseOf(queued.job.id)).toBeUndefined();
    expect((await engine.runs.pause('w', queued.run_id, false)).job?.state).toBe('cancelled');
  });
});
