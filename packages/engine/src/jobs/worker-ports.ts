/**
 * The jobs worker's ports: the engine's (ports.ts EnginePorts) and the three only a worker has — the window a `record`
 * job opens for a person, the free space a library preview job reads, and the job processes of its heavy slot (their
 * command line, the signals sent to them, their background priority, the build stamp the worker compares while idle).
 * `workerPorts` is where those three's defaults are written
 * (the product's adapters; the engine's are ports.ts enginePorts', which runWorker hands it). A composition root (worker-main through runWorker, an in-process test) hands any of them in
 * `WorkerOptions.ports`; the worker record and the job runner hold no test hook.
 */
import type { RecordPorts } from '../record.js';
import { freeBytesOf } from '../library.js';
import type { EnginePorts } from '../ports.js';
import { buildStamp } from './build.js';
import type { buildDirs } from './build.js';
import { processKill } from './signal.js';
import type { KillFn } from './signal.js';
import { jobProcessCommand } from './spawn.js';
import type { QosDeps } from './yield.js';

/**
 * The window a `record` job opens (record.ts RecordPorts): the product's is a headed window of its own size that a
 * person drives (`{}`); an in-process test plays the person (`drive`), headless.
 */
export type RecordWindow = Pick<RecordPorts, 'drive' | 'headless' | 'windowSize'>;

/** The free space of a folder's volume (bytes; undefined when it cannot be read): library.ts freeBytesOf. */
export type FreeBytes = (dir: string) => Promise<number | undefined>;

/** A heavy job as its job process is started for it. */
export interface JobProcessJob {
  id: string;
  kind: string;
  root: string;
  build: string;
  /** The worker's pid. */
  supervisor: number;
  digest: string;
}

/** The heavy slot's job processes, as the worker starts, signals and slows them. */
export interface JobProcesses {
  /** The command line of a heavy job's process (spawn.ts jobProcessCommand: worker-main --job …). */
  command(job: JobProcessJob): { command: string; args: string[] };
  /** Sends a signal to a job process or its tree (signal.ts checks every target first; default process.kill). */
  kill: KillFn;
  /** The QoS hold's process table and taskpolicy (yield.ts; default the system's). */
  qos: Partial<QosDeps>;
  /** The code's build stamp (build.ts): the worker's at its start, compared while it is idle. */
  buildStamp(): string;
}

/** Every port a jobs worker runs with: the engine's (its renderer among them) and the worker's own. */
export interface WorkerPorts extends EnginePorts {
  recordWindow: RecordWindow;
  /** What a library preview job's disk gate reads. */
  freeBytes: FreeBytes;
  processes: JobProcesses;
}

/** The ports a composition root hands a worker: any of them, and any member of the job processes. */
export type WorkerPortsGiven = Partial<Omit<WorkerPorts, 'processes'>> & { processes?: Partial<JobProcesses> };

/**
 * Which ports a heavy job reads (true) — in its job process, which is a composition root of its own and cannot be
 * handed an object, so it reads the product's. Every port of the bag is listed (typed over WorkerPorts, so a port
 * added to EnginePorts must be said here): the record window and the job processes are the worker's own, and the
 * environment reaches the job process (the heavy slot starts it with the worker's ports env: worker-heavy.ts).
 */
export const HEAVY_JOB_PORTS = {
  clock: true,
  stores: true,
  reads: true,
  hooks: true,
  reviewer: true,
  capture: true,
  sandboxes: true,
  queues: true,
  renderer: true,
  env: false,
  secrets: true,
  freeBytes: true,
  recordWindow: false,
  processes: false,
} as const satisfies Record<keyof WorkerPorts, boolean>;

/** The heavy-job ports a composition root handed (HEAVY_JOB_PORTS), by name. */
export function heavyPortsGiven(given: WorkerPortsGiven): string[] {
  return (Object.keys(HEAVY_JOB_PORTS) as (keyof WorkerPorts)[]).filter((k) => HEAVY_JOB_PORTS[k] && given[k] !== undefined);
}

/**
 * The engine's ports and the worker's given, the product's for the others. `heavyInProcess` (WorkerOptions) is the
 * mode, stated by the root: a worker handed a port a heavy job reads without it is refused — its heavy jobs would run
 * in a job process on the product's ports, beside a worker on others (two workspaces, two queues, two clocks).
 */
export function workerPorts(engine: EnginePorts, given: WorkerPortsGiven = {}, dirs: ReturnType<typeof buildDirs>, heavyInProcess = false): WorkerPorts {
  const handed = heavyPortsGiven(given);
  if (handed.length > 0 && !heavyInProcess) {
    throw new Error(`a jobs worker handed its own ${handed.join(', ')} must run its heavy jobs in its own process (heavyInProcess): a job process reads the product's ports`);
  }
  const p = given.processes ?? {};
  return {
    ...engine,
    recordWindow: given.recordWindow ?? {},
    freeBytes: given.freeBytes ?? freeBytesOf,
    processes: {
      command: p.command ?? ((job) => jobProcessCommand(job.root, { id: job.id, kind: job.kind, build: job.build, supervisor: job.supervisor, digest: job.digest })),
      kill: p.kill ?? processKill,
      qos: p.qos ?? {},
      buildStamp: p.buildStamp ?? (() => buildStamp(dirs)),
    },
  };
}
