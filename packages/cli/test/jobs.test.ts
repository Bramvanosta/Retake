/**
 * `retake jobs` (L3.1): the jobs an MCP client started, for the human at the terminal — list (text and --json), status
 * and cancel of a queued job; usage errors for a malformed id or state. Jobs are queued through the engine (no worker
 * runs them here, and the terminal's cancel starts none: a worker started with the terminal's environment would run the
 * other jobs an MCP client queued).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, createEngine, liveWorker, workersDir } from '@retake/engine';
import { EXIT, main, memoryIo } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

let ws: string;
let idle: string | undefined;

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-jobs-cli-'));
  await fixtureWorkspace(ws);
  idle = process.env.RETAKE_WORKER_IDLE_MS;
  process.env.RETAKE_WORKER_IDLE_MS = '300';
});

afterAll(async () => {
  if (idle === undefined) delete process.env.RETAKE_WORKER_IDLE_MS;
  else process.env.RETAKE_WORKER_IDLE_MS = idle;
  await rm(ws, { recursive: true, force: true });
});

describe('retake jobs', () => {
  it('lists nothing at first; a queued dry run shows in the list, --json and status; cancel closes it', async () => {
    const empty = await retake('jobs');
    expect(empty.code, empty.err).toBe(EXIT.ok);
    expect(empty.out).toBe('');
    expect(empty.err).toContain('no jobs');
    expect(empty.err).toContain('worker: not running');

    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'quote', mode: 'dry' });
    const list = await retake('jobs');
    expect(list.code).toBe(EXIT.ok);
    expect(list.out).toMatch(new RegExp(`^${sub.job.id}  queued +northfield-fixture · run quote \\(dry\\) → ${sub.run_id} \\(just now, by mcp\\)$`, 'm'));
    const json = JSON.parse((await retake('jobs', '--json', '--state', 'queued')).out) as { jobs: Array<{ id: string; state: string }>; worker: unknown };
    expect(json).toEqual({ jobs: [expect.objectContaining({ id: sub.job.id, state: 'queued' })], worker: null });
    expect(JSON.parse((await retake('jobs', 'list', '--json', '--state', 'running')).out).jobs).toEqual([]);

    const status = await retake('jobs', 'status', sub.job.id);
    expect(status.code).toBe(EXIT.ok);
    expect(status.out).toContain(`${sub.job.id} queued`);
    expect(status.out).toMatch(/what +northfield-fixture · run quote \(dry\)/);
    expect(status.out).toMatch(/queue +next/);

    const cancel = await retake('jobs', 'cancel', sub.job.id);
    expect(cancel.code, cancel.err).toBe(EXIT.ok);
    expect(cancel.err).toContain(`${sub.job.id} cancelled`);
    expect((await new FileJobQueue(ws).get(sub.job.id))?.state).toBe('cancelled');
    // No worker was started by the terminal (N1); the run is listed cancelled all the same (run.json still says queued).
    expect(await liveWorker(ws)).toBeNull();
    expect(existsSync(join(workersDir(ws), 'worker.log'))).toBe(false);
    expect((await engine.runs.list('northfield-fixture')).find((r) => r.id === sub.run_id)?.status).toBe('cancelled');
    const again = await retake('jobs', 'cancel', sub.job.id);
    expect(again.err).toContain('is already cancelled: nothing to cancel');
  });

  it('L5.14a fixes (review B M4): a review a queued take holds says "waiting for a take to finish", not "next"', async () => {
    const q = new FileJobQueue(ws);
    const take = await q.enqueue({ version: 1, kind: 'run', project: 'northfield-fixture', scenario: 'quote', scenario_sha256: 'a'.repeat(64), run_id: '20261017-150000-quote', mode: 'capture', submitted_by: 'test' } as never);
    const review = await q.enqueue({ version: 1, kind: 'review', project: 'northfield-fixture', render_id: 'quote-v1', fps: 1, submitted_by: 'test' } as never);
    const status = await retake('jobs', 'status', review.id);
    expect(status.code, status.err).toBe(EXIT.ok);
    expect(status.out).toMatch(/queue +waiting for a take to finish/);
    await q.cancel(take.id, 'test');
    expect((await retake('jobs', 'status', review.id)).out).toMatch(/queue +next/);
    await q.cancel(review.id, 'test');
  });

  it('usage errors: a malformed id or an unknown state (exit 2); an unknown job (exit 1)', async () => {
    expect((await retake('jobs', 'status', 'nope')).code).toBe(EXIT.usage);
    expect((await retake('jobs', '--state', 'sleeping')).code).toBe(EXIT.usage);
    const missing = await retake('jobs', 'status', 'j_00000000000000000000000000');
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain('not found (retake jobs lists them)');
  });
});
