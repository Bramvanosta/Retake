/**
 * Runs and renders of a project on disk: the run a render works on (id, directory or `latest`), the next free render
 * version and the RenderRecords already written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { RUN_FOLDER_RE, newerRunMessage, parseScenario, runIdMatchesScenario } from '@demo-studio/core';
import type { LoadedProject, Scenario } from '@demo-studio/core';
import type { RenderRecord } from './types.js';
import { RenderError } from './types.js';

export interface RunRef {
  id: string;
  dir: string;
}

/** A run folder whose timeline.json is a capture (not a dry run). */
function hasCaptureTimeline(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as { mode?: string }).mode === 'capture';
  } catch {
    return false;
  }
}

/** A run id the runner makes: `<yyyymmdd>-<hhmmss>-<scenario>`. */
const DATED_RUN_ID_RE = /^\d{8}-\d{6}-/;

/**
 * `latest` order: dated run ids first, newest first (they sort chronologically), then any other folder name. A folder
 * named to sort above every date (`zz…-quote`: runs/ is writable by an agent) is never preferred to a real capture.
 */
function latestFirst(a: string, b: string): number {
  return Number(DATED_RUN_ID_RE.test(b)) - Number(DATED_RUN_ID_RE.test(a)) || (a < b ? 1 : a > b ? -1 : 0);
}

/**
 * The run to edit: a run id (folder of <project>/runs), a run directory, or `latest` (the most recent capture run —
 * dry runs and runs without a timeline are skipped —, of `scenario` when given). `latest` considers only folder names
 * that are run ids (letters, digits, ".", "_", "-"; ≤ 200 characters: the name reaches trusted summaries) and prefers
 * dated ids (latestFirst). A run whose run.json a newer Demo Studio wrote is refused (R-PRIN-13).
 */
export function findRun(project: LoadedProject, arg: string, scenario?: string): RunRef {
  const run = locateRun(project, arg, scenario);
  const newer = newerRunMessage(run.dir);
  if (newer) throw new RenderError(`run ${run.id}: ${newer}`);
  return run;
}

function locateRun(project: LoadedProject, arg: string, scenario?: string): RunRef {
  const runsDir = join(project.dir, 'runs');
  if (arg === 'latest') {
    let ids: string[] = [];
    try {
      ids = readdirSync(runsDir).filter((id) => statSync(join(runsDir, id)).isDirectory());
    } catch {
      ids = [];
    }
    const candidates = ids
      .filter((id) => RUN_FOLDER_RE.test(id) && id.length <= 200)
      .filter((id) => (scenario ? runIdMatchesScenario(id, scenario) : true))
      .filter((id) => hasCaptureTimeline(join(runsDir, id)))
      .sort(latestFirst);
    if (candidates.length === 0) {
      throw new RenderError(`no capture run${scenario ? ` of scenario "${scenario}"` : ''} in ${runsDir}: capture one with \`studio run ${project.slug} ${scenario ?? '<scenario>'}\``);
    }
    return { id: candidates[0], dir: join(runsDir, candidates[0]) };
  }
  const asId = join(runsDir, arg);
  if (existsSync(asId)) return { id: arg, dir: asId };
  if (isAbsolute(arg) || arg.startsWith('.') || /[\\/]/.test(arg)) {
    const asDir = resolve(arg);
    if (existsSync(asDir)) return { id: basename(asDir), dir: asDir };
  }
  throw new RenderError(`run "${arg}" not found in ${runsDir} (use a run id, a run directory or "latest")`);
}

/** The scenario snapshot of a run (extra context for the planner); undefined when absent or invalid. */
export async function runScenario(dir: string): Promise<Scenario | undefined> {
  try {
    return parseScenario(await readFile(join(dir, 'scenario.yaml'), 'utf8')).scenario;
  } catch {
    return undefined;
  }
}

/** The environment a run filmed (run.json `env`); undefined when absent (the planner then uses the timeline's alone). */
export async function runEnv(dir: string): Promise<string | undefined> {
  try {
    const env = (JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as { env?: unknown }).env;
    return typeof env === 'string' && env !== '' ? env : undefined;
  } catch {
    return undefined;
  }
}

/** `<project>/renders` */
export function rendersDir(project: Pick<LoadedProject, 'dir'>): string {
  return join(project.dir, 'renders');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Versions already taken (sorted, unique) by `<name>-v<N>[-vertical|-square].{mp4,json}` and pending `.<name>-v<N>.lock` files. */
export function takenVersions(dir: string, name: string): number[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^\\.?${escapeRe(name)}-v(\\d+)(?:-vertical|-square)?\\.(?:mp4|json|lock)$`);
  const versions = files.map((f) => re.exec(f)?.[1]).filter((v): v is string => v !== undefined).map(Number);
  return [...new Set(versions)].sort((a, b) => a - b);
}

/** The next free version of `name` in `dir`: 1 + the highest version on disk (renders, records and pending locks). */
export function nextVersion(dir: string, name: string): number {
  return Math.max(0, ...takenVersions(dir, name)) + 1;
}

/** The lock file that reserves version `version` of `name` in `dir` (`.<name>-v<N>.lock`). */
export function versionLockFile(dir: string, name: string, version: number): string {
  return join(dir, `.${name}-v${version}.lock`);
}

/**
 * Reserve the next free version (an exclusive `.<name>-v<N>.lock` file, so two renders of the same scenario never
 * pick the same N). `release()` removes the lock. `owner`: what the lock says holds it (default this process's pid;
 * a render job submitted through MCP: `job <id>`).
 */
export async function reserveVersion(dir: string, name: string, owner = String(process.pid)): Promise<{ version: number; release: () => Promise<void> }> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const version = nextVersion(dir, name);
    const lock = versionLockFile(dir, name, version);
    try {
      const fh = await open(lock, 'wx');
      await fh.writeFile(`${owner}\n`);
      await fh.close();
      return { version, release: () => rm(lock, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new RenderError(`could not reserve a render version of ${name} in ${dir}`);
}

/** The RenderRecords of a project (renders/*.json), oldest first. Unreadable files are skipped. */
export async function listRenders(project: Pick<LoadedProject, 'dir'> | string): Promise<RenderRecord[]> {
  const dir = typeof project === 'string' ? join(resolve(project), 'renders') : rendersDir(project);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const out: RenderRecord[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(join(dir, f), 'utf8')) as RenderRecord;
      if (r && r.version === 1 && typeof r.id === 'string' && r.plan) out.push(r);
    } catch {
      // not a render record
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
