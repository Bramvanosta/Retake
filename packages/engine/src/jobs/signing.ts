/**
 * Approvals signed at submit (L3.1). A job's `approvals` let the worker run hooks a human approved; a job.json written
 * into .demo-studio/jobs/ by anything but a submit (another process, a file-writing tool of the agent) must not carry
 * approvals the worker honours. So each approval is signed at enqueue with an HMAC-SHA256 key kept in the studio home
 * ($DEMO_STUDIO_HOME, else ~/.demo-studio: approvals.key, 0600, created on the first approval), over the job's input and
 * the approval; the worker ignores an approval whose signature is missing or wrong (its hook is then refused).
 *
 * The key protects against a job file forged without access to the home folder; whoever can read the home folder (the
 * sessions live there too) can sign.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { studioHome } from '@demo-studio/core';
import type { JobApproval, JobInput } from '@demo-studio/core';

export const APPROVAL_KEY_FILE = 'approvals.key';

export function approvalKeyFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(studioHome(env), APPROVAL_KEY_FILE);
}

async function readKey(file: string): Promise<Buffer | undefined> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : undefined;
  } catch {
    return undefined;
  }
}

/** The signing key, created (0600, its folder 0700) when there is none yet. */
async function signingKey(file: string): Promise<Buffer> {
  const existing = await readKey(file);
  if (existing) return existing;
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  await chmod(file, 0o600).catch(() => undefined);
  const key = await readKey(file);
  if (!key) throw new Error(`${file} is not a signing key (64 hex characters): remove it, a new one is created`);
  return key;
}

/** JSON with object keys sorted at every depth. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What an approval's signature covers: the whole job input (but its approvals) and the approval itself. */
function payload(input: JobInput, a: JobApproval): string {
  const { approvals: _a, ...rest } = input;
  return canonical({ v: 1, input: rest, approval: { fingerprint: a.fingerprint, by: a.by, at: a.at } });
}

function sign(key: Buffer, input: JobInput, a: JobApproval): string {
  return createHmac('sha256', key).update(payload(input, a)).digest('hex');
}

/** The input with each approval signed (unchanged when it has none: no key is created). */
export async function signApprovals<T extends JobInput>(input: T, keyFile = approvalKeyFile()): Promise<T> {
  if (!input.approvals?.length) return input;
  const key = await signingKey(keyFile);
  return { ...input, approvals: input.approvals.map((a) => ({ ...a, sig: sign(key, input, a) })) };
}

/** The approvals of a job the worker honours: those signed with this home's key; `rejected` counts the others. */
export async function verifiedApprovals(input: JobInput, keyFile = approvalKeyFile()): Promise<{ approvals: JobApproval[]; rejected: number }> {
  const all = input.approvals ?? [];
  if (!all.length) return { approvals: [], rejected: 0 };
  const key = await readKey(keyFile);
  const approvals = all.filter((a) => {
    if (!key || typeof a.sig !== 'string' || !/^[0-9a-f]{64}$/.test(a.sig)) return false;
    return timingSafeEqual(Buffer.from(a.sig, 'hex'), Buffer.from(sign(key, input, a), 'hex'));
  });
  return { approvals, rejected: all.length - approvals.length };
}
