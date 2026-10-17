import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

function runSlug(scenario: string): string {
  return scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

/** "20261011-142233-catalogue" (local time). */
export function newRunId(scenario: string, date: Date = new Date()): string {
  const slug = runSlug(scenario);
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${slug}`
  );
}

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

/**
 * Whether a run id is a run of `scenario`: the scenario slug of a "<date>-<time>-<slug>" id must EQUAL the scenario's
 * (a run of "mobile-quote" is not a run of "quote"); ids in another format fall back to a "-<scenario>" suffix.
 */
export function runIdMatchesScenario(id: string, scenario: string): boolean {
  const m = /^\d{8}-\d{6}-(.+)$/.exec(id);
  return m ? m[1] === runSlug(scenario) : id.endsWith(`-${scenario}`);
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

/** "my Project!" → "my-project" */
export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) return (process.env.HOME ?? '') + p.slice(1);
  return p;
}

/** Deterministic PRNG in [0,1) from a string seed (mulberry32 over an FNV-1a hash). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
