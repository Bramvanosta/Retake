import { join } from 'node:path';
import { STATE_DIR, STATE_DIRS, relativeInside } from '@retake/core';

/** Where a project keeps its sandboxes' state, lock, seed journal and service logs (git-ignored: `.retake/`). */
export const SANDBOX_STATE_DIR = join(STATE_DIR, STATE_DIRS.sandbox);

/** The files of one sandbox: `<project>/.retake/sandbox/<env>/…`. */
export interface SandboxPaths {
  dir: string;
  state: string;
  lock: string;
  seedJournal: string;
  logs: string;
}

export function sandboxPaths(projectDir: string, env: string): SandboxPaths {
  const dir = join(projectDir, SANDBOX_STATE_DIR, env);
  return { dir, state: join(dir, 'state.json'), lock: join(dir, 'take.lock'), seedJournal: join(dir, 'seed-journal.json'), logs: join(dir, 'logs') };
}

/** A service's log file (the previous one is `<file>.1`). */
export function serviceLog(paths: SandboxPaths, service: string): string {
  return join(paths.logs, `${service}.log`);
}

/** A path as messages show it: relative to the working directory when inside it, else absolute. */
export function shownPath(file: string, cwd: string = process.cwd()): string {
  return relativeInside(file, cwd, { self: false, dotDotPrefix: true }) ?? file;
}
