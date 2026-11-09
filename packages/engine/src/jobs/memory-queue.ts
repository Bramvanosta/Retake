/**
 * The in-memory job queue (tests): the JobQueue port's behaviour (queue-core.ts) over a map instead of a job folder —
 * no file, no path. The contract suite (packages/engine/test/job-queue-contract.ts) holds it to the file queue's
 * behaviour. Approvals are still signed with the Retake home's key for `root` (signing.ts), and the derived states still
 * look at the recorded processes (proc.ts), as the file queue does.
 */
import type { TakeHold } from './job-queue.js';
import { StoredJobQueue, checkJobId } from './queue-core.js';
import type { JobEntries } from './queue-core.js';

function gone(id: string): Error {
  return Object.assign(new Error(`ENOENT: job ${id} is gone`), { code: 'ENOENT' });
}

class MemoryEntries implements JobEntries {
  private readonly jobs = new Map<string, Map<string, { text: string; at: string }>>();

  private job(id: string): Map<string, { text: string; at: string }> | undefined {
    return this.jobs.get(checkJobId(id));
  }

  private set(id: string, name: string, text: string): void {
    const job = this.job(id);
    if (!job) throw gone(id);
    job.set(name, { text, at: new Date().toISOString() });
  }

  async ids(): Promise<string[]> {
    return [...this.jobs.keys()].sort();
  }

  async make(id: string): Promise<void> {
    if (!this.jobs.has(id)) this.jobs.set(id, new Map());
  }

  async add(id: string, name: string, text: string): Promise<void> {
    if (this.job(id)?.has(name)) throw Object.assign(new Error(`EEXIST: ${name}`), { code: 'EEXIST' });
    this.set(id, name, text);
  }

  async read(id: string, name: string): Promise<string | undefined> {
    return this.job(id)?.get(name)?.text;
  }

  async mtime(id: string, name: string): Promise<string | undefined> {
    return this.job(id)?.get(name)?.at;
  }

  async exists(id: string, name: string): Promise<boolean> {
    return this.job(id)?.has(name) ?? false;
  }

  async create(id: string, name: string, text: string): Promise<boolean> {
    const job = this.job(id);
    if (!job) throw gone(id);
    if (job.has(name)) return false;
    this.set(id, name, text);
    return true;
  }

  async replace(id: string, name: string, text: string): Promise<void> {
    this.set(id, name, text);
  }

  async put(id: string, name: string, text: string): Promise<void> {
    this.set(id, name, text);
  }

  async append(id: string, name: string, text: string): Promise<void> {
    const job = this.job(id);
    if (!job) throw gone(id);
    this.set(id, name, (job.get(name)?.text ?? '') + text);
  }

  async remove(id: string, name: string): Promise<void> {
    this.job(id)?.delete(name);
  }
}

export interface MemoryJobQueueOptions {
  /** How the commands a human is asked to run start (default "retake"). */
  cli?: string;
  /** What a filming marker of this user holds (default: nothing). */
  filming?: () => Promise<TakeHold>;
}

export class MemoryJobQueue extends StoredJobQueue {
  /** `root`: the workspace the approvals are signed for. */
  constructor(
    root: string,
    private readonly o: MemoryJobQueueOptions = {},
    entries: JobEntries = new MemoryEntries(),
  ) {
    super(root, o.cli ?? 'retake', entries);
  }

  reader(): MemoryJobQueue {
    return new MemoryJobQueue(this.root, this.o, this.entries);
  }

  protected async filming(): Promise<TakeHold> {
    return this.o.filming ? this.o.filming() : undefined;
  }
}
