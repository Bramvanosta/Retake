/**
 * The jobs worker's ports (L7.29, P6): the engine's (ports.ts EnginePorts) and the four only a worker has — what render,
 * export and preview jobs render with, the window a `record` job opens for a person, the free space a library preview
 * job reads, and the job processes of its heavy slot (their command line, the signals sent to them, their background
 * priority, the build stamp the worker compares while idle). `workerPorts` is where those four's defaults are written
 * (the product's adapters; the engine's are ports.ts enginePorts', which runWorker hands it). A composition root (worker-main through runWorker, an in-process test) hands any of them in
 * `WorkerOptions.ports`; the worker record and the job runner hold no test hook.
 */
import { editorRenderer } from '../render/editor-renderer.js';
import type { Renderer } from '../render/renderer.js';
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

/** Every port a jobs worker runs with. */
export interface WorkerPorts extends EnginePorts {
  /** What render, export and preview jobs render with (render/renderer.ts; default the editor's driver). */
  renderer: Renderer;
  recordWindow: RecordWindow;
  /** What a library preview job's disk gate reads. */
  freeBytes: FreeBytes;
  processes: JobProcesses;
}

/** The ports a composition root hands a worker: any of them, and any member of the job processes. */
export type WorkerPortsGiven = Partial<Omit<WorkerPorts, 'processes'>> & { processes?: Partial<JobProcesses> };

/**
 * The ports a heavy job reads in its job process. Handed any of them (an object, which cannot reach a job process),
 * the worker runs heavy jobs in its own process, one job at a time, as before L5.14 (no capture beside them, no yield);
 * the record window and the job processes are the worker's own and change nothing of that.
 */
const HEAVY_JOB_PORTS = ['clock', 'stores', 'hooks', 'reviewer', 'capture', 'sandboxes', 'renderer', 'freeBytes'] as const satisfies ReadonlyArray<keyof WorkerPorts>;

/** The engine's ports and the worker's given, the product's for the others; and whether heavy jobs then run in this process. */
export function workerPorts(engine: EnginePorts, given: WorkerPortsGiven = {}, dirs: ReturnType<typeof buildDirs>): { ports: WorkerPorts; heavyInProcess: boolean } {
  const p = given.processes ?? {};
  const ports: WorkerPorts = {
    ...engine,
    renderer: given.renderer ?? editorRenderer(),
    recordWindow: given.recordWindow ?? {},
    freeBytes: given.freeBytes ?? freeBytesOf,
    processes: {
      command: p.command ?? ((job) => jobProcessCommand(job.root, { id: job.id, kind: job.kind, build: job.build, supervisor: job.supervisor, digest: job.digest })),
      kill: p.kill ?? processKill,
      qos: p.qos ?? {},
      buildStamp: p.buildStamp ?? (() => buildStamp(dirs)),
    },
  };
  return { ports, heavyInProcess: HEAVY_JOB_PORTS.some((k) => given[k] !== undefined) };
}
