/** A recording's folder read and written for the Record screen (record-studio.ts): never through a link. */
import { randomBytes } from 'node:crypto';
import { lstat, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathInside } from '@retake/core/base';
import { JOB_ID_RE, RECORD_ID_RE } from '@retake/core/ids';
import { statePath } from '@retake/core/project';
import { RecordedEventSchema } from '@retake/core/run';
import { readPlainFile } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/project';
import type { RecordAnnotations, RecordedEvent } from '@retake/core/run';
import { EngineError } from './errors.js';
import type { JobQueueView } from './jobs/job-queue.js';
import type { JobRecord } from './jobs/types.js';
import { lockHolder, takeProjectLock } from './project-lock.js';
import { recordsRoot } from './record.js';
import { RECORD_STUDIO_FILE, recordLockName } from './record-files.js';
import type { RecordMeta } from './record-files.js';
import { storedJson } from './stored-json.js';
import { z } from 'zod';

/** The largest events.jsonl read (bytes): a 30-minute recording is far below it. */
export const RECORD_EVENTS_MAX_BYTES = 64 * 1024 * 1024;
const RECORD_JSON_MAX_BYTES = 8 * 1024 * 1024;
/** How long an operation waits for the recording's lock held by another one (ms). */
const RECORD_LOCK_WAIT_MS = 3000;

// ── Reading the folder ─────────────────────────────────────────────────────

export type EventsRead = { ok: true; events: RecordedEvent[]; bytes: Buffer; dropped: number } | { ok: false; problem: string };

/**
 * events.jsonl read without following a link, each complete line re-validated (a line the schema refuses is dropped
 * and counted). The runner streams the file: a last line without its newline is still being written — left for the
 * next read.
 */
export function readRecordEvents(dir: string): EventsRead {
  const r = readPlainFile(join(dir, 'events.jsonl'), RECORD_EVENTS_MAX_BYTES);
  if (!r.ok) {
    if (r.reason === 'missing') return { ok: true, events: [], bytes: Buffer.alloc(0), dropped: 0 };
    if (r.reason === 'link') return { ok: false, problem: 'events.jsonl is a symbolic link: the recording is never read through a link' };
    if (r.reason === 'too_large') return { ok: false, problem: `events.jsonl is larger than ${RECORD_EVENTS_MAX_BYTES / 1024 / 1024} MB` };
    return { ok: false, problem: 'events.jsonl cannot be read' };
  }
  const text = r.bytes.toString('utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const events: RecordedEvent[] = [];
  let dropped = 0;
  for (const line of complete.split('\n')) {
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      dropped++;
      continue;
    }
    const p = RecordedEventSchema.safeParse(raw);
    if (p.success) events.push(p.data);
    else dropped++;
  }
  return { ok: true, events, bytes: r.bytes, dropped };
}

export interface RecordJson {
  events_sha256: string | null;
  saved: string | null;
  check: Record<string, unknown> | null;
  warnings: string[];
  /** The worker's draft: its steps, and the actions recorded (the recent list). */
  steps: number | null;
  actions: number | null;
}

/** A record.json: an object (each member the view uses is then read on its own: an odd one reads as none). */
const RecordJsonSchema = z.record(z.string(), z.unknown());

