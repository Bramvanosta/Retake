/**
 * The job queue port: the contract suite on the file queue and on the in-memory queue, and what only the file queue
 * has (its files: where the port's entries land, its file part's paths).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, MemoryJobQueue } from '../src/index.js';
import { RUN_INPUT, jobQueueContract } from './job-queue-contract.js';

let ws: string;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-queue-contract-'));
  process.env.RETAKE_HOME = join(ws, '.home');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

let n = 0;
jobQueueContract('file', async (name, cli) => {
  // A workspace folder exists before its queue does (as every real one): approvals are signed over its real path.
  const root = join(ws, `file-${name}-${n++}`);
  await mkdir(root, { recursive: true });
  return { queue: new FileJobQueue(root, cli), root };
});

jobQueueContract('memory', async (name, cli) => {
  const root = join(ws, `memory-${name}-${n++}`);
  await mkdir(root, { recursive: true });
  return { queue: new MemoryJobQueue(root, cli ? { cli } : {}), root };
});

describe('the file queue (its files)', () => {
  it('keeps the port\'s entries as the files of the job folder, a submit\'s files readable by this user only', async () => {
    const q = new FileJobQueue(join(ws, 'files'));
    const job = await q.enqueue(RUN_INPUT, { files: { 'edit.yaml': 'a: 1\n' } });
    const dir = q.files.job(job.id);
    expect(dir).toBe(join(ws, 'files', '.retake', 'jobs', job.id));
    expect(JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'))).toEqual(job);
    expect((await stat(join(dir, 'edit.yaml'))).mode & 0o777).toBe(0o600);
    await q.cancel(job.id, 'test');
    expect(JSON.parse(await readFile(join(dir, 'cancel'), 'utf8'))).toMatchObject({ by: 'test' });
    await q.setYield(job.id, { state: 'background', since: '2026-11-04T14:02:00.000Z', cause: 'here' });
    expect(await readFile(q.files.yield(job.id), 'utf8')).toBe('{"v":1,"state":"background","since":"2026-11-04T14:02:00.000Z","cause":"here"}\n');
    await q.setYield(job.id, null);
    expect(existsSync(q.files.yield(job.id))).toBe(false);
    await q.append(job.id, 0, [{ type: 'log', level: 'info', message: 'one' }]);
    expect(await readFile(q.files.events(job.id), 'utf8')).toContain('"message":"one"');
    expect(q.files.browser(job.id)).toBe(join(dir, 'browser.json'));
    expect(q.files.live(job.id)).toBe(join(dir, 'live.json'));
    // The file part refuses anything but a job id (never a path).
    for (const bad of ['../x', `${job.id}/../..`, '']) expect(() => q.files.job(bad), bad).toThrow(/invalid job id/);
  });

  it('a reader is the same queue with its own memory: what one writes, the other reads', async () => {
    const q = new FileJobQueue(join(ws, 'reader'), 'retake -C /ws');
    const r = q.reader();
    expect(r).not.toBe(q);
    expect(r.cli).toBe('retake -C /ws');
    const job = await q.enqueue(RUN_INPUT);
    expect((await r.get(job.id))?.state).toBe('queued');
    await r.cancel(job.id, 'test');
    expect((await q.get(job.id))?.state).toBe('cancelled');
    const m = new MemoryJobQueue(join(ws, 'reader-memory'));
    const other = await m.enqueue(RUN_INPUT);
    expect((await m.reader().get(other.id))?.id).toBe(other.id);
  });
});
