/**
 * A recording folder's own files beside the runner's events (L4.8): meta.json, written once by the code that creates
 * the folder (record.ts, the CLI and the worker alike), and studio.json, the Studio's annotations (core
 * record-annotations.ts), written only by the engine (record-studio.ts) under the recording's lock
 * (`<project>/.retake/locks/record-<id>.lock`). Everything under `.retake/` is agent-writable: both files are
 * read without following a link (O_NOFOLLOW), bounded, and checked field by field before any use; a file that fails is
 * treated as absent (meta.json: the recording is read-only) or refused (studio.json: never overwritten).
 */
import { writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { SLUG_RE } from '@retake/core/model';
import { JOB_ID_RE, RECORD_ID_RE } from '@retake/core/ids';
import { statePath } from '@retake/core/project';
import { isIsoUtcDate } from '@retake/core/comments';
import { parseRecordAnnotations } from '@retake/core/run';
import { JOB_CLIENTS } from './jobs/job-input.js';
import { readPlainFile } from '@retake/core/io';
import type { RecordAnnotations } from '@retake/core/run';
import type { JobClient } from './jobs/job-input.js';
import type { ProcessIdentity } from './jobs/proc.js';

export const RECORD_META_FILE = 'meta.json';
export const RECORD_STUDIO_FILE = 'studio.json';
export const RECORD_META_MAX_BYTES = 16 * 1024;
/** An unsaved Studio recording is kept this long even beyond the newest RECORD_KEEP (ms: 7 days, critique B12). */
export const RECORD_UNSAVED_KEEP_MS = 7 * 24 * 3600_000;

/** What the folder's creator knew when it made the folder: the draft's context, who started it, and its process. */
export interface RecordMeta {
  v: 1;
  rec_id: string;
  /** The `record` job (null: a `retake record` in a terminal). */
  job_id: string | null;
  submitted_by: JobClient;
  /** The scenario name the draft is made for. */
  name: string;
  env: string;
  persona: string | null;
  access: 'read-only' | 'read-write';
  page: string;
  path: string;
  started_at: string;
  max_ms: number | null;
  /** The process that records (a CLI recording without its record.json is interrupted once it is gone). */
  owner: ProcessIdentity;
}

/** `<project>/.retake/locks/record-<id>.lock`'s name: held by annotate, save and discard; prune skips its folder. */
export function recordLockName(id: string): string {
  return `record-${id}.lock`;
}

export function recordLockFile(projectDir: string, id: string): string {
  return statePath(projectDir, 'locks', recordLockName(id));
}

/** Write meta.json once (0600; never over an existing file). */
export async function writeRecordMeta(dir: string, meta: RecordMeta): Promise<void> {
  const file = join(dir, RECORD_META_FILE);
  await writeFile(file, `${JSON.stringify(meta, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(file, 0o600);
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** meta.json checked field by field (null: missing, a link, too large, or not a meta file of this recording). */
export function readRecordMeta(dir: string, id: string): RecordMeta | null {
  const r = readPlainFile(join(dir, RECORD_META_FILE), RECORD_META_MAX_BYTES);
  if (!r.ok) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(r.bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const owner = m.owner as Record<string, unknown> | undefined;
  const ok =
    m.v === 1 &&
    m.rec_id === id &&
    RECORD_ID_RE.test(id) &&
    (m.job_id === null || (typeof m.job_id === 'string' && JOB_ID_RE.test(m.job_id))) &&
    (JOB_CLIENTS as readonly unknown[]).includes(m.submitted_by) &&
    str(m.name, 100) &&
    SLUG_RE.test(m.name) &&
    str(m.env, 100) &&
    (m.persona === null || str(m.persona, 100)) &&
    (m.access === 'read-only' || m.access === 'read-write') &&
    str(m.page, 100) &&
    str(m.path, 2048) &&
    str(m.started_at, 40) &&
    isIsoUtcDate(m.started_at) &&
    (m.max_ms === null || (typeof m.max_ms === 'number' && Number.isInteger(m.max_ms) && m.max_ms > 0)) &&
    !!owner &&
    typeof owner === 'object' &&
    typeof owner.pid === 'number' &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    (owner.started_at === undefined || str(owner.started_at, 40));
  if (!ok) return null;
  return {
    v: 1,
    rec_id: id,
    job_id: m.job_id as string | null,
    submitted_by: m.submitted_by as JobClient,
    name: m.name as string,
    env: m.env as string,
    persona: m.persona as string | null,
    access: m.access as RecordMeta['access'],
    page: m.page as string,
    path: m.path as string,
    started_at: m.started_at as string,
    max_ms: m.max_ms as number | null,
    owner: { pid: owner!.pid as number, ...(owner!.started_at !== undefined ? { started_at: owner!.started_at as string } : {}) },
  };
}

/** studio.json read without following a link: none yet, the annotations, or why it cannot be used (fixed words). */
export function readRecordAnnotations(dir: string): { annotations: RecordAnnotations | null } | { problem: string } {
  const r = readPlainFile(join(dir, RECORD_STUDIO_FILE), 64 * 1024 + 1);
  if (!r.ok) {
    if (r.reason === 'missing') return { annotations: null };
    if (r.reason === 'link') return { problem: "studio.json is a symbolic link: the recording's annotations are never read or written through a link — remove it" };
    if (r.reason === 'too_large') return { problem: 'studio.json is larger than its limit: remove it to start the annotations again' };
    return { problem: 'studio.json cannot be read: remove it to start the annotations again' };
  }
  const parsed = parseRecordAnnotations(r.bytes.toString('utf8'));
  if ('error' in parsed) return { problem: `${parsed.error} (studio.json): remove it to start the annotations again` };
  return { annotations: parsed.annotations };
}
