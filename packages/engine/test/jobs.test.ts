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
import { JOB_ID_RE, RunRecordSchema, reserveRunId } from '@retake/core';
import type { RunJobInput } from '@retake/core';
import { EngineError, FileJobQueue, RunOptionError, SandboxTakeError, WorkerLock, createEngine, liveWorker, newJobId, readWorkerLock, runCommandLine, toEngineError } from '../src/index.js';
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
