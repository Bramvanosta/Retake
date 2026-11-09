/**
 * Where a workspace's Studio server is found (L4.1; BACKLOG guard-rail "/v1 + capabilities + discovery file"), in two
 * files, so that a second `retake ui` reopens the running server instead of starting another (the macOS app's
 * `retake ui --supervised` too):
 *
 * - The discovery record `<workspace>/.retake/ui.json` says which process serves the workspace and on which port —
 *   pid, start time, port, URL, nothing secret. It is the workspace's lock: claimed after the server is bound,
 *   exclusively (critique B8) — a 0600 temporary file (chmod: the umask never widens it) hard-linked into place, so two
 *   servers starting together never both win; on EEXIST the holder is checked (pid AND start time, as the worker lock)
 *   and reused when alive, replaced once when stale. A reader trusts the file only when it is a regular file of this
 *   user with no group or other permission bits; anything else is refused, never followed.
 * - The token record `<Retake home>/ui/<sha256 of the workspace's real path, 16 hex>.token` holds the server's bearer
 *   token with the pid, start time and port it belongs to: one 0600 file per workspace, written and read like the token
 *   of MCP over HTTP (token-file.ts: a link, another owner or group / other bits are refused). A second `retake ui`
 *   takes the port and the token from there, never from the workspace, so a record rewritten in the workspace never
 *   receives the token.
 *
 * What the token's place protects against: a process that can write or read the workspace and nothing else (an agent
 * confined to the workspace folder, a synced or shared copy of it) learns no secret from `.retake/` and cannot make
 * `retake ui` send the token to a port of its choosing. It does not protect against a process of this user that reads
 * the Retake home: that process is the person (it can read the MCP HTTP token and the signed-in profiles there too).
 *
 * A record of an older Retake (version 1, which also held the token) is read for its holder only: its token is never
 * used — a live holder is named (stop it, then run retake ui again), a dead one replaced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { retakeHome } from '@retake/core';
import { EngineError } from '../errors.js';
import { isAlive } from '../jobs/proc.js';
import { stateDir } from '../jobs/queue.js';
import { privateFileProblem, readPrivateText, replacePrivateFile } from './token-file.js';

/** The version this build writes; a record of version 1 was written by an older Retake (with its token, never read). */
export const DISCOVERY_VERSION = 2;

export interface DiscoveryRecord {
  /** DISCOVERY_VERSION, or 1: an older Retake's server (its token, in that file, is never read). */
  version: typeof DISCOVERY_VERSION | 1;
  /** What serves: the Studio app (`ui`). */
  kind: 'ui';
  pid: number;
  /** The process's start time (ISO, from ps): a reused pid never passes for the holder. */
  started_at?: string;
  port: number;
  /** The server's address, without any secret: `http://127.0.0.1:<port>/`. */
  url: string;
  /** When it started serving (ISO). */
  since: string;
  /** The build that serves (jobs build stamp). */
  build?: string;
}

/** `<workspace>/.retake/ui.json`. */
export function discoveryFile(root: string): string {
  return join(stateDir(root), 'ui.json');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;
const RECORD_KEYS = ['version', 'kind', 'pid', 'started_at', 'port', 'url', 'since', 'build'] as const;

/** The record's own fields, in order: nothing else (a token above all) is ever written to the workspace. */
function recordText(r: DiscoveryRecord): string {
  const out: Record<string, unknown> = {};
  for (const k of RECORD_KEYS) if (r[k] !== undefined) out[k] = r[k];
  return `${JSON.stringify(out, null, 2)}\n`;
}

function parseRecord(text: string): DiscoveryRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const r = v as (Partial<DiscoveryRecord> & { token?: unknown }) | null;
  const ok =
    !!r &&
    typeof r === 'object' &&
    // A current record holds no token; an older one (version 1) always did.
    ((r.version === DISCOVERY_VERSION && !('token' in r)) || (r.version === 1 && typeof r.token === 'string' && TOKEN_RE.test(r.token))) &&
    r.kind === 'ui' &&
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    (r.port as number) <= 65535 &&
    r.url === `http://127.0.0.1:${r.port}/` &&
    typeof r.since === 'string' &&
    (r.started_at === undefined || typeof r.started_at === 'string') &&
    (r.build === undefined || typeof r.build === 'string');
  if (!ok) return null;
  const out = {} as Record<string, unknown>;
  for (const k of RECORD_KEYS) if (r[k] !== undefined) out[k] = r[k];
  return out as unknown as DiscoveryRecord;
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
  const unsafe = privateFileProblem(st);
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
    await writeFile(tmp, recordText(record), { mode: 0o600, flag: 'wx' });
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

/** Does `a` name the same serving as `b` (pid, start time, port, since)? */
function sameServing(a: Pick<DiscoveryRecord, 'pid' | 'started_at' | 'port'> & { since?: string }, b: Pick<DiscoveryRecord, 'pid' | 'started_at' | 'port'> & { since?: string }): boolean {
  return a.pid === b.pid && a.started_at === b.started_at && a.port === b.port && (a.since === undefined || b.since === undefined || a.since === b.since);
}

/**
 * Remove the discovery file when it is still `record`'s (never a successor's) — whatever its mode now (review B L8: a
 * file made 0644 while the server ran would otherwise stay, and refuse every later start). Only a regular file of this
 * user holding exactly this record (pid, start time, port and since) is removed.
 */
export async function releaseDiscovery(file: string, record: DiscoveryRecord): Promise<void> {
  try {
    const st = await lstat(file);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return;
    const current = parseRecord(await readFile(file, 'utf8'));
    if (current && current.version === DISCOVERY_VERSION && sameServing(current, record)) await unlink(file);
  } catch {
    // gone already, or unreadable: nothing of ours to remove
  }
}

/** The token record of a workspace's Studio server, in the Retake home (never in the workspace). */
export interface StudioTokenRecord {
  version: 1;
  /** The workspace's real path (the file's name is its hash). */
  root: string;
  pid: number;
  started_at?: string;
  /** The port the token is for: a second `retake ui` sends the token there and nowhere else. */
  port: number;
  /** The bearer token of the server's API. */
  token: string;
}

/** The folder of the Studio token records: `<Retake home>/ui`. */
export function studioTokenDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(retakeHome(env), 'ui');
}

