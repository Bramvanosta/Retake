/**
 * The folder layout of a workspace and of its projects, in one place: every package joins these names through here
 * (scripts/audit/lib.mjs counts the joins of a layout name anywhere else, packages/core/test/import-rules.test.ts holds
 * the count to its baseline). A path here is a name only: nothing is read or created.
 *
 * A project folder (`projects/<slug>/`) holds what a person writes — `project.yaml`, `README.md`, `scenarios/`,
 * `hooks/`, `assets/`, `comments/` — what Retake makes from it — `runs/`, `renders/`, `review/`, `exports/` — and
 * `.retake/`, its machine-local state (hook journals, locks, recordings, sandbox state, comment stills). A workspace's
 * own `.retake/` holds the job queue, the worker's lock, the job history and the workspace journal.
 */
import { join, posix } from 'node:path';

/** The folders of a project, by what they hold. */
export const PROJECT_DIRS = {
  /** scenarios/<name>.yaml: the authored scripts. */
  scenarios: 'scenarios',
  /** hooks/: the setup and teardown files. */
  hooks: 'hooks',
  /** assets/: the project's own images and media. */
  assets: 'assets',
  /** comments/<scenario>/<id>.json: frame comment threads. */
  comments: 'comments',
  /** runs/<run id>/: one dry run or capture each. */
  runs: 'runs',
  /** renders/<scenario>-v<N>.mp4 + .json (and stills/). */
  renders: 'renders',
  /** review/<render id>/: contact sheets, key frames, report. */
  review: 'review',
  /** exports/<render id>/ and raw exports. */
  exports: 'exports',
} as const;
export type ProjectDir = keyof typeof PROJECT_DIRS;

/** The machine-local state folder of a workspace or a project (git-ignored). */
export const STATE_DIR = '.retake';

/** The folders of a state folder (`.retake/<name>`), by what they hold. */
export const STATE_DIRS = {
  /** A project's: the write locks (`write-*.lock`, `comment-*.lock`, recordings'). */
  locks: 'locks',
  /** A project's: the stills of its comment threads. */
  comments: 'comments',
  /** A project's: the hooks journals of hooks run outside a capture. */
  journals: 'journals',
  /** A project's: recordings in progress. */
  records: 'records',
  /** A project's: page inspections. */
  inspect: 'inspect',
  /** A project's: its sandboxes' state and logs. */
  sandbox: 'sandbox',
  /** A workspace's: the file job queue. */
  jobs: 'jobs',
  /** A workspace's: the worker's lock. */
  workers: 'workers',
  /** A workspace's: component and theme previews. */
  previews: 'previews',
  /** A workspace's: site extractions (brand inputs). */
  site: 'site',
  /** A workspace's: caches (the Library's previews). */
  cache: 'cache',
} as const;
export type StateDir = keyof typeof STATE_DIRS;

/** `<project>/<folder>[/<rest>…]`: a folder of a project, or a path inside it. */
export function projectPath(projectDir: string, dir: ProjectDir, ...rest: string[]): string {
  return join(projectDir, PROJECT_DIRS[dir], ...rest);
}

/** The project-relative POSIX ref of a path in a project folder (`scenarios/quote.yaml`): what storage refs hold. */
export function projectRef(dir: ProjectDir, ...rest: string[]): string {
  return posix.join(PROJECT_DIRS[dir], ...rest);
}

/**
 * `<folder>/.retake[/<sub>][/<rest>…]`: the state folder of a workspace or a project, or a path inside it (a file of
 * the state folder itself: `sub` undefined, then its name).
 */
export function statePath(folder: string, sub?: StateDir, ...rest: string[]): string {
  return sub === undefined ? join(folder, STATE_DIR, ...rest) : join(folder, STATE_DIR, STATE_DIRS[sub], ...rest);
}

/** The project-relative POSIX ref of a path in a project's state folder (`.retake/locks/x.lock`). */
export function stateRef(sub?: StateDir, ...rest: string[]): string {
  return sub === undefined ? posix.join(STATE_DIR, ...rest) : posix.join(STATE_DIR, STATE_DIRS[sub], ...rest);
}

/** scenarios/<name><ext> of a project (`.yaml` unless `.yml` is asked for). */
export function scenarioFile(projectDir: string, name: string, ext: '.yaml' | '.yml' = '.yaml'): string {
  return projectPath(projectDir, 'scenarios', `${name}${ext}`);
}

/** The project-relative POSIX ref of a scenario (`scenarios/<name>.yaml`, or `.yml`): what storage refs hold. */
export function scenarioRef(name: string, ext: '.yaml' | '.yml' = '.yaml'): string {
  return projectRef('scenarios', `${name}${ext}`);
}

/** runs/<id>[/<file>…] of a project. */
export function runPath(projectDir: string, runId: string, ...rest: string[]): string {
  return projectPath(projectDir, 'runs', runId, ...rest);
}

/** The Retake home a home folder defaults to (`<home>/.retake`): this machine's sessions and signing key. */
export function defaultRetakeHome(home: string): string {
  return join(home, STATE_DIR);
}

/** The workspace's job history: `<workspace>/.retake/history.jsonl` (what was produced: runs, renders…). */
export const HISTORY_FILE = 'history.jsonl';
/** The workspace journal: `<workspace>/.retake/journal.jsonl` (every authored write and hook run: who, what, when). */
export const WORKSPACE_JOURNAL_FILE = 'journal.jsonl';

/** Where a project keeps its sandboxes' state, lock, seed journal and service logs (git-ignored: `.retake/`). */
export const SANDBOX_STATE_DIR = join(STATE_DIR, STATE_DIRS.sandbox);

/** The files of one sandbox: `<project>/.retake/sandbox/<env>/…`. */
export interface SandboxPaths {
  dir: string;
  state: string;
  lock: string;
  seedJournal: string;
  /** The journal of `reset.hooks` (hotfix v0.2.5), started afresh at each reset. */
  resetJournal: string;
  logs: string;
}

/** The files of the sandbox of environment `env` (L7.25: from @retake/sandbox's paths.ts, which re-exports them). */
export function sandboxPaths(projectDir: string, env: string): SandboxPaths {
  const dir = join(projectDir, SANDBOX_STATE_DIR, env);
  return { dir, state: join(dir, 'state.json'), lock: join(dir, 'take.lock'), seedJournal: join(dir, 'seed-journal.json'), resetJournal: join(dir, 'reset-journal.json'), logs: join(dir, 'logs') };
}

/** A service's log file (the previous one is `<file>.1`). */
export function serviceLog(paths: SandboxPaths, service: string): string {
  return join(paths.logs, `${service}.log`);
}
/** A project's record of scenario writes: `<project>/.retake/scenario-writes.jsonl` (each write's hook surface and who made it, L7.27). */
export const PROJECT_SCENARIO_WRITES_FILE = 'scenario-writes.jsonl';
