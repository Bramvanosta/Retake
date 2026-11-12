/**
 * Runs and renders of a project on disk: the run a render works on (id, directory or `latest`), the next free render
 * version and the render records already written.
 */
import { existsSync, readdirSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { RENDER_VERSION_MAX, renderFileVersionOf, renderLockName, renderSuffix } from '@retake/core/ids';
import { projectPath, projectRef } from '@retake/core/project';
import { insideFolder, parseScenario } from '@retake/core/scenario';
import { latestTake, orderRuns, takeNeedsTimeline, takeOf, takeWords } from '@retake/core/run';
import { renderRecordsOf } from '@retake/core/render';
import { nodeFileFacts, readRendersFolder, readRunFolder, readRunRecord } from '@retake/core/io';
import type { LoadedProject, Scenario } from '@retake/core/model';
import type { LatestPick, RunRead } from '@retake/core/run';
import { withPlan } from '../render-record.js';
import type { StoredRender } from '../render-record.js';
import { RenderError } from './types.js';

export interface RunRef {
  id: string;
  dir: string;
  /**
   * Set when the run was picked as `latest` (core latestTake): the take — `take.until` when the capture was stopped by
   * `--until` — and the newer captures of the scenario it passed over, for whoever says so. Absent for a run named
   * by its id or its folder.
   */
  latest?: LatestPick;
}

/** `latest` found no capture to edit: what it passed over on the way (`pick.take` is absent). */
export class NoCaptureRunError extends RenderError {
  constructor(
    message: string,
    readonly pick: LatestPick,
  ) {
    super(message);
  }
}

/** How a run is named instead of `latest`, in the words of who asked: a terminal's option, or the argument of an MCP tool. */
const NAME_ONE = { author: 'name one with `--run <id>`', mcp: 'name one with `run_id`' } as const;

/**
 * What `latest` passed over when it found nothing, in the rule's fixed words (core takeWords) with the count of each
 * reason over every capture passed over, and how many folders had no run.json that reads as a record. No folder name:
 * the sentence may reach a trusted line.
 */
function passedWords(pick: LatestPick, trust: 'author' | 'mcp'): string {
  const total = pick.passed.length + pick.passed_more;
  const parts: string[] = [];
  if (total > 0) {
    const reasons = pick.reasons.map((r) => `${takeWords(r.why, { run: '', verb: 'render' })} (${r.count})`);
    parts.push(`${total} capture${total === 1 ? '' : 's'} of it cannot be edited: ${reasons.join(', ')}`);
  }
  if (pick.without_record > 0) {
    parts.push(`${pick.without_record} run folder${pick.without_record === 1 ? '' : 's'} without a readable run.json ${pick.without_record === 1 ? 'was' : 'were'} not considered (${NAME_ONE[trust]})`);
  }
  return parts.length ? ` — ${parts.join('; ')}` : '';
}

/**
 * The run to edit: a run id (folder of <project>/runs), a run directory, or `latest` — the newest usable capture, of
 * `scenario` when given, by the two rules every reader of runs shares (core take.ts: takeOf, orderRuns, latestTake;
 * the run folders read by core/io readRunFolder). `latest` says what it passed over (`RunRef.latest`). A run named
 * by its id or its folder is found whatever it holds; one whose run.json a newer Retake wrote is refused (R-PRIN-13).
 */
export async function findRun(project: LoadedProject, arg: string, scenario?: string): Promise<RunRef> {
  const run = await locateRun(project, arg, scenario);
  if (run.latest) return run;
  const record = await readRunRecord(join(run.dir, 'run.json'), { follow: true });
  if (!record.ok && record.problem === 'newer-format') throw new RenderError(takeWords({ why: 'newer-format', message: record.message }, { run: run.id, verb: 'render' }));
  return run;
}

/**
 * findRun without the named run's format check (planRun reads the run folder itself: plan-run.ts).
 *
 * `o.trust` — `mcp`: `latest` takes only a run whose folder really lies in the project. A run of a `runs/` that is a
 * link to elsewhere (or whose parent is) is said `outside` to the rule (core takeOf), so it is passed over and counted
 * with the others, as naming it through MCP is refused (plan-run.ts namedRunFacts). At a terminal (`author`, the
 * default) nothing of this applies.
 */
export async function locateRun(project: LoadedProject, arg: string, scenario?: string, o: { trust?: 'author' | 'mcp' } = {}): Promise<RunRef> {
  const runsDir = projectPath(project.dir, 'runs');
  if (arg === 'latest') {
    let names: string[] = [];
    try {
      names = readdirSync(runsDir);
    } catch {
      names = [];
    }
    // Each run's record first; its timeline only when the record does not already rule it out (core takeNeedsTimeline).
    const pick = await latestTake(orderRuns(names), scenario, async (id) => {
      const facts = await readRunFolder(runsDir, id, { timeline: (record) => takeNeedsTimeline(record, scenario) });
      return takeOf(facts, { outside: o.trust === 'mcp' && facts.folder === 'dir' && !insideFolder(project.dir, join(runsDir, id), nodeFileFacts) });
    });
    if (pick.take) return { id: pick.take.run, dir: join(runsDir, pick.take.run), latest: pick };
    if (pick.only_newer) {
      // The newest capture was written by a newer Retake. A terminal names it; through MCP a run that was not picked
      // is never named in a sentence (its name is a folder's: `untrusted.passed_over` has it).
      const said = takeWords({ why: 'newer-format', message: pick.only_newer.message }, { run: pick.only_newer.run, verb: 'render' });
      throw new NoCaptureRunError(o.trust === 'mcp' ? `the newest capture${scenario ? ` of scenario "${scenario}"` : ''}: ${pick.only_newer.message}` : said, pick);
    }
    throw new NoCaptureRunError(
      `no capture run${scenario ? ` of scenario "${scenario}"` : ''} in ${runsDir}: capture one with \`retake run ${project.slug} ${scenario ?? '<scenario>'}\`${passedWords(pick, o.trust ?? 'author')}`,
      pick,
    );
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

/** The environment a record names: of a record that reads, also one whose status Retake never writes; else undefined. */
export function recordEnv(record: RunRead): string | undefined {
  const env = record.ok ? record.value.env : record.problem === 'unknown-status' ? record.record.env : undefined;
  return typeof env === 'string' && env !== '' ? env : undefined;
}

/**
 * The environment a run filmed (run.json `env`, through the one reader: core/io readRunRecord); undefined when the
 * record is absent or does not read (the planner then uses the timeline's alone).
 */
export async function runEnv(dir: string): Promise<string | undefined> {
  return recordEnv(await readRunRecord(join(dir, 'run.json'), { follow: true }));
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

/**
 * The render records of a project (renders/*.json), oldest first: the complete records of their own file, read by the
 * one reader (core/io readRendersFolder: no link followed, each file within its cap) and ordered by core's order of
 * renders (renderRecordsOf). A copy, a record renamed by hand, one that lacks a member or does not read is not listed.
 */
export async function listRenders(project: Pick<LoadedProject, 'dir'> | string): Promise<StoredRender[]> {
  const dir = typeof project === 'string' ? projectPath(resolve(project), 'renders') : rendersDir(project);
  return renderRecordsOf(await readRendersFolder(dir)).map((r) => withPlan(r).value);
}
