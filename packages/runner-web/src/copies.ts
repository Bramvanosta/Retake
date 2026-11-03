/**
 * Browser profiles this process made in the system temp folder (L1.6): the session copies of runs and `retake login`
 * checks, the login profiles, and the throwaway profiles of browsers without a persona profile — a storage_state
 * persona's cookies end up in that one. A hard interrupt removes them (removeSessionCopiesSync); a killed process leaves
 * them to the next sweep (auth.ts sweepStaleSessionCopies). Its own module: session.ts and auth.ts both use it.
 */
import { existsSync, rmSync } from 'node:fs';

/** Name prefixes of the folders made in the system temp folder: session copies, login profiles, throwaway profiles. */
export const SESSION_COPY_PREFIXES: readonly string[] = ['retake-session-', 'retake-login-', 'retake-profile-'];
/** A copy left this long (no browser on it) is stale: its process was killed before it could remove it. */
export const STALE_COPY_AGE_MS = 10 * 60_000;

/** The copies this process made and has not removed yet (removeSessionCopiesSync). */
const liveCopies = new Set<string>();

/** Remember a session copy of this process, until it is removed (a hard interrupt removes it: removeSessionCopiesSync). */
export function registerSessionCopy(dir: string): void {
  for (const d of liveCopies) if (!existsSync(d)) liveCopies.delete(d);
  liveCopies.add(dir);
}

/** Whether this process made that folder and still has it (a sweep never takes it). */
export function isLiveCopy(dir: string): boolean {
  return liveCopies.has(dir);
}

/**
 * Remove, synchronously, every session copy this process made and still has (they hold a persona's cookies): for a
 * signal handler about to end the process — a second Ctrl-C, a CLI command interrupted. Returns how many were removed.
 */
export function removeSessionCopiesSync(): number {
  let n = 0;
  for (const d of liveCopies) {
    try {
      if (existsSync(d)) {
        rmSync(d, { recursive: true, force: true });
        n++;
      }
    } catch {
      /* best effort: the next sweep takes it */
    }
  }
  liveCopies.clear();
  return n;
}
