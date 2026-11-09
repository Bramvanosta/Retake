/**
 * Locks of a project's files (L3.6 comment threads; L4.3 critique B1: every `if_match` write of `writeText`): a lock
 * file under `<project>/.retake/locks/`, the sandbox package's TakeLock — created whole, stale only when its
 * process is gone (never by age) —, retried while a live process holds it, for at most `waitMs`. One process and
 * several (the Studio, `retake mcp`, a terminal) share it: two writers that read the same version can no longer both
 * pass their `if_match` check and rename one after the other (the last rename silently won).
 */
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isIsoUtcDate, printableText, pathInside } from '@retake/core';
import { TakeLock, readLock } from '@retake/sandbox';
import type { LockRecord } from '@retake/sandbox';
import { EngineError } from './errors.js';

/** Between two tries of a busy lock (ms), by default. */
const LOCK_RETRY_MS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** lstat, or null when it does not exist. */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw e;
  }
}

/** A real folder (not a link) at `path`: 'ok', 'missing', or why not. */
async function realDir(path: string): Promise<'ok' | 'missing' | 'a symbolic link' | 'not a folder'> {
  const st = await lstatOrNull(path);
  if (!st) return 'missing';
  if (st.isSymbolicLink()) return 'a symbolic link';
  return st.isDirectory() ? 'ok' : 'not a folder';
}

/**
 * `<project>/.retake/<sub>/`, made of real folders of the project: each level checked before it is created (never
 * through a symbolic link: a lock, its temp and breaker files, or a still would land outside), then its real path
 * checked inside the project. Throws EngineError refused.
 */
export async function toolDir(projectDir: string, sub: string): Promise<string> {
  let dir = projectDir;
  for (const part of ['.retake', sub]) {
    dir = join(dir, part);
    let state = await realDir(dir);
    if (state === 'missing') {
      await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
      });
      state = await realDir(dir);
    }
    if (state !== 'ok') throw new EngineError('refused', `${relative(projectDir, dir)}/ is ${state}: remove it (the tool makes it again)`);
  }
  const [realProject, realSub] = await Promise.all([realpath(projectDir), realpath(dir)]);
  if (!pathInside(realSub, realProject, { dotDotPrefix: true })) throw new EngineError('refused', `${relative(projectDir, dir)}/ leads out of the project folder`);
  return dir;
}

/** What a busy refusal may quote of the holder (the lock file is agent-writable): its pid, a well-formed date, its command (printable, ≤ 80). */
export function lockHolder(held: LockRecord | null): { pid?: number; since?: string; command: string } {
  const pid = held && Number.isInteger(held.pid) && held.pid > 0 ? held.pid : undefined;
  const since = held && isIsoUtcDate(held.since) ? held.since : undefined;
  const command = held && typeof held.command === 'string' ? printableText(held.command).slice(0, 80) : '';
  return { ...(pid ? { pid } : {}), ...(since ? { since } : {}), command };
}

/**
 * Take `<project>/.retake/locks/<name>`: retried while a live process holds it (≤ `waitMs`), a dead holder's is
 * broken; then `busy(file, held)` is thrown. The lock folder is a real folder of the project (toolDir); anything but a
 * file at the lock path is refused (`what` names it: "comment c_…", "scenarios/quote.yaml").
 */
export async function takeProjectLock(
  projectDir: string,
  name: string,
  o: { command: string; what: string; waitMs: number; retryMs?: number; busy: (ref: string, held: LockRecord | null) => EngineError },
): Promise<TakeLock> {
  const file = join(await toolDir(projectDir, 'locks'), name);
  const ref = relative(projectDir, file);
  const deadline = Date.now() + o.waitMs;
  for (;;) {
    const st = await lstatOrNull(file);
    if (st && !st.isFile()) {
      throw new EngineError('refused', `${ref} is ${st.isSymbolicLink() ? 'a symbolic link' : 'not a file'}: ${o.what} cannot be locked`, { fix: `remove ${ref} (no retake command makes one)` });
    }
    try {
      return TakeLock.acquire(file, o.command, o.what);
    } catch (e) {
      if (!(e instanceof Error && e.name === 'SandboxError' && (e as { code?: string }).code === 'busy')) throw e;
      if (Date.now() >= deadline) throw o.busy(ref, readLock(file));
      await sleep(o.retryMs ?? LOCK_RETRY_MS);
    }
  }
}
