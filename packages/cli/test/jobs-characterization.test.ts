/**
 * What `retake jobs cancel` prints, pinned byte for byte with its exit code: a queued job cancelled, a finished one
 * left alone, a running one asked to stop, an unknown job and a malformed id. The command goes through the engine's
 * job_cancel operation (caller `cli`) and prints from its data; this file holds that the text a person reads did not
 * change. Job ids are written as `<queued>` and `<running>`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue } from '@retake/engine/testing';
import { liveWorker, selfIdentity } from '@retake/engine/shell';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { main, memoryIo } from '../src/index.js';

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-jobs-pin-'));
  await fixtureWorkspace(ws);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

const RUN = {
  version: 1,
  kind: 'run',
  project: 'northfield-fixture',
  scenario: 'quote',
  scenario_sha256: 'a'.repeat(64),
  mode: 'dry',
  submitted_by: 'mcp',
} as const;

describe('retake jobs cancel: its whole output, pinned', () => {
  it('prints what it printed, with the same exit codes', async () => {
    const q = new FileJobQueue(ws);
    const queued = await q.enqueue({ ...RUN, run_id: '20261017-150000-quote' } as never);
    const running = await q.enqueue({ ...RUN, run_id: '20261017-150100-quote', mode: 'capture' } as never);
    // Running in this process (a live pid on this host): not derived interrupted.
    const me = { ...(await selfIdentity()), host: hostname() };
    await q.write({ ...(await q.stored(running.id))!, state: 'running', started_at: '2026-10-17T15:01:00.000Z', worker: me, supervisor: me });
    const named = (s: string) => s.replaceAll(queued.id, '<queued>').replaceAll(running.id, '<running>');
    const out: Record<string, { code: number; out: string; err: string }> = {};
    for (const [name, args] of [
      ['queued', ['cancel', queued.id]],
      ['finished', ['cancel', queued.id]],
      ['running', ['cancel', running.id]],
      ['running again', ['cancel', running.id]],
      ['unknown', ['cancel', 'j_00000000000000000000000000']],
      ['malformed', ['cancel', 'nope']],
    ] as Array<[string, string[]]>) {
      const io = memoryIo();
      const code = await main(['node', 'retake', '--root', ws, 'jobs', ...args], io);
      out[name] = { code, out: named(io.stdout()), err: named(io.stderr()) };
    }
    expect(out).toEqual(PINNED);
    // The terminal's cancel starts no worker.
    expect(await liveWorker(ws)).toBeNull();
    await q.write({ ...(await q.stored(running.id))!, state: 'cancelled', finished_at: '2026-10-17T15:02:00.000Z' });
  });
});

/** Made with the command as it was before it went through the operation. */
const PINNED: Record<string, { code: number; out: string; err: string }> = {
  'queued': {
    'code': 0,
    'out': '',
    'err': '✓ <queued> cancelled (run quote (dry) → 20261017-150000-quote)\n',
  },
  'finished': {
    'code': 0,
    'out': '',
    'err': '<queued> is already cancelled: nothing to cancel\n',
  },
  'running': {
    'code': 0,
    'out': '',
    'err': '✓ <running>: cancel requested (run quote (capture) → 20261017-150100-quote) — its teardown and rollbacks run first; retake jobs status <running> follows it\n',
  },
  'running again': {
    'code': 0,
    'out': '',
    'err': '✓ <running>: cancel requested (run quote (capture) → 20261017-150100-quote) — its teardown and rollbacks run first; retake jobs status <running> follows it\n',
  },
  'unknown': {
    'code': 1,
    'out': '',
    'err': '✗ job j_00000000000000000000000000 not found (retake jobs lists them)\n',
  },
  'malformed': {
    'code': 2,
    'out': '',
    'err': '✗ "nope" is not a job id (j_ followed by 26 characters: retake jobs lists them)\n',
  },
};
