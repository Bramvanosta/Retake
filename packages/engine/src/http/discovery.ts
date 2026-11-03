/**
 * The discovery file of a workspace's Studio server (L4.1; BACKLOG guard-rail "/v1 + capabilities + discovery file"):
 * `<workspace>/.retake/ui.json` says which process serves the workspace, on which port, with which token — so a
 * second `retake ui` reopens the running one instead of starting another, and the macOS shell (L5.2) finds it.
 *
 * Critique B8: the file is claimed after the server is bound, exclusively — a 0600 temporary file (chmod: the umask
 * never widens it) hard-linked into place, so two servers starting together never both win; on EEXIST the holder is
 * checked (pid AND start time, as the worker lock) and reused when alive, replaced once when stale. A reader trusts
 * the file only when it is a regular file of this user with no group or other permission bits; anything else is
 * refused, never followed. The token in it gives nothing beyond what an agent of this workspace already has (the
 * Studio's ops run under the agent's trust).
 */
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EngineError } from '../errors.js';
import { isAlive } from '../jobs/proc.js';
import { stateDir } from '../jobs/queue.js';

export const DISCOVERY_VERSION = 1;

export interface DiscoveryRecord {
  version: typeof DISCOVERY_VERSION;
  /** What serves: the Studio app (`ui`). */
  kind: 'ui';
  pid: number;
  /** The process's start time (ISO, from ps): a reused pid never passes for the holder. */
  started_at?: string;
  port: number;
  /** The server's address, without any secret: `http://127.0.0.1:<port>/`. */
  url: string;
  /** The bearer token of the server's API. */
  token: string;
  /** When it started serving (ISO). */
  since: string;
  /** The build that serves (jobs build stamp). */
  build?: string;
}

/** `<workspace>/.retake/ui.json`. */
export function discoveryFile(root: string): string {
  return join(stateDir(root), 'ui.json');
}

function parseRecord(text: string): DiscoveryRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const r = v as Partial<DiscoveryRecord> | null;
  const ok =
    !!r &&
    typeof r === 'object' &&
    r.version === DISCOVERY_VERSION &&
    r.kind === 'ui' &&
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    (r.port as number) <= 65535 &&
    r.url === `http://127.0.0.1:${r.port}/` &&
    typeof r.token === 'string' &&
    /^[A-Za-z0-9_-]{32,512}$/.test(r.token) &&
    typeof r.since === 'string' &&
    (r.started_at === undefined || typeof r.started_at === 'string') &&
    (r.build === undefined || typeof r.build === 'string');
  return ok ? (r as DiscoveryRecord) : null;
}

/**
 * The record of a discovery file: null when there is none, or when it is not a valid record (a stale or broken file
 * the next claim replaces). Refused when the file is a link, not a regular file, another user's, or readable or
 * writable by group or others.
 */
export async function readDiscovery(file: string): Promise<DiscoveryRecord | null> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const uid = process.getuid?.();
  const unsafe = !st.isFile() ? 'is not a regular file' : uid !== undefined && st.uid !== uid ? 'belongs to another user' : (st.mode & 0o077) !== 0 ? `has permissions ${(st.mode & 0o777).toString(8)} (expected 600)` : undefined;
  if (unsafe) throw new EngineError('refused', `${file} ${unsafe}: not trusted`, { fix: `remove ${file} (no Studio server is using it safely), then run retake ui again` });
  return parseRecord(await readFile(file, 'utf8'));
}

/** Is the holder of a record still running (same pid, same start time)? */
export async function holderAlive(r: DiscoveryRecord): Promise<boolean> {
  return isAlive({ pid: r.pid, ...(r.started_at ? { started_at: r.started_at } : {}) });
}

export type DiscoveryClaim = { claimed: true } | { claimed: false; holder: DiscoveryRecord };

/**
 * Claim the discovery file for `record` (the caller already listens on its port). `{claimed: false, holder}` when a
 * live server holds it (the caller closes its own listener and reuses that one); a stale or broken file is replaced
 * once. Never chmods the shared `.retake/` folder. Known residue: two servers replacing the same stale file at
 * the same instant can both win (one unlinks the other's fresh file) — two servers, no corruption.
 */
export async function claimDiscovery(file: string, record: DiscoveryRecord): Promise<DiscoveryClaim> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A workspace state folder this user cannot write (review B L3): a refusal that says what to do, not a stack.
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new EngineError('refused', `${dirname(file)} is not writable (${code}): retake ui records the server it starts there`, {
        fix: code === 'EROFS' ? 'run retake ui on a workspace on a writable disk' : `make it writable for you (chmod u+w ${dirname(file)}), or run retake ui as the user who owns the workspace`,
      });
    }
    throw e;
  }
  try {
    await chmod(tmp, 0o600);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(tmp, file);
        return { claimed: true };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = await readDiscovery(file);
      if (holder && (await holderAlive(holder))) return { claimed: false, holder };
      await unlink(file).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    throw new EngineError('busy', `${file}: another Studio server claimed it at the same time`, { fix: 'run retake ui again' });
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Remove the discovery file when it is still `record`'s (never a successor's) — whatever its mode now (review B L8: a
 * file made 0644 while the server ran would otherwise stay, and refuse every later start). Only a regular file of this
 * user holding exactly this record (pid and token) is removed.
 */
export async function releaseDiscovery(file: string, record: DiscoveryRecord): Promise<void> {
  try {
    const st = await lstat(file);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return;
    const current = parseRecord(await readFile(file, 'utf8'));
    if (current && current.pid === record.pid && current.token === record.token) await unlink(file);
  } catch {
    // gone already, or unreadable: nothing of ours to remove
  }
}
