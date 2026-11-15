/**
 * A recording folder's own files beside the runner's events: meta.json, written once by the code that creates
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
import { storedJson } from './stored-json.js';
import { z } from 'zod';

export const RECORD_META_FILE = 'meta.json';
export const RECORD_STUDIO_FILE = 'studio.json';
export const RECORD_META_MAX_BYTES = 16 * 1024;
/** An unsaved Studio recording is kept this long even beyond the newest RECORD_KEEP (ms: 7 days). */
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

/** A text of 1 to `max` characters. */
const text = (max: number) => z.string().min(1).max(max);

/** A meta.json of this version, each member of its shape (the reader then checks it names this recording). */
const RecordMetaSchema = z.object({
  v: z.literal(1),
  rec_id: z.string().regex(RECORD_ID_RE),
  job_id: z.string().regex(JOB_ID_RE).nullable(),
  submitted_by: z.enum(JOB_CLIENTS),
  name: text(100).regex(SLUG_RE),
  env: text(100),
  persona: text(100).nullable(),
  access: z.enum(['read-only', 'read-write']),
  page: text(100),
  path: text(2048),
  started_at: text(40).refine(isIsoUtcDate),
  max_ms: z.number().int().positive().nullable(),
  owner: z.object({ pid: z.number().int().positive(), started_at: text(40).optional() }),
});

/** meta.json read through its schema (null: missing, a link, too large, or not a meta file of this recording). */
export function readRecordMeta(dir: string, id: string): RecordMeta | null {
  const r = readPlainFile(join(dir, RECORD_META_FILE), RECORD_META_MAX_BYTES);
  if (!r.ok) return null;
  const m = storedJson(RecordMetaSchema, r.bytes.toString('utf8')) as RecordMeta | undefined;
  if (!m || m.rec_id !== id) return null;
  // Its members only, as this version holds them.
  return {
    v: 1,
    rec_id: id,
    job_id: m.job_id,
    submitted_by: m.submitted_by,
    name: m.name,
    env: m.env,
    persona: m.persona,
    access: m.access,
    page: m.page,
    path: m.path,
    started_at: m.started_at,
    max_ms: m.max_ms,
    owner: { pid: m.owner.pid, ...(m.owner.started_at !== undefined ? { started_at: m.owner.started_at } : {}) },
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
