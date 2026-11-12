/**
 * L5.14a captures first, with the real worker (in this process, as the Studio's tests run it) and a real render in a job
 * process of its own (synthetic capture, no fixture product): a render does not start while a take films (a filming
 * marker, as a take of another workspace or a terminal writes it) and starts within a poll once it ends; the job process
 * runs the worker's build (critique H1: no refusal, no hand-over, no second worker); a take starting mid-render puts
 * every process of the render's tree — its detached browser included — at background priority and back after it (the
 * frames are those of an unheld render); a cancel while held ends the job in its own process (clean-ups ran), not by a
 * kill. A job process refuses another build (exit 3, nothing written) and anything but the heavy job its worker claimed.
 * Needs ffmpeg and a headless shell. L5.14a fixes (review B H1): every wait is for the state itself (yield.json gone, not
 * read between the release and its removal), and a worker a failed test left is stopped before the next test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, FilmingMarker, JOB_EXIT, createEngine, recordDigest, runJobChild, runWorker, selfIdentity, treeOf, workersDir } from '../src/index.js';
import type { Engine, JobRecord, ProcessIdentity, RecordedBrowser } from '../src/index.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { TEMPLATES, hasTool, linkSharedCache, makeColourCapture, syntheticRunRecord } from '../../editor/test/render-helpers.js';

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 400_000;
const RUN = '20260101-120000-held';

let root: string;
let engine: Engine;
let queue: FileJobQueue;
let me: ProcessIdentity;
const savedHome = process.env.RETAKE_HOME;
const logs: string[] = [];

/** Pending in-process workers, and the SIGTERM listeners present before any (a worker's own is told apart). */
const pending = new Set<Promise<number>>();
const baseline = process.listeners('SIGTERM');

/** The worker in this process until idle (its job process is a real one). */
const work = (extra: Partial<Parameters<typeof runWorker>[0]> = {}) => {
  const p = runWorker({ root, idleExitMs: 400, pollMs: 50, log: (m) => logs.push(m), ...extra });
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
};

/** Markers a test opened (closed after it, whatever happened). */
const takes: Array<{ closeSync(): void }> = [];
const film = (o: Parameters<typeof FilmingMarker.open>[0]) => {
  const m = FilmingMarker.open(o)!;
  takes.push(m);
  return m;
};

afterEach(async () => {
  for (const t of takes.splice(0)) t.closeSync();
  if (!pending.size) return;
  // A worker a failed test left (it would hold the lock for the next test): a first signal — its job is cancelled, its
  // clean-ups run — then wait for it.
  for (const l of process.listeners('SIGTERM')) if (!baseline.includes(l)) (l as (s: string) => void)('SIGTERM');
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 120_000))]);
}, LONG);

async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** pid → `ps -o pri` of every process of a job process's tree (its group and descendants). */
function priorities(pid: number): Map<number, number> {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,pri='], { encoding: 'utf8' }).stdout;
  const rows = out
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 4);
  const tree = new Set(
    treeOf(
      rows.map(([p, pp, g]) => ({ pid: p!, ppid: pp!, pgid: g!, start: null })),
      pid,
      { group: true },
    ).map((p) => p.pid),
  );
  return new Map(rows.filter(([p]) => tree.has(p!)).map(([p, , , pri]) => [p!, pri!]));
}

function framemd5(file: string): string[] {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 64e6 }).stdout;
  return out
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop()!.trim());
}

