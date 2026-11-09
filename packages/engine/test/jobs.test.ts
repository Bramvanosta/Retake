/**
 * The job queue and the submit side of `run` jobs, without a browser: the input contract, one writer per file, the
 * cancel marker, states derived when reading (interrupted, cancelled before it started), the worker lock, run id
 * reservation and the hooks a human must approve.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_ID_RE, RunRecordSchema } from '@retake/core';
import { reserveRunId } from '@retake/core/io';
import type { RunJobInput } from '@retake/core';
import {
  EngineError,
  FileJobQueue,
  RunOptionError,
  SandboxTakeError,
  WorkerLock,
  createEngine,
  executeRunJob,
  liveWorker,
  newJobId,
  openProjectBySlug,
  openWorkspace,
  prepareInspect,
  prepareRun,
  readWorkerLock,
  runCommandLine,
  sha256Hex,
  signalInterrupts,
  toEngineError,
} from '../src/index.js';
import type { Engine, JobRecord } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

let ws: string;
let engine: Engine;
const savedHome = process.env.RETAKE_HOME;

const INPUT: RunJobInput = {
  version: 1,
  kind: 'run',
  project: 'northfield-fixture',
  scenario: 'quote',
  scenario_sha256: 'a'.repeat(64),
  mode: 'dry',
  run_id: '20261017-130000-quote',
  submitted_by: 'test',
};

/** A pid that existed and is gone now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid!;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-jobs-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

describe('job ids', () => {
  it('are "j_" + a ULID, sortable in creation order', () => {
    const ids = Array.from({ length: 50 }, () => newJobId());
    for (const id of ids) expect(id).toMatch(JOB_ID_RE);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(newJobId(Date.UTC(2026, 9, 17)) < newJobId(Date.UTC(2026, 9, 18))).toBe(true);
  });
});

describe('FileJobQueue', () => {
  it('validates the input contract: slugs, names and refs, never paths or unknown keys', async () => {
    const q = new FileJobQueue(join(ws, 'q-contract'));
    for (const bad of [
      { ...INPUT, project: '/etc' },
      { ...INPUT, project: '../x' },
      { ...INPUT, scenario: 'scenarios/quote.yaml' },
      { ...INPUT, run_id: '../../x' },
      { ...INPUT, env: 'a/b' },
      { ...INPUT, scenario_sha256: 'nope' },
      { ...INPUT, version: 2 },
      { ...INPUT, kind: 'record' },
      { ...INPUT, allow_writes: true },
      { ...INPUT, secret: 'hunter2' },
    ]) {
      await expect(q.enqueue(bad as RunJobInput), JSON.stringify(bad)).rejects.toThrow(EngineError);
    }
    expect(await q.ids()).toEqual([]);
    const rec = await q.enqueue(INPUT);
    expect(rec).toMatchObject({ version: 1, kind: 'run', state: 'queued', input: INPUT });
    // A JSON round trip changes nothing.
    expect(JSON.parse(JSON.stringify(await q.get(rec.id)))).toEqual(rec);
  });

  it('lists newest first; a cancel before the claim derives `cancelled`, written by nobody but the next worker', async () => {
    const q = new FileJobQueue(join(ws, 'q-cancel'));
    const a = await q.enqueue(INPUT);
    const b = await q.enqueue({ ...INPUT, run_id: '20261017-130001-quote' });
    expect((await q.list()).map((j) => j.id)).toEqual([b.id, a.id]);
    expect(await q.position(b.id)).toEqual({ ahead: 1 });
    const c = await q.cancel(a.id, 'test');
    expect(c).toMatchObject({ state: 'cancelled', derived: true, error: { code: 'cancelled', message: 'cancelled before it started' } });
    expect(c.cancel_requested_at).toBeTypeOf('string');
    // The reader wrote nothing: job.json still says queued.
    expect((await q.stored(a.id))?.state).toBe('queued');
    expect(await q.position(b.id)).toEqual({ ahead: 0 });
    // Asking twice keeps the first time; the list filter sees the derived state.
    expect((await q.cancel(a.id, 'test')).cancel_requested_at).toBe(c.cancel_requested_at);
    expect((await q.list({ states: ['cancelled'] })).map((j) => j.id)).toEqual([a.id]);
  });

  it('L5.14a fixes (review B M4): position per lane (captures before heavy jobs); a heavy job a take holds says held_by "take", never "next"', async () => {
    const { FilmingMarker, selfIdentity } = await import('../src/index.js');
    const root = join(ws, 'q-lanes');
    const q = new FileJobQueue(root);
    const review = (n: number) => q.enqueue({ version: 1, kind: 'review', project: 'northfield-fixture', render_id: `quote-v${n}`, fps: 1, submitted_by: 'test' } as never);
    const r1 = await review(1);
    const dry = await q.enqueue({ ...INPUT, run_id: '20261017-140000-quote' });
    const r2 = await review(2);
    // Lanes: the dry run (a capture, newer than r1) is not ahead of r2; r1 is.
    expect(await q.position(r2.id)).toEqual({ ahead: 1 });
    expect(await q.position(dry.id)).toEqual({ ahead: 0 });
    expect(await q.position(r1.id)).toEqual({ ahead: 0 });
    // A filming take of this workspace waits in the queue: every heavy job is held by it, whatever its place.
    const take = await q.enqueue({ ...INPUT, mode: 'capture', run_id: '20261017-140001-quote' });
    expect(await q.position(r1.id)).toEqual({ ahead: 0, held_by: 'take' });
    expect(await q.position(r2.id)).toEqual({ ahead: 1, held_by: 'take' });
    expect(await q.position(dry.id)).toEqual({ ahead: 0 });
    // Cancelled, it holds nothing.
    await q.cancel(take.id, 'test');
    expect(await q.position(r1.id)).toEqual({ ahead: 0 });
    // A take filming on this Mac (a marker of another workspace, or a terminal) holds them too.
    const m = FilmingMarker.open({ root: join(ws, 'elsewhere'), source: 'cli', owner: await selfIdentity() })!;
    try {
      expect(await q.position(r1.id)).toEqual({ ahead: 0, held_by: 'take' });
      expect(await q.position(dry.id)).toEqual({ ahead: 0 });
    } finally {
      m.closeSync();
    }
    expect(await q.position(r1.id)).toEqual({ ahead: 0 });
  });

  it('L5.14a fixes: a running job whose recorded worker pid is 0, 1 or -1 is derived interrupted (never a live worker)', async () => {
    const q = new FileJobQueue(join(ws, 'q-badpid'));
    for (const pid of [0, 1, -1]) {
      const rec = await q.enqueue({ ...INPUT, run_id: `20261017-16000${pid + 1}-quote` });
      await q.write({ ...rec, state: 'running', started_at: new Date().toISOString(), worker: { pid, host: 'here' } });
      expect((await q.get(rec.id))?.state, String(pid)).toBe('interrupted');
    }
  });

  it('claims are exclusive (O_EXCL), also when many race for one job', async () => {
    const q = new FileJobQueue(join(ws, 'q-claim'));
    const job = await q.enqueue(INPUT);
    const wins = await Promise.all(Array.from({ length: 8 }, (_, i) => q.claim(job.id, { pid: process.pid + i })));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await q.claim(job.id, { pid: process.pid })).toBe(false);
  });

  it('derives `interrupted` when the worker of a running job is gone, or its pid is another program now', async () => {
    const q = new FileJobQueue(join(ws, 'q-int'), 'retake -C /ws');
    const job = await q.enqueue({ ...INPUT, env: 'local' });
    const running: JobRecord = { ...job, state: 'running', started_at: new Date().toISOString(), worker: { pid: deadPid(), host: 'h' } };
    await q.write(running);
    const got = await q.get(job.id);
    expect(got).toMatchObject({ state: 'interrupted', derived: true, error: { fix: 'retake -C /ws env reset northfield-fixture --env local' } });
    expect(got?.error?.message).toContain('stopped while the job ran');
    expect((await q.stored(job.id))?.state).toBe('running');
    // A live pid with another start time: reused by another program.
    await q.write({ ...running, worker: { pid: process.ppid, started_at: '2001-01-01T00:00:00.000Z', host: 'h' } });
    expect((await q.get(job.id))?.state).toBe('interrupted');
    // A live worker: running.
    const { selfIdentity } = await import('../src/index.js');
    await q.write({ ...running, worker: { ...(await selfIdentity()), host: 'h' } });
    expect((await q.get(job.id))?.state).toBe('running');
    // Claimed while queued by a worker that died before starting it.
    const other = await q.enqueue(INPUT);
    await q.claim(other.id, { pid: deadPid() });
    expect((await q.get(other.id))?.state).toBe('interrupted');
  });

  it('events: appended with increasing seq, read after a seq', async () => {
    const q = new FileJobQueue(join(ws, 'q-events'));
    const job = await q.enqueue(INPUT);
    let seq = await q.append(job.id, 0, [{ type: 'state', state: 'running' }, { type: 'log', level: 'info', message: 'one' }]);
    seq = await q.append(job.id, seq, [{ type: 'log', level: 'warn', message: 'two' }]);
    expect(seq).toBe(3);
    const all = await q.events(job.id);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await q.events(job.id, { after: 2 })).map((e) => e.type === 'log' && e.message)).toEqual(['two']);
  });
});

describe('the worker lock', () => {
  it('one holder; a stale lock (its process gone) is taken over', async () => {
    const root = join(ws, 'lock');
    const a = await WorkerLock.acquire(root, 'b1');
    expect(a).not.toBeNull();
    expect(await WorkerLock.acquire(root, 'b1')).toBeNull();
    expect(readWorkerLock(root)).toMatchObject({ pid: process.pid, build: 'b1' });
    a!.release();
    expect(readWorkerLock(root)).toBeNull();
    await writeFile(join(root, '.retake', 'workers', 'worker.lock'), JSON.stringify({ pid: deadPid(), host: 'h', version: '0', build: 'old', since: '2026-01-01T00:00:00.000Z' }));
    const notes: string[] = [];
    const b = await WorkerLock.acquire(root, 'b2', (m) => notes.push(m));
    expect(b).not.toBeNull();
    expect(notes[0]).toContain('took over a stale worker lock');
    b!.release();
  });

  it('started_by (L4.2): the client that started it, a client name only — anything else is dropped, written or read', async () => {
    const root = join(ws, 'lock-started-by');
    const a = await WorkerLock.acquire(root, 'b1', undefined, 'ui');
    expect(readWorkerLock(root)).toMatchObject({ pid: process.pid, started_by: 'ui' });
    a!.release();
    const odd = await WorkerLock.acquire(root, 'b1', undefined, 'ui <b>x</b>');
    expect(readWorkerLock(root)?.started_by).toBeUndefined();
    expect(await readFile(join(root, '.retake', 'workers', 'worker.lock'), 'utf8')).not.toContain('started_by');
    odd!.release();
    await writeFile(join(root, '.retake', 'workers', 'worker.lock'), JSON.stringify({ pid: process.pid, host: 'h', version: '0', build: 'b', since: '2026-01-01T00:00:00.000Z', started_by: '<img src=x>' }));
    const read = readWorkerLock(root);
    expect(read?.pid).toBe(process.pid);
    expect(read?.started_by).toBeUndefined();
  });

  it('a lock without its start time naming a live pid is stale (review A #7: a forged lock kept every worker off)', async () => {
    const root = join(ws, 'lock-forged');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      for (const pid of [process.pid, child.pid!]) {
        await mkdir(join(root, '.retake', 'workers'), { recursive: true });
        await writeFile(join(root, '.retake', 'workers', 'worker.lock'), JSON.stringify({ pid, host: 'h', version: '0', build: 'b', since: 'now', started_by: 'ui' }));
        expect(await liveWorker(root), String(pid)).toBeNull();
        // A start time that is not the process's: stale too.
        await writeFile(join(root, '.retake', 'workers', 'worker.lock'), JSON.stringify({ pid, started_at: '2001-01-01T00:00:00.000Z', host: 'h', version: '0', build: 'b', since: 'now' }));
        expect(await liveWorker(root), String(pid)).toBeNull();
      }
      // The forged lock is taken over by a real worker, whose own lock (with its start time) is alive.
      const lock = await WorkerLock.acquire(root, 'b1', undefined, 'ui');
      expect(lock).not.toBeNull();
      expect(await liveWorker(root)).toMatchObject({ pid: process.pid, started_by: 'ui' });
      lock!.release();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('reserveRunId', () => {
  it('two runs of one scenario in the same second get the next free second', async () => {
    const dir = join(ws, 'runs-reserve');
    const at = new Date(2026, 9, 17, 14, 22, 33);
    const a = await reserveRunId(dir, 'quote', at);
    const b = await reserveRunId(dir, 'quote', at);
    expect(a.id).toBe('20261017-142233-quote');
    expect(b.id).toBe('20261017-142234-quote');
    expect(existsSync(b.dir)).toBe(true);
  });
});

describe('engine.runs.submit (no worker started)', () => {
  it('reserves the run id with a valid `queued` run.json and queues a contract-valid input with the scenario hash', async () => {
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry', until: 'discover.1' });
    expect(sub.worker).toBeUndefined();
    expect(sub.warnings.some((w) => w.includes('dry run without its setup hooks'))).toBe(true);
    const dir = join(ws, 'projects', 'northfield-fixture', 'runs', sub.run_id);
    const record = RunRecordSchema.parse(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')));
    expect(record).toMatchObject({ status: 'queued', mode: 'dry', env: 'local', steps_total: 2, options: { hooks: 'skip', until: 'discover.1' } });
    const text = await readFile(join(ws, 'projects', 'northfield-fixture', 'scenarios', 'quote.yaml'));
    const { sha256Hex } = await import('../src/index.js');
    expect(sub.job.input).toEqual({
      version: 1,
      kind: 'run',
      project: 'northfield-fixture',
      scenario: 'quote',
      scenario_sha256: sha256Hex(text),
      mode: 'dry',
      until: 'discover.1',
      run_id: sub.run_id,
      submitted_by: 'test',
    });
    const st = await engine.runs.status('northfield-fixture', sub.run_id);
    expect(st).toMatchObject({ status: 'queued', job: { id: sub.job.id, state: 'queued', queue: { ahead: 0 } } });
    // Cancelled before a worker came: the overlay says so at once.
    await engine.runs.cancel('northfield-fixture', sub.run_id);
    expect(await engine.runs.status('northfield-fixture', sub.run_id)).toMatchObject({ status: 'cancelled', finished: true, job: { state: 'cancelled' } });
  });

  it('hooks a human must approve (destructive whatever `confirm` says): without an approver, refused with the CLI command', async () => {
    const e = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'catalogue', mode: 'capture' }).catch((x: unknown) => x as EngineError);
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe('needs_approval');
    expect((e as EngineError).message).toContain('setup hook 2 "free-registry-ref" (HTTP DELETE)');
    expect((e as EngineError).fix).toBe(`retake -C ${ws} run northfield-fixture catalogue`);
    // A shell hook marked `writes: false` on the production environment: through MCP it writes — refused before anyone is asked.
    const scenario = join(ws, 'projects', 'northfield-fixture', 'scenarios', 'shell-prod.yaml');
    await writeFile(
      scenario,
      'video: shell-prod\nenv: production\nsetup:\n  - name: post\n    shell: {run: "curl -X POST http://localhost:4401/api/reset"}\n    writes: false\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n',
    );
    let asked = 0;
    const approver = { approve: async () => (asked++, { approved: true as const }) };
    const s = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'shell-prod', mode: 'capture' }, { approver }).catch((x: unknown) => x as EngineError);
    expect((s as EngineError).code).toBe('refused');
    expect((s as EngineError).message).toContain('through MCP a shell hook always counts as writing');
    expect(asked).toBe(0);
    // A dry run skips the hooks: accepted (and refused again with hooks: run).
    const runsBefore = (await engine.runs.list('northfield-fixture', { scenario: 'shell-prod' })).length;
    const dry = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'shell-prod', mode: 'dry' });
    expect(dry.job.state).toBe('queued');
    const hooked = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'shell-prod', mode: 'dry', hooks: 'run' }).catch((x: unknown) => x as EngineError);
    expect((hooked as EngineError).code).toBe('refused');
    expect((hooked as EngineError).fix).toBe(`retake -C ${ws} run northfield-fixture shell-prod --dry --hooks run`);
    // Refusals reserve no run folder.
    expect((await engine.runs.list('northfield-fixture', { scenario: 'shell-prod' })).length).toBe(runsBefore + 1);
  });

  it('refuses names that are paths and options that do not apply, before reserving anything', async () => {
    for (const req of [
      { project: '../x', scenario: 'quote' },
      { project: 'northfield-fixture', scenario: '/etc/passwd' },
      { project: 'northfield-fixture', scenario: 'quote', until: 'nowhere.9' },
      { project: 'northfield-fixture', scenario: 'quote', env: 'local', sandbox: true },
    ]) {
      const e = await engine.runs.submit({ mode: 'dry', ...req }).catch((x: unknown) => x as EngineError);
      expect(e, JSON.stringify(req)).toBeInstanceOf(EngineError);
      expect((e as EngineError).code, JSON.stringify(req)).toBe('invalid');
    }
    expect((await engine.runs.submit({ project: 'northfield-fixture', scenario: 'nope', mode: 'dry' }).catch((x: unknown) => x as EngineError) as EngineError).code).toBe('not_found');
  });

  it('maps the run executor errors: options → invalid, a take interrupted → cancelled, busy → busy', () => {
    expect(toEngineError(new RunOptionError('--sandbox …')).code).toBe('invalid');
    expect(toEngineError(new SandboxTakeError('sandbox s: interrupted', true, 'interrupted')).code).toBe('cancelled');
    expect(toEngineError(new SandboxTakeError('sandbox s is in use', false, 'busy')).code).toBe('busy');
    expect(toEngineError(new SandboxTakeError('health check failed', false)).code).toBe('unavailable');
  });

  it('runCommandLine: the retake command of the same run', () => {
    expect(runCommandLine('retake', { project: 'p', scenario: 's', mode: 'capture', env: 'my env', sandbox: true })).toBe("retake run p s --env 'my env' --sandbox");
    expect(runCommandLine('retake', { project: 'p', scenario: 's', mode: 'dry', until: 'a.1', hooks: 'run' })).toBe('retake run p s --dry --until a.1 --hooks run');
  });
});

describe('a job runs the scenario bytes it was submitted with', () => {
  const file = () => join(ws, 'projects', 'northfield-fixture', 'scenarios', 'quote.yaml');

  it('a run job whose scenario changed after the submit: conflict with both hashes before anything runs, the reserved run failed', async () => {
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry', until: 'discover.1' });
    const text = await readFile(file(), 'utf8');
    expect((sub.job.input as RunJobInput).scenario_sha256).toBe(sha256Hex(text));
    await writeFile(file(), `${text}\n# changed\n`);
    try {
      const events: unknown[] = [];
      const e = await executeRunJob({
        ws: await openWorkspace({ root: ws }),
        cli: 'retake',
        input: sub.job.input as RunJobInput,
        signal: new AbortController().signal,
        interrupts: signalInterrupts(),
        event: (x) => events.push(x),
        progress: () => undefined,
      }).catch((x: unknown) => x as EngineError);
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe('conflict');
      expect((e as EngineError).message).toBe('scenarios/quote changed since the run was submitted: submit it again (what was checked is what runs)');
      expect((e as EngineError).details).toEqual({ submitted: sha256Hex(text), current: sha256Hex(`${text}\n# changed\n`) });
      expect(events).toEqual([]);
      const record = JSON.parse(await readFile(join(ws, 'projects', 'northfield-fixture', 'runs', sub.run_id, 'run.json'), 'utf8')) as { status: string };
      expect(record.status).toBe('failed');
    } finally {
      await writeFile(file(), text);
      await engine.runs.cancel('northfield-fixture', sub.run_id).catch(() => undefined);
    }
  });

  it('prepareRun reads the file once: the sandbox it picks, the scenario it parses and their hash come from that one read', async () => {
    const w = await openWorkspace({ root: ws });
    const project = await openProjectBySlug(w, 'northfield-fixture');
    const disk = join(ws, 'projects', 'northfield-fixture', 'scenarios', 'sandbox-quote.yaml');
    const onDisk = await readFile(disk, 'utf8');
    // The bytes the one read returns name the other sandbox and hold longer: the file on disk is never read again.
    const first = onDisk.replace('env: sandbox\n', 'env: sandbox-docker\n').replace('      - hold: 0.8\n', '      - hold: 2.5\n');
    expect(first).not.toBe(onDisk);
    const reads: string[] = [];
    const prepared = await prepareRun(w, project, 'sandbox-quote', {
      dry: true,
      sandbox: true,
      readFile: async (file) => {
        reads.push(file);
        return Buffer.from(first, 'utf8');
      },
    });
    expect(reads).toEqual([disk]);
    expect(prepared.sandboxEnv).toBe('sandbox-docker');
    expect(prepared.scenario.text).toBe(first);
    expect(prepared.scenario.sha256).toBe(sha256Hex(first));
    expect(prepared.scenario.scenario.scenes[0].steps).toContainEqual(expect.objectContaining({ hold: 2.5 }));
  });

  it('an inspection of a scenario: the hash of the bytes it parsed, a pinned one checked on those bytes', async () => {
    const w = await openWorkspace({ root: ws });
    const project = await openProjectBySlug(w, 'northfield-fixture');
    const text = await readFile(file());
    const pinned = await prepareInspect(w, project, { kind: 'scenario', scenario: 'quote' }, undefined);
    expect(pinned.source).toMatchObject({ scenario_sha256: sha256Hex(text) });
    expect(pinned.scenario.sha256).toBe(sha256Hex(text));
    const e = await prepareInspect(w, project, { kind: 'scenario', scenario: 'quote', scenario_sha256: 'b'.repeat(64) }, undefined).catch((x: unknown) => x as EngineError);
    expect((e as EngineError).code).toBe('conflict');
    expect((e as EngineError).message).toBe('scenarios/quote changed since the inspection was submitted: submit it again (what was checked is what runs)');
    expect((e as EngineError).details).toEqual({ submitted: 'b'.repeat(64), current: sha256Hex(text) });
  });
});

describe('captures first in the job views (L5.14b)', () => {
  it('a heavy job held by a take reads `yield`: waiting (queued), background or past the cap (running, from yield.json); words fixed; never written back', async () => {
    const { FilmingMarker, JobsWatch, heldWork, heldWorkWords, selfIdentity, yieldWords } = await import('../src/index.js');
    const { hostname } = await import('node:os');
    const root = join(ws, 'q-yield');
    const q = new FileJobQueue(root);
    const review = (n: number) => q.enqueue({ version: 1, kind: 'review', project: 'northfield-fixture', render_id: `quote-v${n}`, fps: 1, submitted_by: 'test' } as never);
    const queued = await review(1);
    const dry = await q.enqueue({ ...INPUT, run_id: '20261104-140000-quote' });
    expect((await q.get(queued.id))?.yield).toBeUndefined();
    const watch = new JobsWatch(q);
    await watch.poll();
    expect(watch.held()).toBeUndefined();
    // A take queued in this workspace: the heavy job waits, "in this workspace"; a dry run is never held.
    const take = await q.enqueue({ ...INPUT, mode: 'capture', run_id: '20261104-140001-quote' });
    expect((await q.get(queued.id))?.yield).toEqual({ state: 'waiting', cause: 'here' });
    expect((await q.get(dry.id))?.yield).toBeUndefined();
    // The job stream says it (its signature has the yield) and what is held.
    expect(await watch.poll()).toEqual(expect.arrayContaining([queued.id]));
    expect(watch.held()).toEqual({ state: 'waiting', cause: 'here', kind: 'review', count: 1 });
    expect(heldWorkWords(watch.held()!)).toBe('a review waits for a take to finish (in this workspace)');
    await q.cancel(take.id, 'test');
    // A take filming elsewhere on this Mac (a marker of another workspace): "elsewhere", nothing of it named.
    const m = FilmingMarker.open({ root: join(ws, 'q-yield-other'), source: 'cli', owner: await selfIdentity() })!;
    try {
      const held = (await q.list({ kinds: ['review'] }))[0]!;
      expect(held.yield).toEqual({ state: 'waiting', cause: 'elsewhere' });
      expect(yieldWords(held.yield!)).toBe('waiting for a take to finish (elsewhere on this Mac)');
      expect(JSON.stringify(held)).not.toContain('q-yield-other');
    } finally {
      m.closeSync();
    }
    expect((await q.get(queued.id))?.yield).toBeUndefined();
    // Running: background from its worker's yield.json, past the cap, anything else ignored.
    const running = await review(2);
    const me = { ...(await selfIdentity()), host: hostname() };
    const stored = (await q.stored(running.id))!;
    await q.write({ ...stored, state: 'running', started_at: new Date().toISOString(), worker: me, supervisor: me });
    await writeFile(q.files.yield(running.id), JSON.stringify({ v: 1, state: 'background', since: '2026-11-04T14:02:00.000Z', cause: 'here' }));
    const bg = (await q.get(running.id))!;
    expect(bg.yield).toEqual({ state: 'background', cause: 'here', since: '2026-11-04T14:02:00.000Z' });
    expect(yieldWords(bg.yield!)).toBe('slowed during a take (in this workspace)');
    expect(heldWork([bg, (await q.get(queued.id))!])).toEqual({ state: 'background', cause: 'here', kind: 'review', count: 1 });
    await writeFile(q.files.yield(running.id), JSON.stringify({ v: 1, state: 'past_cap', since: '2026-11-04T15:02:00.000Z', cause: 'elsewhere', cap_min: 60 }));
    const capped = (await q.get(running.id))!;
    expect(capped.yield).toEqual({ state: 'past_cap', cause: 'elsewhere', since: '2026-11-04T15:02:00.000Z', cap_min: 60 });
    expect(yieldWords(capped.yield!)).toBe('going on: a take (elsewhere on this Mac) has held heavy work for over 60 min');
    for (const bad of ['{', JSON.stringify({ state: 'paused', cause: 'here' }), JSON.stringify({ state: 'background', cause: '/Users/someone/ws', since: 'soon' })]) {
      await writeFile(q.files.yield(running.id), bad);
      const y = (await q.get(running.id))!.yield;
      if (y) expect(y).toEqual({ state: 'background', cause: 'elsewhere' });
    }
    // Derived only: a record written back never carries it.
    await writeFile(q.files.yield(running.id), JSON.stringify({ v: 1, state: 'background', cause: 'here' }));
    await q.write((await q.get(running.id))!);
    expect(JSON.parse(await readFile(join(q.files.job(running.id), 'job.json'), 'utf8')).yield).toBeUndefined();
  });
});
