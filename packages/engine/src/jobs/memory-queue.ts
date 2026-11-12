/**
 * The in-memory job queue: the JobQueue port's behaviour (queue-core.ts) over a map instead of a job folder — no file,
 * no path. It exists for the tests of the code that is handed a queue (pruning, a watcher, a job's markers): they build
 * the jobs they need without a workspace's .retake/jobs, and without a worker. It is also the second adapter that keeps
 * the port honest: the contract suite (packages/engine/test/job-queue-contract.ts) holds it to the file queue's
 * behaviour, so nothing of the port may need a path. Approvals are still signed with the Retake home's key for `root`
 * (signing.ts), and the derived states still look at the recorded processes (proc.ts), as the file queue does.
 */
import { opChain } from '../admission.js';
import type { OpChain } from '../admission.js';
import { stampOf, systemClock } from '../clock.js';
import type { Clock } from '../clock.js';
import type { JobFileRead, TakeHold } from './job-queue.js';
import { StoredJobQueue, checkJobId } from './queue-core.js';
import type { JobEntries } from './queue-core.js';

function gone(id: string): Error {
  return Object.assign(new Error(`ENOENT: job ${id} is gone`), { code: 'ENOENT' });
}

class MemoryEntries implements JobEntries {
  /** `clock`: an entry's time (the file queue's mtime). */
  constructor(private readonly clock: Clock) {}

  private readonly jobs = new Map<string, Map<string, { text: string; at: string }>>();

  private job(id: string): Map<string, { text: string; at: string }> | undefined {
    return this.jobs.get(checkJobId(id));
  }

  private set(id: string, name: string, text: string): void {
    const job = this.job(id);
    if (!job) throw gone(id);
    job.set(name, { text, at: stampOf(this.clock) });
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

  async readPlain(id: string, name: string, max: number): Promise<JobFileRead> {
    const text = this.job(id)?.get(name)?.text;
    if (text === undefined) return { ok: false, reason: 'missing' };
    return Buffer.byteLength(text) > max ? { ok: false, reason: 'too_large' } : { ok: true, text };
  }

  async mtime(id: string, name: string): Promise<string | undefined> {
    return this.job(id)?.get(name)?.at;
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
  /**
   * What a filming marker of this user holds (default: nothing): a new source for each queue and each of its
   * withOwnMemory() queues — each its own memory of the takes, as each file queue has its own marker watch.
   */
  filming?: () => () => Promise<TakeHold>;
  /** What the queue stamps its records, markers and entries with (default the system's clock: tests). */
  clock?: Clock;
}

/** The locks of the queues on one set of entries (MemoryJobQueue.exclusive). */
const MEMORY_LOCKS = new WeakMap<JobEntries, OpChain>();

export class MemoryJobQueue extends StoredJobQueue {
  private readonly hold: (() => Promise<TakeHold>) | undefined;

  /** `root`: the workspace the approvals are signed for. */
  constructor(
    root: string,
    private readonly o: MemoryJobQueueOptions = {},
    entries: JobEntries = new MemoryEntries(o.clock ?? systemClock),
  ) {
    super(root, o.cli ?? 'retake', entries, o.clock ?? systemClock);
    this.hold = o.filming?.();
  }

  /** `fn` under the lock of `key`, shared by the queues on these entries (withOwnMemory): one holder at a time per key, in this process. */
  exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let chain = MEMORY_LOCKS.get(this.entries);
    if (!chain) MEMORY_LOCKS.set(this.entries, (chain = opChain()));
    return chain(key, fn);
  }

  /** The same jobs (one map), no finished job seen yet and a filming source of its own. */
  withOwnMemory(cli = 'retake'): MemoryJobQueue {
    return new MemoryJobQueue(this.root, { ...this.o, cli }, this.entries);
  }

  protected async filming(): Promise<TakeHold> {
    return this.hold ? this.hold() : undefined;
  }
}
