/**
 * Where a workspace keeps its machine-local state: `<workspace>/.retake` (git-ignored) and the job queue's folder in it.
 * A module of its own, imported by whatever keeps a file there (the history, the worker lock, the discovery files, the
 * index, the capture id, the file job queue), so none of them imports the queue for a path.
 */
import { join } from 'node:path';

/** <workspace>/.retake: machine-local state of a workspace (git-ignored). */
export function stateDir(root: string): string {
  return join(root, '.retake');
}

/** <workspace>/.retake/jobs: the file job queue's folder (jobs/queue.ts). */
export function jobsDir(root: string): string {
  return join(stateDir(root), 'jobs');
}
