import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '@retake/core/io';
import type { FinishedRun, RunProgress, RunRecord, RunningRun } from '@retake/core/run';

/**
 * runs/<id>/run.json (RunRecord, rewritten atomically as the run progresses) and log.jsonl (every progress
 * event with a timestamp). Writes are queued so the action loop never waits on the disk. `redact` masks the run's
 * secret values in run.json when it is written (progress events arrive redacted). The record is the run's in flight,
 * then — once, at its end — the finished one (`finish`): the last save writes that.
 */
export class RunFiles {
  private chain: Promise<void> = Promise.resolve();
  private readonly log: WriteStream;
  private dirty = false;
  private lastError: Error | null = null;

  private record: RunRecord;
  private finished = false;

  constructor(
    readonly dir: string,
    record: RunningRun,
    private readonly redact: (record: RunRecord) => RunRecord = (r) => r,
  ) {
    this.record = record;
    this.log = createWriteStream(join(dir, 'log.jsonl'), { flags: 'a' });
    this.log.on('error', (e) => (this.lastError = e));
  }

  progress(e: RunProgress): void {
    this.log.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
  }

  /** The run ended: `done` is the record from now on (set once; the next save writes it). */
  finish(done: FinishedRun): void {
    if (this.finished) throw new Error('a run ends once');
    this.finished = true;
    this.record = done;
  }

  /** Queue a rewrite of run.json with the record's current state (coalesced). */
  saveRecord(): Promise<void> {
    if (this.dirty) return this.chain;
    this.dirty = true;
    this.chain = this.chain.then(async () => {
      this.dirty = false;
      try {
        await writeJson(join(this.dir, 'run.json'), this.redact(this.record));
      } catch (e) {
        this.lastError = e as Error;
      }
    });
    return this.chain;
  }

  async close(): Promise<void> {
    await this.saveRecord();
    await new Promise<void>((resolve) => this.log.end(resolve));
    if (this.lastError) throw this.lastError;
  }
}
