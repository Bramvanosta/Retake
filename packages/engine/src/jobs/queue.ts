/**
 * The file job queue (L3.1, R-ARC-02), the JobQueue port's product adapter: files under <workspace>/.retake/jobs/<id>/,
 * one writer per file (the behaviour is queue-core.ts's, over these files).
 *
 * - job.json: written once by the submitter (`queued`, atomically), then only by the worker that claimed the job;
 * - claim: created exclusively (O_EXCL) by the worker that takes the job — the atomic claim;
 * - cancel: created exclusively by whoever asks for a cancel (a client); the worker polls it;
 * - pause (L4.4, a running `run` job): created by whoever asks for a pause and removed by whoever asks to resume (a
 *   client); the worker polls it with the cancel marker and never writes it (a marker left by a finished job is inert);
 * - stop (L4.8, a running `record` job): created exclusively by whoever asks to stop and keep (the Studio's Stop); the
 *   worker polls it with the cancel marker and ends the recording as if its window were closed (the check replay runs);
 * - live.json (L4.4, a running `run` job): the live channel's port and token, 0600, written and removed by the claiming
 *   worker (jobs/live-channel.ts);
 * - browser.json: the render browser a job's worker started (pid + start time), to kill it after a crash;
 * - events.jsonl: appended by the claiming worker only;
 * - yield.json (L5.14, a running heavy job): written and removed by the worker that claimed it while the job yields to a
 *   filming take (background priority); readers derive the job's `yield` from it, and `waiting` for a queued heavy job
 *   while a take holds heavy work.
 *
 * Readers never write. What a dead worker cannot write is derived when reading: a `running` job whose worker is gone
 * (pid + start time) is `interrupted`; a `queued` job with a cancel marker and no claim is `cancelled`. The next worker
 * persists those states (it claims a cancelled job to close it; it holds the worker lock when it marks interrupted
 * jobs).
 *
 * The paths are the file part's (`files`, JobFiles): only the code that reads or writes a job's files itself uses it
 * (the live channel, a render's browser, the Studio's live run); the port (job-queue.ts) has none.
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_ID_RE } from '@retake/core';
import type { JobQueue, TakeHold } from './job-queue.js';
import { StoredJobQueue, checkJobId } from './queue-core.js';
import type { JobEntries } from './queue-core.js';

export type { ClaimRecord, JobFilter } from './job-queue.js';
export { interrupted, jobProject } from './queue-core.js';

/** <workspace>/.retake: machine-local state of a workspace (git-ignored). */
export function stateDir(root: string): string {
  return join(root, '.retake');
}

export function jobsDir(root: string): string {
  return join(stateDir(root), 'jobs');
}

/** The file queue's paths: a job's folder and the files the code beside the queue reads or writes itself. */
export class JobFiles {
  /** `dir`: <workspace>/.retake/jobs. */
  constructor(readonly dir: string) {}

  /** <jobs>/<id>: refused for anything but a job id (never a path). */
  job(id: string): string {
    return join(this.dir, checkJobId(id));
  }

  /** <job>/browser.json: the render browser a job's worker started (pid + start time), to kill it after a crash. */
  browser(id: string): string {
    return join(this.job(id), 'browser.json');
  }

  /** <job>/live.json: the live channel of a running `run` job (jobs/live-channel.ts). */
  live(id: string): string {
    return join(this.job(id), 'live.json');
  }

  /** <job>/yield.json (L5.14): written by the worker while a running heavy job yields to a filming take. */
  yield(id: string): string {
    return join(this.job(id), 'yield.json');
  }

  /** <job>/events.jsonl: the job's events (the Studio's live run tails it by byte range). */
  events(id: string): string {
    return join(this.job(id), 'events.jsonl');
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** A job's entries as the files of its folder. */
class FileEntries implements JobEntries {
  constructor(private readonly files: JobFiles) {}

  private file(id: string, name: string): string {
    return join(this.files.job(id), name);
  }

  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.files.dir)).filter((n) => JOB_ID_RE.test(n)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  async make(id: string): Promise<void> {
    await mkdir(join(this.files.dir, id), { recursive: true });
  }

  async add(id: string, name: string, text: string): Promise<void> {
    await writeFile(join(this.files.dir, id, name), text, { mode: 0o600, flag: 'wx' });
  }

  async read(id: string, name: string): Promise<string | undefined> {
    const file = this.file(id, name);
    try {
      return await readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  async mtime(id: string, name: string): Promise<string | undefined> {
    try {
      return (await stat(this.file(id, name))).mtime.toISOString();
    } catch {
      return undefined;
    }
  }

  async exists(id: string, name: string): Promise<boolean> {
    const file = this.file(id, name);
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async create(id: string, name: string, text: string): Promise<boolean> {
    let fh;
    try {
      fh = await open(this.file(id, name), 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    try {
      await fh.writeFile(text);
    } finally {
      await fh.close();
    }
    return true;
  }

  async replace(id: string, name: string, text: string): Promise<void> {
    await writeAtomic(this.file(id, name), text);
  }

  async put(id: string, name: string, text: string): Promise<void> {
    await writeFile(this.file(id, name), text);
  }

  async append(id: string, name: string, text: string): Promise<void> {
    await appendFile(this.file(id, name), text);
  }

  async remove(id: string, name: string): Promise<void> {
    await rm(this.file(id, name), { force: true });
  }
}

/** The file queue as the code that needs its files sees it: the port and its file part. */
export interface FileJobs extends JobQueue {
  readonly files: JobFiles;
}

export class FileJobQueue extends StoredJobQueue implements FileJobs {
  /** The file part: the paths of the jobs folder and of a job's files. */
  readonly files: JobFiles;
  private watch?: import('./captures.js').FilmingWatch;

  /** `cli`: how the commands a human is asked to run start ("retake -C <root>"). */
  constructor(root: string, cli = 'retake') {
    const files = new JobFiles(jobsDir(root));
    super(root, cli, new FileEntries(files));
    this.files = files;
  }

  reader(): FileJobQueue {
    return new FileJobQueue(this.root, this.cli);
  }

  /** A filming marker of this user (captures.ts: `here` when its workspace is this one). */
  protected async filming(): Promise<TakeHold> {
    const { FilmingWatch } = await import('./captures.js');
    this.watch ??= new FilmingWatch({ root: this.root });
    const st = await this.watch.scan().catch(() => undefined);
    return st?.holding ? (st.cause ?? 'elsewhere') : undefined;
  }
}
