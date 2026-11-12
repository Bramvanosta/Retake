/** Where the repository is and whether this machine has a tool: what the tests of every package start from. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository's root (with a trailing slash). */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url));
/** The starter themes of the repository. */
export const TEMPLATES = join(REPO, 'templates');

/** Whether a program answers `-version` on this machine (ffmpeg, ffprobe: the tests that need one skip without it). */
export function hasTool(name: string): boolean {
  return spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0;
}