beforeAll(async () => {
  if (!canRender) return;
  root = await mkdtemp(join(tmpdir(), 'retake-worker-captures-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const dir = join(root, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 10,
    entries: [
      { id: 'a', t_start: 0.5, t_end: 5.0, caption: { text: 'A long first scene.' } },
      { id: 'b', t_start: 5.0, t_end: 10.0, open_end: 5.1 },
    ],
    video: { title: { text: 'Synthetic' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = RUN;
  t.project = 'demo';
  t.scenario = 'held';
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  // A run `latest` takes has its record (L7.6a: a folder without a readable run.json is never the latest capture).
  await writeFile(join(runDir, 'run.json'), JSON.stringify(syntheticRunRecord(runDir, { id: RUN, scenario: 'held', project: 'demo' })));
  makeColourCapture(join(runDir, 'capture.mp4'), 10);
  await linkSharedCache(root);
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
  queue = new FileJobQueue(root);
  me = await selfIdentity();
}, LONG);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (root) await rm(root, { recursive: true, force: true });
});

let unheld: string[] = [];

describe.skipIf(!canRender)('captures first with a real render job (L5.14a)', () => {
  it(
    "a render waits while a take films, then runs in a job process of the worker's build (no refusal, no hand-over)",
    async () => {
      const take = film({ root, source: 'cli', owner: me });
      const sub = await engine.renders.submit({ project: 'demo', scenario: 'held', overrides: { scale: 0.5 } });
      logs.length = 0;
      const worker = work();
      // The worker serves (and polls every 50 ms) well before the take ends.
      await waitFor('the worker serving', async () => logs.some((l) => l.startsWith('serving ')));
      await new Promise((r) => setTimeout(r, 1_500));
      expect((await queue.stored(sub.job.id))?.state).toBe('queued');
      expect(await queue.claimOf(sub.job.id)).toBeUndefined();
      const ended = Date.now();
      take.closeSync();
      const running = await waitFor('the render running', async () => {
        const j = await queue.get(sub.job.id);
        return j?.state === 'running' ? j : undefined;
      });
      expect(Date.parse(running.started_at!) - ended).toBeLessThan(5_000);
      // Its own process: the job's worker is the job process, the claiming worker its supervisor.
      expect(running.worker?.pid).not.toBe(process.pid);
      expect(running.supervisor?.pid).toBe(process.pid);
      expect(await worker).toBe(0);
      const job = (await engine.jobs.get(sub.job.id)) as JobRecord;
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      const log = await readFile(join(workersDir(root), 'worker.log'), 'utf8').catch(() => '');
      expect(log).not.toMatch(/not the worker's|refused/);
      expect(logs.join('\n')).not.toMatch(/handing over|another build/);
      const result = job.result as { kind: 'render'; file: string };
      unheld = framemd5(result.file);
      expect(unheld.length).toBeGreaterThan(100);
    },
    LONG,
  );

  it.skipIf(process.platform !== 'darwin')(
    'a take starting mid-render: the whole tree (its browser too) at background priority, back after; identical frames',
    async () => {
      const sub = await engine.renders.submit({ project: 'demo', scenario: 'held', overrides: { scale: 0.5 } });
      const worker = work();
      const running = await waitFor('the render rendering, its browser recorded', async () => {
        const j = await queue.get(sub.job.id);
        return j?.state === 'running' && j.progress?.phase === 'rendering' && existsSync(queue.files.browser(sub.job.id)) ? j : undefined;
      });
      const child = running.worker!.pid;
      const browser = JSON.parse(await readFile(queue.files.browser(sub.job.id), 'utf8')) as RecordedBrowser;
      const before = priorities(child);
      expect(before.has(browser.pid)).toBe(true);
      const take = film({ root, source: 'job', owner: me });
      const held = await waitFor(
        'every process at background priority',
        async () => {
          const p = priorities(child);
          return p.size > 0 && [...p.values()].every((x) => x === 4) ? p : undefined;
        },
        10_000,
      );
      expect(held.has(browser.pid)).toBe(true);
      expect(JSON.parse(await readFile(queue.files.yield(sub.job.id), 'utf8'))).toMatchObject({ v: 1, state: 'background', cause: 'here' });
      await new Promise((r) => setTimeout(r, 2_000));
      take.closeSync();
      await waitFor(
        'normal priority again',
        async () => {
          const p = priorities(child);
          return p.size === 0 || [...p.values()].every((x) => x !== 4);
        },
        10_000,
      );
      // yield.json goes as the hold ends (the worker removes it first, then releases): waited for, never read in between.
      await waitFor('yield.json removed', async () => !existsSync(queue.files.yield(sub.job.id)), 10_000);
      expect(await worker).toBe(0);
      const job = (await engine.jobs.get(sub.job.id)) as JobRecord;
      expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
      expect(framemd5((job.result as { file: string }).file)).toEqual(unheld);
    },
    LONG,
  );

  it(
    'a cancel while held: the job process ends it itself (cancelled, nothing left under the render id), no kill',
    async () => {
      const sub = await engine.renders.submit({ project: 'demo', scenario: 'held', overrides: { scale: 0.5 } });
      const worker = work({ cancelGraceMs: 60_000 });
      await waitFor('the render rendering', async () => {
        const j = await queue.get(sub.job.id);
        return j?.state === 'running' && j.progress?.phase === 'rendering';
      });
      const take = film({ root, source: 'job', owner: me });
      await waitFor('held', async () => existsSync(queue.files.yield(sub.job.id)), 10_000);
      await engine.jobs.cancel(sub.job.id);
      expect(await worker).toBe(0);
      take.closeSync();
      const job = (await engine.jobs.get(sub.job.id)) as JobRecord;
      expect(job.state).toBe('cancelled');
      expect(job.error?.message).not.toMatch(/was killed/);
      expect(logs.join('\n')).not.toMatch(/killing its job process/);
      const renders = await readdir(join(root, 'projects', 'demo', 'renders'));
      expect(renders.filter((f) => f.startsWith(sub.render_id) || f.startsWith(`.${sub.render_id}`))).toEqual([]);
      expect(existsSync(queue.files.yield(sub.job.id))).toBe(false);
    },
    LONG,
  );
});

describe('a job process (L5.14a)', () => {
  let ws: string;
  beforeAll(async () => {
    ws = await mkdtemp(join(tmpdir(), 'retake-job-process-'));
    await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  });
  afterAll(async () => {
    if (ws) await rm(ws, { recursive: true, force: true });
  });

  it("refuses another build than its worker's (exit 3) and writes nothing", async () => {
    const q = new FileJobQueue(ws);
    const rec = await q.enqueue({ version: 1, kind: 'review', project: 'demo', render_id: 'held-v1', fps: 1, submitted_by: 'test' } as never);
    expect(await q.claim(rec.id, me)).toBe(true);
    const log: string[] = [];
    expect(await runJobChild({ root: ws, id: rec.id, kind: 'review', build: 'not-this-one', supervisor: process.pid, digest: recordDigest(rec), log: (m) => log.push(m) })).toBe(JOB_EXIT.buildChanged);
    expect(await q.stored(rec.id)).toMatchObject({ state: 'queued' });
    expect(await q.events(rec.id)).toEqual([]);
  });

  it('refuses anything but the queued heavy job of that kind its worker claimed (exit 4): never a take', async () => {
    const { buildStamp } = await import('../src/index.js');
    const build = buildStamp();
    const q = new FileJobQueue(ws);
    const take = await q.enqueue({
      version: 1,
      kind: 'run',
      project: 'demo',
      scenario: 's',
      scenario_sha256: 'a'.repeat(64),
      run_id: '20260101-120000-s',
      mode: 'capture',
      submitted_by: 'test',
    } as never);
    await q.claim(take.id, me);
    const quiet = { log: () => undefined };
    expect(await runJobChild({ root: ws, id: take.id, kind: 'run', build, supervisor: process.pid, digest: recordDigest(take), ...quiet })).toBe(JOB_EXIT.refused);
    const review = await q.enqueue({ version: 1, kind: 'review', project: 'demo', render_id: 'held-v1', fps: 1, submitted_by: 'test' } as never);
    // Not claimed by that worker, or another kind than the one asked.
    const digest = recordDigest(review);
    expect(await runJobChild({ root: ws, id: review.id, kind: 'review', build, supervisor: process.pid, digest, ...quiet })).toBe(JOB_EXIT.refused);
    await q.claim(review.id, me);
    expect(await runJobChild({ root: ws, id: review.id, kind: 'render', build, supervisor: process.pid, digest, ...quiet })).toBe(JOB_EXIT.refused);
    expect(await runJobChild({ root: ws, id: review.id, kind: 'review', build, supervisor: 999_999, digest, ...quiet })).toBe(JOB_EXIT.refused);
    // Review A L6: job.json rewritten after the claim (another record under that id): not the record its worker claimed.
    const claimed = (await q.stored(review.id))!;
    await q.write({ ...claimed, input: { ...(claimed.input as object), render_id: 'other-v1' } as never });
    expect(await runJobChild({ root: ws, id: review.id, kind: 'review', build, supervisor: process.pid, digest, ...quiet })).toBe(JOB_EXIT.refused);
    expect((await q.stored(take.id))?.state).toBe('queued');
    expect((await q.stored(review.id))?.state).toBe('queued');
  });
});
