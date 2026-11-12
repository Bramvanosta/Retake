/**
 * L7.29 (audit 2026-11-10 P6, P7): the jobs worker's ports and its job handlers. The handler table holds one handler
 * per job kind (job-input.ts JOB_KINDS), typed by the kind; the worker's ports are the engine's plus the renderer, the record
 * window, the free space and the job processes, their defaults the product's; heavy jobs run in the worker's own process
 * exactly when a port a heavy job reads was handed (an object cannot reach a job process).
 */
import { describe, expect, it } from 'vitest';
import { JOB_KINDS } from '@retake/engine';
import type { JobKind } from '@retake/engine';
import { JOB_HANDLERS } from '../src/jobs/job-handlers.js';
import type { JobHandler } from '../src/jobs/job-handlers.js';
import { buildDirs, buildStamp } from '../src/jobs/build.js';
import { processKill } from '../src/jobs/signal.js';
import { jobProcessCommand } from '../src/jobs/spawn.js';
import { workerPorts } from '../src/jobs/worker-ports.js';
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
    const { ports, heavyInProcess } = workerPorts(enginePorts(), {}, dirs);
    expect(heavyInProcess).toBe(false);
    expect(ports.recordWindow).toEqual({});
    expect(ports.freeBytes).toBe(freeBytesOf);
    expect(ports.processes.kill).toBe(processKill);
    expect(ports.processes.qos).toEqual({});
    expect(ports.processes.buildStamp()).toBe(buildStamp(dirs));
    const job = { id: 'j_1', kind: 'review', root: '/w', build: 'b', supervisor: 42, digest: 'd' };
    expect(ports.processes.command(job)).toEqual(jobProcessCommand('/w', { id: 'j_1', kind: 'review', build: 'b', supervisor: 42, digest: 'd' }));
    expect(Object.keys(ports.renderer).sort()).toEqual(['previews', 'stills', 'video']);
  });

  it('heavy jobs run in the worker exactly when a port a heavy job reads is handed: not for the window or the job processes alone', () => {
    const dirs = buildDirs();
    const inProcess = (given: WorkerPortsGiven) => workerPorts(enginePorts(given), given, dirs).heavyInProcess;
    expect(inProcess({})).toBe(false);
    expect(inProcess({ recordWindow: { headless: true } })).toBe(false);
    expect(inProcess({ processes: { kill: () => undefined, buildStamp: () => 'x' } })).toBe(false);
    expect(inProcess({ recordWindow: { headless: true }, processes: { qos: {} } })).toBe(false);
    expect(inProcess({ renderer: new MemoryRenderer() })).toBe(true);
    expect(inProcess({ freeBytes: async () => 1 })).toBe(true);
    expect(inProcess({ clock: new ManualClock('2030-01-01T00:00:00.000Z') })).toBe(true);
    expect(inProcess({ recordWindow: { headless: true }, capture: enginePorts().capture })).toBe(true);
    // A member of the job processes given, the others the product's.
    const kill = () => undefined;
    const { ports } = workerPorts(enginePorts(), { processes: { kill } }, dirs);
    expect(ports.processes.kill).toBe(kill);
    expect(ports.processes.buildStamp()).toBe(buildStamp(dirs));
  });
});
