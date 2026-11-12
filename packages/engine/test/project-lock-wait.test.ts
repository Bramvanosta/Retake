/**
 * Waiting for a lock another process holds (project-lock.ts takeProjectLock, L7.26 fix pass): the tries back off
 * (20 ms growing to 200 ms) and a holder found alive once — the same pid, start time and lock — is not asked again by
 * its start time (TakeLock.acquire's synchronous `ps`) while it holds: only by a signal 0. A holder that dies mid-wait
 * is seen at the next try and its lock taken. The holder is a real process (test/fixtures/log-writer.mts `slow`).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EngineError } from '../src/errors.js';
import { takeProjectLock } from '../src/project-lock.js';

const tries = vi.hoisted(() => ({ n: 0 }));
vi.mock('@retake/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@retake/sandbox')>();
  const acquire = actual.TakeLock.acquire.bind(actual.TakeLock);
  actual.TakeLock.acquire = (...a: Parameters<typeof acquire>) => {
    tries.n++;
    return acquire(...a);
  };
  return actual;
});

const REPO = resolve(import.meta.dirname, '../../..');
const WRITER = join(REPO, 'packages', 'engine', 'test', 'fixtures', 'log-writer.mts');
let base: string;
let n = 0;

/** A process holding `<root>/.retake/locks/journal.lock` for `ms` (it says `locked` once it holds it). */
async function holder(root: string, ms: number) {
  const child = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', WRITER, 'slow', root, 'journal.jsonl', String(ms)], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  const first = await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next();
  expect(first.value).toBe('locked');
  return { child, exited };
}

const take = (root: string) => takeProjectLock(root, 'journal.lock', { command: 'test', what: 'the journal', waitMs: 20_000, busy: (ref) => new EngineError('busy', `${ref} is held`) });

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'engine-lock-wait-'));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('waiting for a lock another process holds (L7.26)', () => {
  it('a live holder is asked by its start time once per wait; the lock is taken once it is released', async () => {
    const root = join(base, `ws-${n++}`);
    await mkdir(join(root, '.retake'), { recursive: true });
    const h = await holder(root, 1_500);
    tries.n = 0;
    const t0 = Date.now();
    const lock = await take(root);
    const waited = Date.now() - t0;
    await lock.release();
    await h.exited;
    // About 1.5 s of waiting: one try that found it held, one that took it (at 20 ms a try, it was some 75).
    expect(waited).toBeGreaterThan(800);
    expect(tries.n).toBe(2);
  }, 30_000);

  it('a holder that dies mid-wait is seen at the next try (a signal 0) and its lock taken at once', async () => {
    const root = join(base, `ws-${n++}`);
    await mkdir(join(root, '.retake'), { recursive: true });
    const h = await holder(root, 10_000);
    tries.n = 0;
    setTimeout(() => h.child.kill('SIGKILL'), 400);
    const t0 = Date.now();
    const lock = await take(root);
    const waited = Date.now() - t0;
    await lock.release();
    await h.exited;
    expect(waited).toBeLessThan(2_000);
    expect(tries.n).toBe(2);
  }, 30_000);
});
