/**
 * The Retake home's signing key (L3.1, shared since L5.14): an HMAC-SHA256 key in `<RETAKE_HOME>/approvals.key` (64 hex
 * characters, 0600, its folder 0700, created whole on first use). Job approvals (engine signing.ts) and the entries of the
 * hooks rollback journals (hooks journal.ts) are signed with it when written; whatever is read back without a valid
 * signature was not written by Retake with this home — a file placed by another process or a file-writing tool.
 *
 * The key protects against files forged without access to the home folder; whoever can read the home folder can sign.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { retakeHome } from './home.js';

export const HOME_KEY_FILE = 'approvals.key';

export function homeKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(retakeHome(env), HOME_KEY_FILE);
}

/** The key, or undefined when there is none (or it is not a key): nothing is created. */
export async function readHomeKey(file: string = homeKeyFile()): Promise<Buffer | undefined> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined;
  } catch {
    return undefined;
  }
}

/** The key's folder closed to the group and others when the key is made (an existing home made earlier 0755 too) — never the account's own home folder. */
async function tighten(dir: string): Promise<void> {
  if (resolve(dir) === resolve(homedir())) return;
  const st = await stat(dir).catch(() => undefined);
  if (st && (st.mode & 0o077) !== 0) await chmod(dir, 0o700).catch(() => undefined);
}

/**
 * The key, created (0600, its folder 0700) when there is none yet. Made whole before it appears (review A L2): written
 * to a temporary file, then linked into place — a reader never sees a partial key, and of two processes making it at
 * once the second reads the first one's.
 */
export async function homeKey(file: string = homeKeyFile()): Promise<Buffer> {
  const existing = await readHomeKey(file);
  if (existing) return existing;
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tighten(dir);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tmp, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await link(tmp, file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EEXIST: another process made it first (it is read below). A file system without hard links: created exclusively.
    if (code !== 'EEXIST') {
      try {
        await writeFile(file, await readFile(tmp), { flag: 'wx', mode: 0o600 });
      } catch (w) {
        if ((w as NodeJS.ErrnoException).code !== 'EEXIST') throw w;
      }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
  await chmod(file, 0o600).catch(() => undefined);
  // Made by another process without hard links: being written for a moment.
  for (let i = 0; i < 10; i++) {
    const key = await readHomeKey(file);
    if (key) return key;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${file} is not a signing key (64 hex characters): remove it, a new one is created`);
}

/** HMAC-SHA256 of a text, hex. */
export function homeSign(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

/** Whether `sig` is the HMAC of `text` with `key` (constant time; a missing or malformed signature is not). */
export function homeSigned(key: Buffer | undefined, text: string, sig: unknown): boolean {
  if (!key || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(homeSign(key, text), 'hex'));
}