/** record.json's fields the view uses (each checked; null when there is none or it is not readable). */
export function readRecordJson(dir: string): RecordJson | null {
  const r = readPlainFile(join(dir, 'record.json'), RECORD_JSON_MAX_BYTES);
  if (!r.ok) return null;
  const j = storedJson(RecordJsonSchema, r.bytes.toString('utf8')) as Record<string, unknown> | undefined;
  if (!j) return null;
  return {
    events_sha256: typeof j.events_sha256 === 'string' && /^[0-9a-f]{64}$/.test(j.events_sha256) ? j.events_sha256 : null,
    saved: typeof j.saved === 'string' && /^scenarios\/[\w-]{1,100}\.yaml$/.test(j.saved) ? j.saved : null,
    check: j.check && typeof j.check === 'object' && !Array.isArray(j.check) ? (j.check as Record<string, unknown>) : null,
    warnings: Array.isArray(j.warnings)
      ? j.warnings
          .filter((w): w is string => typeof w === 'string')
          .slice(0, 50)
          .map((w) => w.slice(0, 400))
      : [],
    steps: count((j.stats as { steps?: unknown } | undefined)?.steps),
    actions: count((j.counts as { actions?: unknown } | undefined)?.actions),
  };
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** The recording's job (meta.json's job_id, else the caller's hint), only when it is that recording's `record` job. */
export async function jobOf(queue: JobQueueView, slug: string, id: string, meta: RecordMeta | null, hint?: string): Promise<JobRecord | null> {
  const jid = meta ? meta.job_id : (hint ?? null);
  if (!jid || !JOB_ID_RE.test(jid)) return null;
  const job = await queue.get(jid);
  if (job?.input.kind !== 'record' || job.input.rec_id !== id || job.input.project !== slug) return null;
  return job;
}

/**
 * Is the recording's folder there, and a real one: the project's records folder a real folder (its real path exactly
 * <real project>/.retake/records — no link on the way) and the recording's folder a real folder directly in it.
 * `link`: something on the way is a link or leads elsewhere — nothing is read, written or removed there (reads never
 * follow a link out of a project).
 */
export async function folderState(project: LoadedProject, id: string): Promise<'folder' | 'none' | 'link'> {
  const root = recordsRoot(project);
  const dir = join(root, id);
  let dirSt: Awaited<ReturnType<typeof lstat>>;
  try {
    dirSt = await lstat(dir);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'link';
  }
  if (!dirSt.isDirectory() || dirSt.isSymbolicLink()) return 'link';
  try {
    const [rootSt, realProject, realRoot, realDir] = await Promise.all([lstat(root), realpath(project.dir), realpath(root), realpath(dir)]);
    if (
      !rootSt.isDirectory() ||
      rootSt.isSymbolicLink() ||
      realRoot !== statePath(realProject, 'records') ||
      realDir !== join(realRoot, id) ||
      !pathInside(realDir, realProject, { dotDotPrefix: true })
    )
      return 'link';
  } catch {
    return 'link';
  }
  return 'folder';
}

/** The project's records folder, when it is a real folder of the project (else null: a link on the way). */
export async function realRecordsRoot(project: LoadedProject): Promise<string | null> {
  const root = recordsRoot(project);
  try {
    const [st, realProject, realRoot] = await Promise.all([lstat(root), realpath(project.dir), realpath(root)]);
    return st.isDirectory() && !st.isSymbolicLink() && realRoot === statePath(realProject, 'records') ? root : null;
  } catch {
    return null;
  }
}

export const LINK_WORDS = "the recording's folder or the records folder is a symbolic link or leads out of the project: nothing is read, written or removed through a link (remove it by hand)";
export const ORIGIN_WORDS = "the recording's origin cannot be verified (meta.json says the Studio started it, but its job is gone or says otherwise): it is read-only here";
export const TAMPERED_WORDS =
  "the recording's files were changed after its job wrote them (record.json is missing or holds no checksum of the events): it cannot be verified, so it cannot be saved — discard it and record again";

export async function mtimeOf(file: string): Promise<string> {
  try {
    const s = await stat(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/** The recording's lock: retried while another operation holds it (≤ RECORD_LOCK_WAIT_MS). */
export function lockRecording(project: LoadedProject, id: string, op: string) {
  return takeProjectLock(project.dir, recordLockName(id), {
    command: `record ${op} ${id}`,
    what: `recording ${id}`,
    waitMs: RECORD_LOCK_WAIT_MS,
    retryMs: 30,
    busy: (_ref, held) => {
      const { pid } = lockHolder(held);
      return new EngineError('busy', `recording ${id} is being changed by another operation${pid ? ` (pid ${pid})` : ''}: try again`, { fix: 'try again in a moment' });
    },
  });
}

/**
 * The recording's folder, checked before anything in it is written or removed: the project's records folder is a real
 * folder (no link on the way: its real path is exactly <real project>/.retake/records) and the recording's own
 * folder is a real folder directly in it. Throws EngineError refused (no path in the message).
 */
export async function checkedFolder(project: LoadedProject, id: string): Promise<string> {
  if (!RECORD_ID_RE.test(id)) throw new EngineError('invalid', 'invalid recording id: rec_ followed by 26 characters, never a path');
  const where = await folderState(project, id);
  if (where === 'none') throw new EngineError('not_found', `recording ${id} has no folder (nothing recorded, discarded or pruned)`);
  if (where === 'link') throw new EngineError('refused', `recording ${id}: ${LINK_WORDS}`);
  return join(recordsRoot(project), id);
}

/** Remove the recording's folder (checkedFolder first). */
export async function removeFolder(project: LoadedProject, id: string): Promise<void> {
  const dir = await checkedFolder(project, id);
  await rm(dir, { recursive: true, force: true });
}

/** studio.json replaced whole: a new file created exclusively (never through a link), then renamed over it. */
export async function writeAnnotations(dir: string, a: RecordAnnotations): Promise<void> {
  const tmp = join(dir, `.studio-${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(a)}\n`);
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, join(dir, RECORD_STUDIO_FILE));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
