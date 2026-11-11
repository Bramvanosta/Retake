/**
 * File writes and reads every package shares: a run folder reserved, JSON read, and atomic text and JSON writes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { newRunId } from '../util.js';

/**
 * Reserve a new run folder of `scenario` under `runsDir` (created): `newRunId`, and when that folder exists (two runs of
 * one scenario started in the same second — concurrent runs, L1.6 — or a run reserved ahead by a job) the next free
 * second. Run ids keep their format and their order. The runner calls it for a run without a pre-assigned id; the
 * engine calls it when a job is submitted, so the run id is known before the run starts.
 */
export async function reserveRunId(runsDir: string, scenario: string, date: Date = new Date()): Promise<{ id: string; dir: string }> {
  await mkdir(runsDir, { recursive: true });
  for (let k = 0; ; k++) {
    const id = newRunId(scenario, new Date(date.getTime() + k * 1000));
    const dir = join(runsDir, id);
    try {
      await mkdir(dir);
      return { id, dir };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || k >= 120) throw e;
    }
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

/** Atomic JSON write (tmp file + rename). */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Atomic text write (tmp file + rename); creates the parent directory. `mode` / `dirMode` restrict who may read them
 * (a session snapshot: 0o600 / 0o700) — the tmp file is created with that mode, so the content is never readable by
 * others, even for a moment.
 */
export async function writeTextAtomic(file: string, text: string, opts: { mode?: number; dirMode?: number } = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true, ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {}) });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
  await rename(tmp, file);
}
