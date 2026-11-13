/**
 * L7.29 (audit 2026-11-10 P6, P7): the jobs worker's ports and its job handlers. The handler table holds one handler
 * per job kind (job-input.ts JOB_KINDS), typed by the kind; the worker's ports are the engine's plus the renderer, the record
 * window, the free space and the job processes, their defaults the product's. Heavy jobs run in the worker's own process
 * when its root says so (WorkerOptions.heavyInProcess); a worker handed a port a heavy job reads without it is refused
 * (an object cannot reach a job process). The list of those ports is typed over every port of the bag.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOB_KINDS, runWorker } from '@retake/engine';
import type { JobKind } from '@retake/engine';
import { JOB_HANDLERS } from '../src/jobs/job-handlers.js';
import type { JobHandler } from '../src/jobs/job-handlers.js';
import { buildDirs, buildStamp } from '../src/jobs/build.js';
import { processKill } from '../src/jobs/signal.js';
import { jobProcessCommand } from '../src/jobs/spawn.js';
import { HEAVY_JOB_PORTS, heavyPortsGiven, workerPorts } from '../src/jobs/worker-ports.js';
import { memoryJobQueues } from '../src/jobs/memory-queue.js';
import { MemoryWorkspace } from '../src/workspace-reads/memory-reads.js';
import type { WorkerPortsGiven } from '../src/jobs/worker-ports.js';
import { enginePorts } from '../src/ports.js';
import { freeBytesOf } from '../src/library.js';
import { ManualClock } from '../src/clock.js';
import { MemoryRenderer } from '../src/render/memory-renderer.js';

describe('the job handlers and the worker ports (L7.29)', () => {
  it('one handler per job kind, and none of another: the table is typed by the kind (no default branch)', () => {
    expect(Object.keys(JOB_HANDLERS).sort()).toEqual([...JOB_KINDS].sort());
    for (const kind of JOB_KINDS) expect(typeof JOB_HANDLERS[kind]).toBe('function');
    // The type: a table missing a kind does not compile (held by the build; this assignment is its witness).
    const table: { readonly [K in JobKind]: JobHandler<K> } = JOB_HANDLERS;
    expect(table).toBe(JOB_HANDLERS);
  });

  it("the defaults are the product's: the editor's renderer, a headed window a person drives, the volume's free space, worker-main's job processes, the build's stamp", () => {
    const dirs = buildDirs();
    const ports = workerPorts(enginePorts(), {}, dirs);
    // The product's mode: no port of a heavy job handed, heavy jobs in job processes.
    expect(heavyPortsGiven({})).toEqual([]);
    expect(ports.recordWindow).toEqual({});
    expect(ports.freeBytes).toBe(freeBytesOf);
    expect(ports.processes.kill).toBe(processKill);
    expect(ports.processes.qos).toEqual({});
    expect(ports.processes.buildStamp()).toBe(buildStamp(dirs));
    const job = { id: 'j_1', kind: 'review', root: '/w', build: 'b', supervisor: 42, digest: 'd' };
    expect(ports.processes.command(job)).toEqual(jobProcessCommand('/w', { id: 'j_1', kind: 'review', build: 'b', supervisor: 42, digest: 'd' }));
    expect(Object.keys(ports.renderer).sort()).toEqual(['previews', 'stills', 'video']);
  });

  it('every port of the bag is said to be read by a heavy job or not (typed over WorkerPorts: none forgotten), the reads among them', () => {
    const dirs = buildDirs();
    expect(Object.keys(HEAVY_JOB_PORTS).sort()).toEqual(Object.keys(workerPorts(enginePorts(), {}, dirs)).sort());
    expect(Object.keys(HEAVY_JOB_PORTS).sort()).toEqual(expect.arrayContaining(Object.keys(enginePorts()).sort()));
    expect(HEAVY_JOB_PORTS.reads).toBe(true);
    expect(
      Object.entries(HEAVY_JOB_PORTS)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .sort(),
    ).toEqual(['env', 'processes', 'recordWindow']);
  });

  it('heavy jobs run in the worker when its root says so: a port a heavy job reads handed without it is refused, the window and the job processes are not such ports', () => {
    const dirs = buildDirs();
    const refused = (given: WorkerPortsGiven) => () => workerPorts(enginePorts(given), given, dirs);
    expect(heavyPortsGiven({})).toEqual([]);
    expect(heavyPortsGiven({ recordWindow: { headless: true }, processes: { qos: {} } })).toEqual([]);
    expect(refused({ recordWindow: { headless: true } })).not.toThrow();
    expect(refused({ processes: { kill: () => undefined, buildStamp: () => 'x' } })).not.toThrow();
    // The environment reaches a job process (the heavy slot starts it with the worker's ports env): not such a port.
    expect(refused({ env: { RETAKE_X: '1' } })).not.toThrow();
    const mem = new MemoryWorkspace();
    expect(refused({ reads: mem.reads })).toThrow(/handed its own reads must run its heavy jobs in its own process \(heavyInProcess\)/);
    expect(refused({ renderer: new MemoryRenderer() })).toThrow(/renderer/);
    expect(refused({ freeBytes: async () => 1 })).toThrow(/freeBytes/);
    expect(refused({ clock: new ManualClock('2030-01-01T00:00:00.000Z') })).toThrow(/clock/);
    expect(refused({ queues: memoryJobQueues() })).toThrow(/queues/);
    expect(refused({ recordWindow: { headless: true }, capture: enginePorts().capture })).toThrow(/capture/);
    // Said, the same ports are taken: heavy jobs then run in this process on them.
    const given = { reads: mem.reads, renderer: new MemoryRenderer() };
    const ports = workerPorts(enginePorts(given), given, dirs, true);
    expect([ports.reads, ports.renderer]).toEqual([mem.reads, given.renderer]);
    // Said with no port handed: the product's ports, in this process.
    expect(workerPorts(enginePorts(), {}, dirs, true).reads).toBe(enginePorts().reads);
    // A member of the job processes given, the others the product's.
    const kill = () => undefined;
    const withKill = workerPorts(enginePorts(), { processes: { kill } }, dirs);
    expect(withKill.processes.kill).toBe(kill);
    expect(withKill.processes.buildStamp()).toBe(buildStamp(dirs));
  });

  it('a worker handed memory reads without heavyInProcess never starts: no job process, no lock, nothing read from its root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'retake-worker-ports-'));
    try {
      const mem = new MemoryWorkspace();
      const started: string[] = [];
      const run = runWorker({
        root,
        idleExitMs: 0,
        pollMs: 20,
        log: () => undefined,
        ports: { reads: mem.reads, processes: { command: (j) => (started.push(j.id), { command: 'false', args: [] }) } },
      });
      await expect(run).rejects.toThrow('a jobs worker handed its own reads must run its heavy jobs in its own process (heavyInProcess)');
      expect(started).toEqual([]);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
