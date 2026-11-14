/**
 * The versions of a renders folder, on the Outputs port (its `renders` member): which versions of a scenario its files
 * take, the next free one, its lock file, and a version reserved and released. A version is at most
 * RENDER_VERSION_MAX: when a file already claims that version or more, nothing is handed out and the refusal names the
 * file, so that two renders never get the same id. A refusal is the editor's render error (what a client is told:
 * `invalid`), as it always was.
 */
import { join } from 'node:path';
import { RENDER_VERSION_MAX, renderFileVersionOf, renderLockName, renderSuffix } from '@retake/core/ids';
import { projectRef } from '@retake/core/project';
import type { RenderOutputs } from '../outputs/outputs.js';
import { renderErrors } from './editor-calls.js';

/** The files of `dir` that take a version of `name` (core renderFileVersionOf), in name order. */
async function versionFiles(renders: RenderOutputs, dir: string, name: string): Promise<Array<{ file: string; version: number }>> {
  const taken: Array<{ file: string; version: number }> = [];
  const versionOf = renderFileVersionOf(name);
  for (const file of (await renders.names(dir)).sort()) {
    const version = versionOf(file);
    if (version !== null) taken.push({ file, version });
  }
  return taken;
}

/** Versions already taken (sorted, unique) by `<name>-v<N>[-vertical|-square].{mp4,json}` and pending `.<name>-v<N>.lock` files. */
export async function takenVersions(renders: RenderOutputs, dir: string, name: string): Promise<number[]> {
  return [...new Set((await versionFiles(renders, dir, name)).map((t) => t.version))].sort((a, b) => a - b);
}

/**
 * The next free version of `name` in `dir`: 1 + the highest version there (renders, records and pending locks), at
 * most RENDER_VERSION_MAX. When a file already claims that version or more — whatever number its digits read as —
 * nothing is handed out: the refusal names the file.
 */
export async function nextVersion(renders: RenderOutputs, dir: string, name: string): Promise<number> {
  let top: { file: string; version: number } | undefined;
  for (const t of await versionFiles(renders, dir, name)) if (!top || t.version > top.version) top = t;
  if (!top) return 1;
  if (!(top.version < RENDER_VERSION_MAX)) {
    const written = renderSuffix(top.file.slice(0, top.file.lastIndexOf('.')))?.digits ?? String(top.version);
    throw await renderErrors.render(
      `${projectRef('renders')}/ holds ${top.file}, which claims version ${written} of ${name}: the highest version is ${RENDER_VERSION_MAX}. Remove or rename that file, then render again.`,
    );
  }
  return top.version + 1;
}

/**
 * The lock file that reserves version `version` of `name` in `dir` (`.<name>-v<N>.lock`); a RangeError for a version
 * that is not a whole number from 0 to RENDER_VERSION_MAX (core renderLockName).
 */
export function versionLockFile(dir: string, name: string, version: number): string {
  return join(dir, renderLockName(name, version));
}

/** A version reserved: its number, and the release of its lock. */
export interface ReservedVersion {
  version: number;
  release: () => Promise<void>;
}

/**
 * Reserve the next free version (an exclusive `.<name>-v<N>.lock` file, so two renders of the same scenario never
 * pick the same N). `release()` removes the lock. `owner`: what the lock says holds it (default this process's pid;
 * a render job: who submitted it). Refused as nextVersion refuses (no lock is written).
 */
export async function reserveVersion(renders: RenderOutputs, dir: string, name: string, owner = String(process.pid)): Promise<ReservedVersion> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const version = await nextVersion(renders, dir, name);
    const lock = versionLockFile(dir, name, version);
    try {
      await renders.lock(lock, `${owner}\n`);
      return { version, release: () => renders.remove(lock) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw await renderErrors.render(`could not reserve a render version of ${name} in ${dir}`);
}

/** Free a version reserved before, by its number (a render job cancelled before it started, or failed early). */
export async function releaseVersion(renders: RenderOutputs, dir: string, name: string, version: number): Promise<void> {
  await renders.remove(versionLockFile(dir, name, version));
}
