/**
 * This engine's copy of Retake against the others on the machine: the worker of another copy (the app and a checkout,
 * two apps), the engine installed since this process loaded its modules, a client started outside the workspace — what
 * engine_info says (operations/project.ts), read here so that the operation reads nothing itself.
 */
import { pathInside } from '@retake/core/base';
import { engineLocation, realpathOr, staleEngine } from '@retake/core/io';
import type { StaleEngine } from '@retake/core/io';
import { otherCopy } from './jobs/lock.js';
import type { WorkerLockRecord } from './jobs/lock.js';

/** The live worker when it runs another copy of Retake than this process's engine (version `version`), else null. */
export function workerOfAnotherCopy(held: WorkerLockRecord | null, version: string): ReturnType<typeof otherCopy> {
  return otherCopy(held, { engine: engineLocation(), version });
}

/** This process's engine (version `running`) against the one installed now: null when they match or it cannot be read. */
export function staleThisEngine(running: string): StaleEngine | null {
  return staleEngine(running);
}

/** Whether folder `dir` is outside the workspace `root` (both compared by their real paths when they exist). */
export function outsideWorkspace(dir: string, root: string): boolean {
  return !pathInside(dir, root, { real: (x: string) => realpathOr(x, x), dotDotPrefix: true });
}