/** The workspace's real path (its path when it cannot be resolved): one token file per workspace, whatever link names it. */
async function realRoot(root: string): Promise<string> {
  return realpath(root).catch(() => resolve(root));
}

/** `<Retake home>/ui/<sha256 of the workspace's real path, 16 hex>.token`. */
export async function studioTokenFile(root: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const real = await realRoot(root);
  return join(studioTokenDir(env), `${createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 16)}.token`);
}

const tokenFix = (file: string) => `remove ${file} (no Studio server uses it safely), then run retake ui again`;

/**
 * The token record in `file` for the workspace `root`: null when there is none, when it is not a valid record or when
 * it names another workspace. Refused (`refused`) when the file is a link, not a regular file, another user's, or
 * readable or writable by group or others.
 */
export async function readStudioToken(file: string, root: string): Promise<StudioTokenRecord | null> {
  const text = await readPrivateText(file, tokenFix(file));
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const r = v as Partial<StudioTokenRecord> | null;
  const ok =
    !!r &&
    typeof r === 'object' &&
    r.version === 1 &&
    r.root === (await realRoot(root)) &&
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    (r.started_at === undefined || typeof r.started_at === 'string') &&
    Number.isInteger(r.port) &&
    (r.port as number) > 0 &&
    (r.port as number) <= 65535 &&
    typeof r.token === 'string' &&
    TOKEN_RE.test(r.token);
  return ok ? { version: 1, root: r.root as string, pid: r.pid as number, ...(r.started_at ? { started_at: r.started_at } : {}), port: r.port as number, token: r.token as string } : null;
}

/** The token record of the server `serving` (pid, start time, port) of `root`, for `file` (0600, atomically replaced). */
export async function writeStudioToken(file: string, root: string, serving: Pick<DiscoveryRecord, 'pid' | 'started_at' | 'port'>, token: string): Promise<StudioTokenRecord> {
  const record: StudioTokenRecord = { version: 1, root: await realRoot(root), pid: serving.pid, ...(serving.started_at ? { started_at: serving.started_at } : {}), port: serving.port, token };
  await replacePrivateFile(file, `${JSON.stringify(record, null, 2)}\n`, tokenFix(file));
  return record;
}

/** Is the holder of a token record still running (same pid, same start time)? */
export async function tokenHolderAlive(r: StudioTokenRecord): Promise<boolean> {
  return isAlive({ pid: r.pid, ...(r.started_at ? { started_at: r.started_at } : {}) });
}

/** Remove the token record when it is still `record`'s (same serving, same token): a successor's file stays. */
export async function releaseStudioToken(file: string, record: StudioTokenRecord): Promise<void> {
  try {
    const st = await lstat(file);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) return;
    const current = JSON.parse(await readFile(file, 'utf8')) as Partial<StudioTokenRecord>;
    if (current.token === record.token && sameServing(current as StudioTokenRecord, record)) await unlink(file);
  } catch {
    // gone already, or unreadable: nothing of ours to remove
  }
}
