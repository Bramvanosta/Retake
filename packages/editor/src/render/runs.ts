/**
 * Runs and renders of a project on disk: the run a render works on (id, directory or `latest`), the next free render
 * version and the RenderRecords already written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { open, readFile, readdir, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { RENDER_VERSION_MAX, isRunId, parseScenario, projectPath, projectRef, renderFileVersionOf, renderLockName, renderSuffix, runIdOfScenario, runIdStamp } from '@retake/core';
import { newerRunMessage } from '@retake/core/io';
import type { LoadedProject, Scenario } from '@retake/core';
import { readRenderRecords } from '../render-record.js';
import type { RenderRecord } from '../render-record.js';
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

/**
 * `latest` order: dated run ids first (the stamp the runner writes, core runIdStamp), newest first (they sort
 * chronologically), then any other folder name. A folder
 * named to sort above every date (`zz…-quote`: runs/ is writable by an agent) is never preferred to a real capture.
 */
function latestFirst(a: string, b: string): number {
  return Number(runIdStamp(b) !== null) - Number(runIdStamp(a) !== null) || (a < b ? 1 : a > b ? -1 : 0);
}

/**
 * The run to edit: a run id (folder of <project>/runs), a run directory, or `latest` (the most recent capture run —
 * dry runs and runs without a timeline are skipped —, of `scenario` when given). `latest` considers only folder names
 * that are run ids (letters, digits, ".", "_", "-"; ≤ 200 characters: the name reaches trusted summaries) and prefers
 * dated ids (latestFirst). A run whose run.json a newer Retake wrote is refused (R-PRIN-13).
 */
export function findRun(project: LoadedProject, arg: string, scenario?: string): RunRef {
  const run = locateRun(project, arg, scenario);
  const newer = newerRunMessage(run.dir);
  if (newer) throw new RenderError(`run ${run.id}: ${newer}`);
  return run;
}

function locateRun(project: LoadedProject, arg: string, scenario?: string): RunRef {
  const runsDir = projectPath(project.dir, 'runs');
  if (arg === 'latest') {
    let ids: string[] = [];
    try {
      ids = readdirSync(runsDir).filter((id) => statSync(join(runsDir, id)).isDirectory());
    } catch {
      ids = [];
    }
    const candidates = ids
      .filter((id) => isRunId(id))
      .filter((id) => (scenario ? runIdOfScenario(id, scenario) : true))
      .filter((id) => hasCaptureTimeline(join(runsDir, id)))
      .sort(latestFirst);
    if (candidates.length === 0) {
      throw new RenderError(`no capture run${scenario ? ` of scenario "${scenario}"` : ''} in ${runsDir}: capture one with \`retake run ${project.slug} ${scenario ?? '<scenario>'}\``);
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
  return projectPath(project.dir, 'renders');
}

/** The files of `dir` that take a version of `name` (core renderFileVersionOf), in name order. */
function versionFiles(dir: string, name: string): Array<{ file: string; version: number }> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const taken: Array<{ file: string; version: number }> = [];
  const versionOf = renderFileVersionOf(name);
  for (const file of files.sort()) {
    const version = versionOf(file);
    if (version !== null) taken.push({ file, version });
  }
  return taken;
}

/** Versions already taken (sorted, unique) by `<name>-v<N>[-vertical|-square].{mp4,json}` and pending `.<name>-v<N>.lock` files. */
export function takenVersions(dir: string, name: string): number[] {
  return [...new Set(versionFiles(dir, name).map((t) => t.version))].sort((a, b) => a - b);
}

/**
 * The next free version of `name` in `dir`: 1 + the highest version on disk (renders, records and pending locks), at
 * most RENDER_VERSION_MAX. When a file already claims that version or more — whatever number its digits read as —
 * nothing is handed out: the refusal names the file, so that two renders never get the same id.
 */
export function nextVersion(dir: string, name: string): number {
  let top: { file: string; version: number } | undefined;
  for (const t of versionFiles(dir, name)) if (!top || t.version > top.version) top = t;
  if (!top) return 1;
  if (!(top.version < RENDER_VERSION_MAX)) {
    const written = renderSuffix(top.file.slice(0, top.file.lastIndexOf('.')))?.digits ?? String(top.version);
    throw new RenderError(
      `${projectRef('renders')}/ holds ${top.file}, which claims version ${written} of ${name}: the highest version is ${RENDER_VERSION_MAX}. Remove or rename that file, then render again.`,
    );
  }
  return top.version + 1;
}

/**
 * The lock file that reserves version `version` of `name` in `dir` (`.<name>-v<N>.lock`); a RangeError for a version
 * that is not a whole number from 0 to RENDER_VERSION_MAX (core renderLockName).
 */
export function versionLockFile(dir: string, name: string, version: number): string {
  return join(dir, renderLockName(name, version));
}

/**
 * Reserve the next free version (an exclusive `.<name>-v<N>.lock` file, so two renders of the same scenario never
 * pick the same N). `release()` removes the lock. `owner`: what the lock says holds it (default this process's pid;
 * a render job submitted through MCP: `job <id>`). Refused as nextVersion refuses (no lock is written).
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
  const dir = typeof project === 'string' ? projectPath(resolve(project), 'renders') : rendersDir(project);
  return readRenderRecords(dir, { list: (d) => readdir(d), read: (f) => readFile(f, 'utf8') });
}
