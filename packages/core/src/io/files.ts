/**
 * File writes and reads every package shares: a run folder reserved, JSON read, and atomic text and JSON writes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RUN_ID_MAX, parseRunId } from '../id-grammar.js';
import type { RunId } from '../id-grammar.js';
import { newRunId } from '../ids.js';

/**
 * Reserve a new run folder of `scenario` under `runsDir` (created): `newRunId`, and when that folder exists (two runs of
 * one scenario started in the same second — concurrent runs, L1.6 — or a run reserved ahead by a job) the next free
 * second. Run ids keep their format and their order. The runner calls it for a run without a pre-assigned id; the
 * engine calls it when a job is submitted, so the run id is known before the run starts. A scenario whose name leaves
 * no room for a run id is refused before any folder is made: a folder that is no run id is a run no list shows.
 */
export async function reserveRunId(runsDir: string, scenario: string, date: Date = new Date()): Promise<{ id: RunId; dir: string }> {
  const first = parseRunId(newRunId(scenario, date));
  if (first === null) {
    const room = RUN_ID_MAX - newRunId('', date).length + 'run'.length;
    throw new Error(`scenario "${scenario.slice(0, 40)}…": its name is too long for a run folder, which is named after it (a run id holds at most ${RUN_ID_MAX} characters: ${room} for the scenario's name) — give the scenario file a shorter name`);
  }
  await mkdir(runsDir, { recursive: true });
  for (let k = 0; ; k++) {
    const id = k === 0 ? first : parseRunId(newRunId(scenario, new Date(date.getTime() + k * 1000)));
    // Cannot happen once `first` parsed (a later second gives an id of the same length): kept for the type alone.
    if (id === null) throw new Error(`no run id for scenario "${scenario.slice(0, 40)}"`);
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
