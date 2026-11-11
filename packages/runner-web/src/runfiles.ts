import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join } from 'node:path';
import { writeJson } from '@retake/core/io';
import type { RunProgress, RunRecord } from '@retake/core';

/**
 * runs/<id>/run.json (RunRecord, rewritten atomically as the run progresses) and log.jsonl (every progress
 * event with a timestamp). Writes are queued so the action loop never waits on the disk. `redact` masks the run's
 * secret values in run.json when it is written (progress events arrive redacted).
 */
export class RunFiles {
  private chain: Promise<void> = Promise.resolve();
  private readonly log: WriteStream;
  private dirty = false;
  private lastError: Error | null = null;

  constructor(
    readonly dir: string,
    readonly record: RunRecord,
    private readonly redact: (record: RunRecord) => RunRecord = (r) => r,
  ) {
    this.log = createWriteStream(join(dir, 'log.jsonl'), { flags: 'a' });
    this.log.on('error', (e) => (this.lastError = e));
  }

  progress(e: RunProgress): void {
    this.log.write(JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');
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
