/** The compose project a sandbox runs as: its name, folder, files and env file, and the docker binary that runs it. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { policyProgram } from '@retake/core/policy';
import { DEFAULT_COMPOSE_FILES, envFileKeys } from '@retake/core/sandbox';
import { composeEnvFile, programLookup, realpathOr } from '@retake/core/io';
import type { LoadedSandbox } from '@retake/core/sandbox';
import type { LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import { shownPath } from './paths.js';

/** The compose project of a sandbox: name, folder (real path), files (absolute), env file. */
export interface ComposeProjectRef {
  name: string;
  /**
   * The compose project's folder (`--project-directory`): the first compose file's, as docker compose itself takes it —
   * the relative paths of the compose files (a service's `env_file`, a build context, a bind mount) resolve there, and
   * the files may live in another folder than sandbox.yaml (the product's repository).
   */
  dir: string;
  /**
   * The folder of sandbox.yaml when it is another one: `--project-directory` until v0.2.0, so containers made then
   * carry it as their folder and are still the sandbox's own.
   */
  sandboxDir?: string;
  files: string[];
  /** The env file every command reads (`--env-file`: core composeEnvFile), absolute; absent: none. */
  envFile?: string;
  /** The names it sets: left out of the environment docker runs with (a shell's value would win over the file's). */
  envKeys?: string[];
  /** project.yaml `pass_env:`: passed on to docker under the agent policy besides core childEnv's base. */
  pass?: string[];
}

/**
 * `retake-<project slug>-<environment>-<8 hex of the folder's path>`, lower-case letters, digits, `-` and `_`,
 * at most 63 characters (the slug and environment are shortened, never the hash).
 */
export function composeProjectName(slug: string, env: string, dir: string): string {
  const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8);
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
  const prefix = 'retake-';
  const suffix = `-${hash}`;
  let middle = [clean(slug), clean(env)].filter(Boolean).join('-');
  const room = 63 - prefix.length - suffix.length;
  if (middle.length > room) middle = middle.slice(0, room).replace(/[-_]+$/, '');
  return `${prefix}${middle || 'sandbox'}${suffix}`;
}

/** What the state file keeps of a sandbox's compose project (`provider_state.compose`). */
export interface ComposeRecord {
  project: string;
  dir: string;
  /**
   * Names an earlier `up` used (compose.project changed since), with their folder: `up` refuses while one runs, `down`
   * takes them down too, and each is forgotten once it has neither containers nor volumes left.
   */
  previous?: Array<{ project: string; dir: string }>;
}

/** The compose record of a state (undefined when no up recorded one). */
export function composeRecord(state: { provider_state?: Record<string, unknown> }): ComposeRecord | undefined {
  const c = state.provider_state?.compose as Partial<ComposeRecord> | undefined;
  return c && typeof c.project === 'string' ? { project: c.project, dir: typeof c.dir === 'string' ? c.dir : '', ...(Array.isArray(c.previous) ? { previous: c.previous } : {}) } : undefined;
}

/** The compose project a sandbox runs as. */
export function composeProject(
  project: Pick<LoadedProject, 'slug'> & { config?: Pick<LoadedProject['config'], 'pass_env'> },
  sandbox: Pick<LoadedSandbox, 'env' | 'dir' | 'manifest'>,
): ComposeProjectRef {
  const sandboxDir = realpathOr(sandbox.dir, resolve(sandbox.dir));
  const files = (sandbox.manifest.compose?.files ?? DEFAULT_COMPOSE_FILES).map((f) => resolve(sandboxDir, f));
  const dir = realpathOr(dirname(files[0]), resolve(dirname(files[0])));
  const envFile = composeEnvFile({ dir: sandboxDir, manifest: sandbox.manifest });
  let envKeys: string[] = [];
  if (envFile) {
    try {
      envKeys = envFileKeys(readFileSync(envFile, 'utf8'));
    } catch {
      /* a missing file: docker compose says so */
    }
  }
  const pass = project.config?.pass_env;
  return {
    name: sandbox.manifest.compose?.project ?? composeProjectName(project.slug, sandbox.env, dir),
    dir,
    ...(sandboxDir !== dir ? { sandboxDir } : {}),
    files,
    ...(envFile ? { envFile, envKeys } : {}),
    ...(pass?.length ? { pass: [...pass] } : {}),
  };
}

/** Is `dir` (a container's `working_dir` label) this compose project's folder — or sandbox.yaml's, which it was until v0.2.0? */
export function ownFolder(ref: ComposeProjectRef, dir: string): boolean {
  const real = realpathOr(dir, resolve(dir));
  return real === ref.dir || (ref.sandboxDir !== undefined && real === ref.sandboxDir);
}

/** `compose --ansi never -p <name> --project-directory <dir> -f <file>… [--env-file <file>]`: the start of every compose call. */
export function composeArgs(ref: ComposeProjectRef): string[] {
  return ['compose', '--ansi', 'never', '-p', ref.name, '--project-directory', ref.dir, ...ref.files.flatMap((f) => ['-f', f]), ...(ref.envFile ? ['--env-file', ref.envFile] : [])];
}

/** A program checked by the agent policy: the file to start, and the name to start it under when they differ. */
export interface StartedProgram {
  program: string;
  problem: string | null;
  argv0?: string;
}

/**
 * core policyProgram, with the name the program was found under kept as its argv[0] when the policy gives another file
 * to start (the real path, links followed): a multi-call binary picks its role from that name — OrbStack's `docker`
 * and `docker-compose` are links to one `docker-tools`, which refuses its own name.
 */
export function startedProgram(policy: WorkPolicy, bin: string, what: string): StartedProgram {
  const checked = policyProgram(policy, bin, what, programLookup());
  const name = basename(bin.trim());
  return !checked.problem && name && basename(checked.program) !== name ? { ...checked, argv0: name } : checked;
}

/** "compose.yaml" (the project's compose files), for messages. */
export function filesText(ref: ComposeProjectRef): string {
  return ref.files.map((f) => shownPath(f)).join(', ');
}
