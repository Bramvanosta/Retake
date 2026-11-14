/**
 * The heavy job's yield (what the Studio and job_status show of a job held while a take films) is written by the
 * worker; a write that fails is logged with the job and the reason, and the job's priority still follows the take.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/index.js';
import { recordYield, steerHeavy } from '../src/jobs/worker-heavy.js';
import type { HeavyChild, Worker } from '../src/jobs/worker-record.js';

function setup() {
  const logs: string[] = [];
  const calls: string[] = [];
  const queue = {
    setYield: async (id: string, mark: unknown) => {
      calls.push(`${id} ${mark === null ? 'null' : (mark as { state: string }).state}`);
      throw new Error('EROFS: read-only file system');
    },
    cancelOf: async () => undefined,
  };
  const qos = { held: false, hold: async () => void (qos.held = true), release: async () => void (qos.held = false) };
  const h = { id: 'j_heavy', kind: 'render', pid: 0, exit: Promise.resolve(), qos } as unknown as HeavyChild;
  const w = { queue, log: (m: string) => void logs.push(m), clock: new ManualClock(Date.parse('2026-11-13T10:00:00Z')), filmingLive: true, cancelGraceMs: 10_000 } as unknown as Worker;
  return { w, h, qos, logs, calls };
}

describe("a heavy job's yield that cannot be written", () => {
  it('is logged with the job and the reason; the hold and its release still happen', async () => {
    const { w, h, qos, logs, calls } = setup();
    await steerHeavy(w, h);
    expect(qos.held).toBe(true);
    expect(calls).toEqual(['j_heavy background']);
    expect(logs).toContain('job j_heavy: its yield state could not be recorded (EROFS: read-only file system): what it shows may be stale');
    (w as { filmingLive: boolean }).filmingLive = false;
    await steerHeavy(w, h);
    expect(qos.held).toBe(false);
    expect(calls).toEqual(['j_heavy background', 'j_heavy null']);
    expect(logs.filter((l) => l.includes('could not be recorded'))).toHaveLength(2);
  });

  it('recordYield resolves either way (a caller chains the QoS release on it)', async () => {
    const { w, logs } = setup();
    await expect(recordYield(w, 'j_x', null)).resolves.toBeUndefined();
    expect(logs).toEqual(['job j_x: its yield state could not be recorded (EROFS: read-only file system): what it shows may be stale']);
  });
});
