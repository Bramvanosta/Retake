/**
 * Approvals signed at submit (L3.1), bound to their job (L5.14). A job's `approvals` let the worker run hooks a human
 * approved; a job.json written into .retake/jobs/ by anything but a submit (another process, a file-writing tool of the
 * agent) must not carry approvals the worker honours. So each approval is signed at enqueue with the Retake home's key
 * (core home-key.ts: `<RETAKE_HOME>/approvals.key`), over the job's id, its input and the approval; the worker ignores
 * an approval whose signature is missing or wrong (its hook is then refused).
 *
 * Approvals are bound to their job: the signature covers the job id and its workspace (the real path of its root): an
 * approval copied into a job of another id, or a job folder copied into another workspace, verifies nothing; the worker consumes a job's approvals when it claims the job (`consumeApprovals`: one file per
 * job id in `<RETAKE_HOME>/approvals-used/`, created once) — a job folder made again under the same id is refused at
 * its claim. The claimed record's digest goes to the job process that runs it (`--digest`), which refuses any other
 * record (job-child.ts).
 *
 * The key protects against a job file forged without access to the home folder; whoever can read the home folder (the
 * sessions live there too) can sign.
 */
import type { EngineEnv } from '../env.js';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalJson } from '@retake/core/base';
import { ULID_PREFIXES, isJobId, ulidTime } from '@retake/core/ids';
import { HOME_KEY_FILE, homeKey, homeKeyFile, homeSign, homeSigned, readHomeKey, retakeHome } from '@retake/core/io';
import type { JobApproval, JobInput } from './job-input.js';

export const APPROVAL_KEY_FILE = HOME_KEY_FILE;
/** `<RETAKE_HOME>/approvals-used/<job id>`: the jobs whose approvals a worker took (claimed). */
export const APPROVALS_USED_DIR = 'approvals-used';
/** A consumed approval's record is kept this long (a job id older than this carries no approval: consumeApprovals). */
export const APPROVALS_USED_KEEP_MS = 365 * 24 * 3600_000;

export function approvalKeyFile(env: EngineEnv): string {
  return homeKeyFile(env);
}

/** The approvals a job input carries (a kind without hooks has none: a render). */
export function approvalsOf(input: JobInput): JobApproval[] | undefined {
  return 'approvals' in input ? input.approvals : undefined;
}

/**
 * What an approval's signature covers: the workspace (the real path of its root), the job id, the whole job input (but
 * its approvals) and the approval itself.
 */
function payload(workspace: string, jobId: string, input: JobInput, a: JobApproval): string {
  const { approvals: _a, ...rest } = input as JobInput & { approvals?: unknown };
  return canonicalJson({ v: 3, workspace, job: jobId, input: rest, approval: { fingerprint: a.fingerprint, by: a.by, at: a.at } });
}

/** The real path of a workspace root (as written when it cannot be resolved). */
async function realRoot(root: string): Promise<string> {
  return realpath(root).catch(() => resolve(root));
}

/** The job and workspace the approvals belong to, and where the key is: the Retake home of `env` (its composition root's, env.ts), or `keyFile`. */
export type SigningOptions = {
  /** The job the approvals belong to (its id, given at enqueue). */
  jobId: string;
  /** The root of the job's workspace (its queue's). */
  root: string;
} & ({ env: EngineEnv; keyFile?: string } | { keyFile: string; env?: EngineEnv });

/** The key's file: the one given, else the Retake home's of the environment given. */
function keyFileOf(o: SigningOptions): string {
  if (o.keyFile !== undefined) return o.keyFile;
  if (o.env === undefined) throw new Error('signing: neither a key file nor an environment was handed');
  return approvalKeyFile(o.env);
}

/** The input with each approval signed for job `jobId` (unchanged when it has none: no key is created). */
export async function signApprovals<T extends JobInput>(input: T, o: SigningOptions): Promise<T> {
  const approvals = approvalsOf(input);
  if (!approvals?.length) return input;
  const key = await homeKey(keyFileOf(o));
  const ws = await realRoot(o.root);
  return { ...input, approvals: approvals.map((a) => ({ ...a, sig: homeSign(key, payload(ws, o.jobId, input, a)) })) };
}

/** The approvals of job `jobId` the worker honours: those signed for it with this home's key; `rejected` counts the others. */
export async function verifiedApprovals(input: JobInput, o: SigningOptions): Promise<{ approvals: JobApproval[]; rejected: number }> {
  const all = approvalsOf(input) ?? [];
  if (!all.length) return { approvals: [], rejected: 0 };
  const key = await readHomeKey(keyFileOf(o));
  const ws = await realRoot(o.root);
  const approvals = all.filter((a) => homeSigned(key, payload(ws, o.jobId, input, a), a.sig));
  return { approvals, rejected: all.length - approvals.length };
}

/** sha256 of a job's id and input (canonical JSON): what the worker claimed, checked again by the job process. */
export function recordDigest(rec: { id: string; input: unknown }): string {
  return createHash('sha256')
    .update(canonicalJson({ id: rec.id, input: rec.input }))
    .digest('hex');
}

/** `<RETAKE_HOME>/approvals-used`. */
export function approvalsUsedDir(env: EngineEnv): string {
  return join(retakeHome(env), APPROVALS_USED_DIR);
}
const usedDir = approvalsUsedDir;

/** The time of a job id (`j_` + a ULID: its first 10 characters), or NaN. */
function idTime(id: string): number {
  return isJobId(id) ? ulidTime(id.slice(ULID_PREFIXES.job.length)) : NaN;
}

/**
 * The worker takes a job's approvals as it claims it: `<RETAKE_HOME>/approvals-used/<id>` is created once (with the
 * claimed record's digest). False when this job id's approvals were taken before (a job folder made again under the
 * same id) or the job's id is older than APPROVALS_USED_KEEP_MS (its record may be gone): the job is then refused.
 * A job without approvals consumes nothing (true). Throws when the record cannot be written. `now`: the
 * time of the worker's clock (epoch milliseconds), what the record is stamped with.
 */
export async function consumeApprovals(rec: { id: string; input: JobInput }, env: EngineEnv, now: number): Promise<boolean> {
  if (!approvalsOf(rec.input)?.length) return true;
  const t = idTime(rec.id);
  if (!Number.isFinite(t) || now - t > APPROVALS_USED_KEEP_MS) return false;
  const file = join(usedDir(env), rec.id);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${JSON.stringify({ at: new Date(now).toISOString(), digest: recordDigest(rec) })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/** Give a claim's approvals back (the worker gave the job back to the queue unrun: another build). */
export async function restoreApprovals(id: string, env: EngineEnv): Promise<void> {
  if (!isJobId(id)) return;
  await rm(join(usedDir(env), id), { force: true });
}

/** Remove the records of approvals taken longer ago than APPROVALS_USED_KEEP_MS before `now` (a worker's start, on its clock). */
export async function pruneUsedApprovals(env: EngineEnv, now: number): Promise<void> {
  const dir = usedDir(env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isJobId(name)) continue;
    const file = join(dir, name);
    const st = await stat(file).catch(() => undefined);
    if (st && now - st.mtimeMs > APPROVALS_USED_KEEP_MS) await rm(file, { force: true }).catch(() => undefined);
  }
}
